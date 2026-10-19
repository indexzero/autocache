/**
 * `remaster verify` — does the remastered tier STAND ALONE? (#365)
 *
 * The remaster family's validator, homed into the crawl package because its
 * dynamic tier drives the SAME strict-serving browser probe the crawler uses
 * (probe.js — reused verbatim, never re-implemented). Two tiers, read-only
 * throughout (verify never mutates a tree, a bucket, or the corpus — it reads
 * bytes and, for the dynamic tier, renders them):
 *
 *   STATIC  — walk every text-bearing body in a remastered tree and scan for
 *             `web.archive.org` / `archive.org` / absolute `http(s)://…/web/<ts>`
 *             escapes. ZERO allowlist: every upstream URL is reported, deduped,
 *             and classified. A rewriter miss, a fetchable gap, or a bare
 *             archive.org reference fails. An out-of-scope page link is advisory
 *             and a beacon is excluded (root-relative `/web/<ts>/…` refs are the
 *             CORRECT remastered form and are never findings).
 *             Plus the determinism check: every remastered body must hash to
 *             its build-record outputHash (a tampered served body is caught
 *             here), and — given the hermetic source — a fresh rebuild must
 *             reproduce the committed build record byte-for-byte (a stale
 *             build is caught here).
 *
 *   DYNAMIC — boot a STRICT-mode server over the remastered root (serveCacheRoot,
 *             ephemeral port) and render documents through the shared probe with
 *             non-local origins abort-routed so nothing actually escapes. A
 *             document passes iff it attempted zero non-local requests, raised
 *             zero CSP violations, and every local URL it requested resolves to
 *             a capture in the corpus (observed ⊆ corpus). The tier requires a
 *             browser: it is detected and skips cleanly when agent-browser is
 *             absent.
 *
 * Conventions match the family: report-only, exit 0 (pass) / 1 (findings) / 2
 * (usage) is the caller's job, `--json` is the machine form, the tool NEVER
 * writes a file unless given `--out`. The library is importable (the bin thin);
 * the request-classification core lives in probe.js (unit-tested there without
 * a browser).
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveCacheRoot } from '@autocache/waybackify-serve/node';
import { bodyPath } from '@autocache/waybackify/key.js';
import { BUILD_NAME, remaster } from '@autocache/waybackify/remaster.js';
import { isUnmirrorable } from '@autocache/waybackify/beacons.js';
import { dynamicEntryError, isSidecarObject, SIDECAR_VERSION } from '@autocache/waybackify/cache.js';
import { classifyContentType, refCaptureKey, waybackRefRe } from '@autocache/waybackify/rewrite.js';
import { Tokenizer, TokenizerMode } from 'parse5';
import { createBrowserProbe, isBrowserAvailable } from './probe.js';

// The library never constructs pino (design §1); default no-op.
const NOOP_LOGGER = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

/* ------------------------------------------------------------------------ *
 * Report shape (the family's LayerReport/Finding vocabulary)
 * ------------------------------------------------------------------------ */

/**
 * @typedef {'static' | 'dynamic'} Tier
 *
 * @typedef {Object} Finding
 * @property {Tier} tier
 * @property {string} layer   - which check surfaced it: `escape` | `build` | `browser`
 * @property {string} key     - the capture key (or a document key) at fault
 * @property {string} kind    - the defect class, e.g. `archive-org`, `body-hash`, `non-local-request`
 * @property {string} detail  - human one-liner
 * @property {number} [offset] - byte offset of an escape within the body
 * @property {string} [excerpt] - a sanitized window around an escape
 * @property {string} [expected]
 * @property {string} [actual]
 * @property {string} [url]   - the offending request URL, or the upstream ref of an escape
 * @property {string|null} [upstreamKey] - escape: the `<ts>/<original>` key the upstream ref resolves to
 * @property {string} [original] - escape: the trimmed `<original>` token of the upstream ref
 * @property {string|null} [flag] - escape: the replay flag of the upstream ref, e.g. `im_`
 * @property {boolean} [resource] - escape: the ref sits where a browser loads a resource (CSS url(), src, srcset, poster, a stylesheet or icon link)
 * @property {string} [class] - escape: the upstream class (see UPSTREAM_CLASSES)
 * @property {number} [docs]  - escape: how many documents carry this distinct upstream URL
 *
 * @typedef {Object} LayerReport
 * @property {Tier} tier
 * @property {string} layer
 * @property {string} name
 * @property {boolean} pass
 * @property {number} checked
 * @property {Finding[]} findings
 * @property {string} [skipped]
 * @property {Record<string, number>} [counts]
 * @property {DynamicDocResult[]} [documents]
 * @property {UpstreamResidual} [residual] - escape layer: the distinct upstream URLs, by class
 *
 * @typedef {Object} UpstreamResidual
 * @property {number} occurrences - every upstream-ref occurrence the scan saw
 * @property {number} distinct    - the distinct upstream keys (or bare URLs)
 * @property {Record<string, {status: 'fail'|'advisory'|'excluded', label: string, next: string, count: number, entries: Array<{key: string|null, url: string, docs: number}>}>} classes
 *
 * @typedef {Object} DynamicDocResult
 * @property {string} key
 * @property {string} url
 * @property {boolean} pass
 * @property {Array<{url: string, origin: 'local'|'non-local', corpus: 'hit'|'miss'|'n/a', resourceType?: string}>} requests
 * @property {Finding[]} findings
 *
 * @typedef {Object} RemasterVerifyReport
 * @property {'remaster-verify'} tool
 * @property {string} root
 * @property {string} [hermetic]
 * @property {boolean} pass
 * @property {LayerReport[]} layers
 *
 * @typedef {Object} RemasterVerifyOptions
 * @property {string} root
 * @property {string} [hermetic]
 * @property {Tier[]} [tiers]
 * @property {boolean} [skipDeterminism]
 * @property {number} [sample]
 * @property {(line: string) => void} [onProgress]
 * @property {string} [browserCmd]
 * @property {Function} [createProbe] - probe factory seam (tests inject a fake; default createBrowserProbe)
 */

/* ------------------------------------------------------------------------ *
 * Remastered-tree enumeration — the sidecar IS the entry (parity stance)
 * ------------------------------------------------------------------------ */

async function readdirOrEmpty(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Walk `<root>/meta/<aa>/*.json` in a stable order. The reader takes the
 * current sidecar shape only (`v: 3`). An older or unknown version is an
 * error, never a silent read: a verify over a stale tree must say so.
 */
export async function enumerateRemastered(root) {
  const metaDir = path.join(root, 'meta');
  const out = [];
  for (const aa of (await readdirOrEmpty(metaDir)).sort()) {
    for (const file of (await readdirOrEmpty(path.join(metaDir, aa))).sort()) {
      if (!file.endsWith('.json')) continue;
      const metaPath = path.join(metaDir, aa, file);
      const sidecar = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (!isSidecarObject(sidecar)) {
        throw new Error(`remaster verify: malformed sidecar at ${metaPath} (not a JSON object)`);
      }
      if (sidecar.v !== SIDECAR_VERSION) {
        throw new Error(`remaster verify: unsupported sidecar version ${sidecar.v} at ${metaPath} (sidecar v${SIDECAR_VERSION} only)`);
      }
      const hash = file.slice(0, -'.json'.length);
      out.push({
        key: sidecar.key,
        aa,
        hash,
        status: sidecar.status,
        requisites: Array.isArray(sidecar.requisites) ? sidecar.requisites : [],
        dynamic: Array.isArray(sidecar.dynamic) ? sidecar.dynamic : [],
        contentType: sidecar.contentType,
        contentHash: sidecar.contentHash,
        contentLength: sidecar.contentLength,
        capPath: bodyFileOf(root, sidecar),
        metaPath
      });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The content-addressed body file a sidecar names (cap/<dd>/<digest> from its
 * contentHash), or null when the sidecar names no usable digest.
 */
function bodyFileOf(root, sidecar) {
  if (sidecar.status !== 'body') return null;
  try {
    return path.join(root, bodyPath(sidecar.contentHash));
  } catch {
    return null;
  }
}

/** A remastered body's bytes, or null when the tree lacks them. */
async function readBody(entry) {
  if (entry.capPath === null) return null;
  try {
    return await fsp.readFile(entry.capPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** SRI `sha256-<base64>` over bytes — the form the sidecar + build record use. */
function sri(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

/* ------------------------------------------------------------------------ *
 * STATIC · escape scan
 * ------------------------------------------------------------------------ */

// Any occurrence of the archive.org host family — `web.archive.org`,
// `web-static.archive.org`, or bare `archive.org`. A hit that no wayback ref
// owns is the residual `archive-org-bare` class.
const ARCHIVE_ORG_RE = /archive\.org/gi;

// An ABSOLUTE wayback-shaped URL to a NON-archive host: `http(s)://host/web/<ts>`.
// The archive-host family is already covered above, so this catches a wayback
// path escaping through some other host. Root-relative `/web/<ts>/…` (no scheme
// + host) is the CORRECT remastered form and never matches here.
const ABSOLUTE_WEB_PATH_RE = /https?:\/\/[^\s"'<>)]+\/web\/\d{4,14}/gi;

/**
 * Is this content-type a text body a browser would parse for references? The
 * remaster engine only rewrites html/css/js, so those are the primary surface;
 * other text types (json/xml/svg) pass through hermetic-verbatim and can still
 * carry an escaping reference, so they are scanned too. Binary types (images,
 * fonts, octet-stream) are NOT scanned — a random byte run spelling
 * "archive.org" inside a PNG is a false positive, and capture bytes carry
 * nothing of ours.
 */
export function isTextBearing(contentType) {
  if (classifyContentType(contentType)) return true;
  const type = (contentType || '').split(';', 1)[0].trim().toLowerCase();
  return /^text\//.test(type) || type === 'application/json' || /\+xml$/.test(type) || type === 'application/xml';
}

/** A sanitized ±40-char window around `[start,end)` for a finding excerpt. */
function excerptAround(text, start, end) {
  const from = Math.max(0, start - 40);
  const to = Math.min(text.length, end + 40);
  const window = text.slice(from, to);
  // Collapse anything non-printable so the excerpt is a safe single line.
  return (from > 0 ? '…' : '') + window.replace(/[^\x20-\x7e]/g, '·') + (to < text.length ? '…' : '');
}

// The bytes of a bare reference token around a residual archive.org hit.
const TOKEN_LEFT_STOP = /[\s"'<>()\\=]/;
const TOKEN_RIGHT_STOP = /[\s"'<>)\\]/;

/** The URL-ish token that contains `[start,end)`, capped at 300 chars a side. */
function tokenAround(text, start, end) {
  let from = start;
  while (from > 0 && start - from < 300 && !TOKEN_LEFT_STOP.test(text[from - 1])) from--;
  let to = end;
  while (to < text.length && to - end < 300 && !TOKEN_RIGHT_STOP.test(text[to])) to++;
  return text.slice(from, to);
}

/* ------------------------------------------------------------------------ *
 * HTML positions — read from the parse5 tokenizer, never from a hand scan
 * ------------------------------------------------------------------------ */

// How the tokenizer reads an element's content once its start tag is seen.
// The tree builder normally makes this switch, so the handler below makes it.
//   SCRIPT_DATA, RAWTEXT, PLAINTEXT  no tags and no character references:
//                                    a ref inside keeps its entity text
//   RCDATA                           no tags, and character references decode
// Every table keyed by a tag or attribute name is a Map or a Set, so a tag
// named `constructor` or `__proto__` finds nothing instead of an inherited
// property.
const CONTENT_MODES = new Map([
  ['script', TokenizerMode.SCRIPT_DATA],
  ['style', TokenizerMode.RAWTEXT],
  ['xmp', TokenizerMode.RAWTEXT],
  ['iframe', TokenizerMode.RAWTEXT],
  ['noembed', TokenizerMode.RAWTEXT],
  ['noframes', TokenizerMode.RAWTEXT],
  ['noscript', TokenizerMode.RAWTEXT],
  ['plaintext', TokenizerMode.PLAINTEXT],
  ['title', TokenizerMode.RCDATA],
  ['textarea', TokenizerMode.RCDATA]
]);

// Foreign content. Inside <svg> or <math> the tree builder switches no content
// state: a <script>, <style>, or <title> there is ordinary markup, and
// character references decode. An HTML integration point inside returns to
// the HTML rules, and so does an HTML start tag that breaks out of foreign
// content (the tree builder pops the foreign elements first).
const FOREIGN_ROOTS = new Set(['svg', 'math']);
const SVG_INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title']);
const MATHML_TEXT_INTEGRATION_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const ANNOTATION_HTML_ENCODINGS = new Set(['text/html', 'application/xhtml+xml']);
const FOREIGN_BREAKOUT_TAGS = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr',
  'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var'
]);
const FONT_BREAKOUT_ATTRS = new Set(['color', 'face', 'size']); // <font> breaks out only with one of these

/** Inside foreign content of `namespace`, does this start tag open an HTML integration point? */
function isIntegrationPoint(namespace, tagName, attrs) {
  if (namespace === 'svg') return SVG_INTEGRATION_POINTS.has(tagName);
  if (MATHML_TEXT_INTEGRATION_POINTS.has(tagName)) return true;
  if (tagName !== 'annotation-xml') return false;
  const encoding = attrs.find(a => a.name === 'encoding')?.value.trim().toLowerCase() ?? '';
  return ANNOTATION_HTML_ENCODINGS.has(encoding);
}

// The navigational positions: the only markup positions where a URL names a
// page the reader follows. Every other attribute value loads a resource,
// whatever the URL's extension: src, srcset, poster, SVG href and xlink:href,
// object data, embed and track src, an input image, and so on.
const NAV_ATTRS = new Map([
  ['a', new Set(['href'])],
  ['area', new Set(['href'])],
  ['form', new Set(['action'])],
  ['button', new Set(['formaction'])],
  ['input', new Set(['formaction'])]
]);
// A <link> is navigational only when every token of its rel is one of these.
// Any resource token in the list, or a stylesheet type, makes it a resource:
// `rel="canonical preload"` still preloads, and `rel="alternate icon"` is an
// icon.
const LINK_NAV_RELS = new Set(['next', 'prev', 'canonical', 'alternate']);
const LINK_RESOURCE_RELS = new Set([
  'stylesheet', 'icon', 'preload', 'modulepreload', 'prefetch', 'manifest',
  'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon'
]);

/**
 * Does a URL in attribute `name` of `tagName` load a resource? Only a
 * navigational position names a page the reader follows. Every other
 * attribute loads whatever it names, so the URL's extension does not decide.
 *
 * @param {string} tagName - lower-case, from the tokenizer
 * @param {string} name - the exact attribute name, lower-case, from the tokenizer
 * @param {Array<{name: string, value: string}>} attrs - the tag's attributes
 */
function isResourceAttr(tagName, name, attrs) {
  if (NAV_ATTRS.get(tagName)?.has(name)) return false;
  if (tagName !== 'link' || name !== 'href') return true;
  const valueOf = n => attrs.find(a => a.name === n)?.value ?? '';
  const rels = valueOf('rel').toLowerCase().split(/\s+/).filter(Boolean);
  if (rels.length === 0 || /^text\/css\b/i.test(valueOf('type').trim())) return true;
  if (rels.some(rel => LINK_RESOURCE_RELS.has(rel))) return true;
  return !rels.every(rel => LINK_NAV_RELS.has(rel));
}

/**
 * @typedef {Object} HtmlRegion
 * @property {number} start
 * @property {number} end
 * @property {boolean} raw      - character references do not decode here
 * @property {boolean} resource - a URL here loads a resource
 * @property {string} kind      - the element or `tag attr`, for a reader
 */

/**
 * The regions of an HTML body where a ref reads differently from markup
 * text: raw text (script data, RAWTEXT, PLAINTEXT, comments), a foreign
 * <style> block (decoded CSS), and attribute values. In byte order, without
 * overlap. Text outside every region is markup text: character references
 * decode, and no position loads a URL. The tokenizer supplies tag names,
 * exact attribute names and spans (quoted, single-quoted, or unquoted),
 * comments, and the content states. A stack of the open foreign elements
 * and integration points decides whether a start tag switches a content
 * state at all. <noscript> content is tokenized again as markup, since a
 * client without scripting parses it and the mirror serves that reader too.
 *
 * @param {string} html
 * @param {number} [base] - the offset of `html` within the outer body
 * @returns {HtmlRegion[]}
 */
function htmlRegions(html, base = 0) {
  const regions = [];
  // The open block whose end tag the tokenizer has not seen yet: a raw block,
  // a <noscript> block, or a foreign <style> block (`decoded`).
  let open = null;
  const closeOpen = end => {
    if (open === null) return;
    if (open.tagName === 'noscript') regions.push(...htmlRegions(html.slice(open.start, end), base + open.start));
    else regions.push({ start: base + open.start, end: base + end, raw: !open.decoded, resource: open.tagName === 'style', kind: open.decoded ? 'foreign style' : open.tagName });
    open = null;
  };
  // The open foreign elements and the integration points inside them. Empty
  // means HTML content. Only the top frame's `foreign` flag matters.
  const frames = [];
  const inForeign = () => frames.length > 0 && frames[frames.length - 1].foreign;
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onStartTag({ tagName, attrs, location, selfClosing }) {
        if (open === null) {
          for (const attr of attrs) {
            // The tokenizer keys attribute locations on a plain object, so an
            // own-property check keeps an attribute named `constructor` honest.
            if (!location.attrs || !Object.hasOwn(location.attrs, attr.name)) continue;
            const loc = location.attrs[attr.name];
            regions.push({ start: base + loc.startOffset, end: base + loc.endOffset, raw: false, resource: isResourceAttr(tagName, attr.name, attrs), kind: `${tagName} ${attr.name}` });
          }
        }
        if (inForeign()) {
          const breakout = FOREIGN_BREAKOUT_TAGS.has(tagName) || (tagName === 'font' && attrs.some(a => FONT_BREAKOUT_ATTRS.has(a.name)));
          if (!breakout) {
            const { namespace } = frames[frames.length - 1];
            if (!selfClosing) frames.push({ tagName, namespace, foreign: !isIntegrationPoint(namespace, tagName, attrs) });
            if (tagName === 'style' && !selfClosing && open === null) open = { tagName, start: location.endOffset, decoded: true }; // CSS, with character references decoded
            return; // no content state switches in foreign content
          }
          while (inForeign()) frames.pop(); // the tree builder pops back to HTML content
        }
        if (FOREIGN_ROOTS.has(tagName)) {
          if (!selfClosing) frames.push({ tagName, namespace: tagName, foreign: true });
          return;
        }
        const mode = CONTENT_MODES.get(tagName);
        if (mode === undefined) return;
        tokenizer.state = mode;
        if (mode === TokenizerMode.RCDATA) return; // decodes like markup, and the tokenizer finds its end tag
        open = { tagName, start: location.endOffset };
      },
      onEndTag({ tagName, location }) {
        if (open !== null && tagName === open.tagName) closeOpen(location.startOffset);
        const at = frames.findLastIndex(f => f.tagName === tagName);
        if (at !== -1) frames.length = at;
      },
      onComment({ location }) {
        if (open === null) regions.push({ start: base + location.startOffset, end: base + location.endOffset, raw: true, resource: false, kind: '#comment' });
      },
      onEof({ location }) {
        closeOpen(location?.startOffset ?? html.length); // an unclosed block, or <plaintext>, runs to the end
      },
      onDoctype() {},
      onCharacter() {},
      onNullCharacter() {},
      onWhitespaceCharacter() {}
    }
  );
  tokenizer.write(html, true);
  return regions.sort((a, b) => a.start - b.start);
}

/**
 * A capture key without its #fragment. A request never carries the fragment,
 * so the upstream, store, and frontier keys all compare in this form.
 */
function stripFragment(key) {
  return key.replace(/#[\s\S]*$/, '');
}

/**
 * Scan one text body for escapes. Pure: (key, text) → one finding per
 * occurrence. A hosted wayback ref (absolute or protocol-relative, the
 * rewriter's own waybackRefRe()) is `archive-org` and carries the upstream `url`
 * and the `upstreamKey` the server resolves. An archive.org byte run outside every
 * such ref is `archive-org-bare`. The absolute-web-path scan skips any match
 * whose host is in the archive family. Root-relative refs are never findings.
 *
 * @param {string} key
 * @param {string} text
 * @param {{ html?: boolean, css?: boolean }} [options] - the body kind. In HTML
 *   the tokenizer's regions decide: a ref in raw text keeps its entity text
 *   in `upstreamKey`, a ref in an attribute value decodes, and only a
 *   navigational attribute is a page position. In CSS every ref is a
 *   resource load.
 */
export function scanBody(key, text, { html = false, css = false } = {}) {
  const findings = [];
  const owned = [];
  const regions = html ? htmlRegions(text) : [];
  let at = 0; // matches and regions both come in byte order, so one pointer walks the regions
  for (const m of text.matchAll(waybackRefRe())) {
    const [full, host, ts, flag, rawOriginal] = m;
    if (!host) continue; // root-relative: the correct remastered form
    while (at < regions.length && regions[at].end <= m.index) at++;
    const region = at < regions.length && regions[at].start <= m.index ? regions[at] : null;
    const decodeEntities = html && !(region?.raw ?? false);
    const ref = refCaptureKey(ts, rawOriginal, { decodeEntities });
    const url = full.slice(0, full.length - rawOriginal.length + ref.trimmed.length);
    const offset = m.index + host.indexOf('archive.org');
    owned.push([m.index, m.index + url.length]);
    findings.push({
      tier: 'static',
      layer: 'escape',
      key,
      kind: 'archive-org',
      detail: `archive.org reference to ${url}`,
      url,
      original: ref.trimmed,
      // A request never carries its #fragment, so the key the server resolves
      // has none. The reported url keeps it.
      upstreamKey: ref.key === null ? null : stripFragment(ref.key),
      flag: flag ?? null,
      resource: css || (region?.resource ?? false),
      offset,
      excerpt: excerptAround(text, offset, offset + 'archive.org'.length)
    });
  }
  let span = 0;
  for (const m of text.matchAll(ARCHIVE_ORG_RE)) {
    while (span < owned.length && owned[span][1] <= m.index) span++;
    if (span < owned.length && owned[span][0] <= m.index) continue; // owned by a wayback ref above
    findings.push({
      tier: 'static',
      layer: 'escape',
      key,
      kind: 'archive-org-bare',
      detail: `archive.org reference at byte ${m.index}`,
      url: tokenAround(text, m.index, m.index + m[0].length),
      offset: m.index,
      excerpt: excerptAround(text, m.index, m.index + m[0].length)
    });
  }
  findings.sort((a, b) => a.offset - b.offset);
  for (const m of text.matchAll(ABSOLUTE_WEB_PATH_RE)) {
    if (/archive\.org/i.test(m[0])) continue; // owned by the archive-host scan above
    findings.push({
      tier: 'static',
      layer: 'escape',
      key,
      kind: 'absolute-web-escape',
      detail: `absolute wayback-shaped URL at byte ${m.index}`,
      offset: m.index,
      excerpt: excerptAround(text, m.index, m.index + m[0].length)
    });
  }
  return findings;
}

/**
 * The upstream classes, in report order. A distinct upstream key lands in the first
 * class whose test holds: in the store, unmirrorable, in the recorded frontier,
 * then novel (resource or page). A ref with no key is unmirrorable if
 * isUnmirrorable exempts its original, and unresolved if not. `status` splits the verdict:
 *   fail      the tree does not stand alone, and `next` names the fix
 *   advisory  reported, but a link out of mirror scope does not fail the layer
 *   excluded  never mirrorable (the same set fsck and crawl exclude)
 */
const UPSTREAM_CLASSES = {
  inStore: { status: 'fail', label: 'rewriter miss (capture in store, ref left absolute)', next: 'fix the remaster build rewrite rule' },
  inRecordedFrontier: { status: 'fail', label: 'fetchable gap (in the recorded frontier)', next: 'cache crawl --static-only or cache fill' },
  novelResource: { status: 'fail', label: 'fetchable gap (novel resource)', next: 'a full (dynamic) cache crawl' },
  bare: { status: 'fail', label: 'bare archive.org reference (not /web/-shaped)', next: 'inspect the body' },
  unresolved: { status: 'fail', label: 'archive.org reference with no resolvable original', next: 'inspect the body' },
  novelPage: { status: 'advisory', label: 'out of scope (novel page link)', next: 'none: the page is outside the mirror' },
  unmirrorable: { status: 'excluded', label: 'unmirrorable (beacon or pseudo URL)', next: 'none' }
};

// A subresource replay flag, or a file extension a page loads as a resource.
// Either marks a novel ref as a resource when its context did not (JS text).
const RESOURCE_FLAGS = new Set(['im_', 'js_', 'cs_', 'oe_']);
const RESOURCE_EXT_RE = /\.(?:m?js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|bmp|mp4|webm|ogg|mp3|wav|m4a|flv|swf|json)$/i;

/** Does an upstream original URL have a resource file extension? */
function hasResourceExtension(original) {
  let pathname;
  try {
    pathname = new URL(original).pathname;
  } catch {
    return false;
  }
  return RESOURCE_EXT_RE.test(pathname);
}

/** The union recorded frontier: every sidecar's requisites ∪ well-formed dynamic keys, without fragments. */
function recordedFrontier(entries) {
  const frontier = new Set();
  for (const entry of entries) {
    for (const childKey of entry.requisites ?? []) frontier.add(stripFragment(childKey));
    for (const d of entry.dynamic ?? []) if (!dynamicEntryError(d)) frontier.add(stripFragment(d.key));
  }
  return frontier;
}

/** The class of one distinct upstream URL. */
function classOf(upstream, store, frontier) {
  if (upstream.kind === 'archive-org-bare') return 'bare';
  // No key: the original is not a URL with a host. It is still a live
  // archive.org request unless the shared predicate exempts it.
  if (upstream.upstreamKey === null) return isUnmirrorable(upstream.original) ? 'unmirrorable' : 'unresolved';
  if (store.has(upstream.upstreamKey)) return 'inStore';
  const original = upstream.upstreamKey.slice(upstream.upstreamKey.indexOf('/') + 1);
  if (isUnmirrorable(original)) return 'unmirrorable';
  if (frontier.has(upstream.upstreamKey)) return 'inRecordedFrontier';
  return upstream.resource || hasResourceExtension(original) ? 'novelResource' : 'novelPage';
}

/**
 * Dedupe upstream occurrences into distinct upstream URLs, classify each, and return the
 * residual summary plus one finding per distinct FAILING upstream URL.
 *
 * @param {Finding[]} occurrences - `archive-org` and `archive-org-bare` findings
 * @param {Set<string>} store - every capture key in the remastered tree
 * @param {Set<string>} frontier - the union recorded frontier
 * @returns {{ residual: UpstreamResidual, findings: Finding[] }}
 */
export function classifyUpstream(occurrences, store, frontier) {
  const distinct = new Map();
  for (const f of occurrences) {
    const id = f.kind === 'archive-org-bare' ? `bare:${f.url}` : f.upstreamKey === null ? `url:${f.url}` : f.upstreamKey;
    let upstream = distinct.get(id);
    if (!upstream) {
      upstream = { first: f, kind: f.kind, upstreamKey: f.upstreamKey ?? null, original: f.original ?? null, url: f.url, docs: new Set(), resource: false };
      distinct.set(id, upstream);
    }
    upstream.docs.add(f.key);
    if (RESOURCE_FLAGS.has(f.flag) || f.resource) upstream.resource = true;
  }
  const classes = Object.fromEntries(Object.entries(UPSTREAM_CLASSES).map(([id, c]) => [id, { ...c, count: 0, entries: [] }]));
  const findings = [];
  for (const upstream of distinct.values()) {
    const id = classOf(upstream, store, frontier);
    const cls = classes[id];
    cls.entries.push({ key: upstream.upstreamKey, url: upstream.url, docs: upstream.docs.size });
    if (cls.status === 'fail') findings.push({ ...upstream.first, class: id, docs: upstream.docs.size, detail: `${cls.label}: ${upstream.url}` });
  }
  const order = e => e.key ?? e.url;
  for (const cls of Object.values(classes)) {
    cls.entries.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    cls.count = cls.entries.length;
  }
  return { residual: { occurrences: occurrences.length, distinct: distinct.size, classes }, findings };
}

/** Scan every text-bearing body in a remastered tree, then classify the upstream URLs. */
export async function scanEscapes(entries, { logger = NOOP_LOGGER, progressEvery = 0 } = {}) {
  const findings = [];
  const occurrences = [];
  let scanned = 0;
  for (const entry of entries) {
    if (entry.status !== 'body' || !isTextBearing(entry.contentType)) continue;
    const bytes = await readBody(entry);
    if (bytes === null) {
      findings.push({ tier: 'static', layer: 'escape', key: entry.key, kind: 'body-missing', detail: `no cap/ body for a status:body sidecar` });
      continue;
    }
    scanned++;
    // Silent-loop progress (design §6): the per-body scan had no hook.
    if (progressEvery && scanned % progressEvery === 0) {
      logger.info({ evt: 'verify-scan-progress', done: scanned }, `remaster verify: ${scanned} bodies scanned`);
    }
    // latin1 is a lossless byte↔char map, so byte offset === string index.
    const kind = classifyContentType(entry.contentType);
    for (const f of scanBody(entry.key, bytes.toString('latin1'), { html: kind === 'html', css: kind === 'css' })) {
      (f.kind === 'archive-org' || f.kind === 'archive-org-bare' ? occurrences : findings).push(f);
    }
  }
  const store = new Set(entries.map(e => stripFragment(e.key)));
  const { residual, findings: upstreamFindings } = classifyUpstream(occurrences, store, recordedFrontier(entries));
  findings.unshift(...upstreamFindings);
  const classCounts = Object.fromEntries(Object.entries(residual.classes).map(([id, c]) => [id, c.count]));
  return {
    tier: 'static',
    layer: 'escape',
    name: 'archive-escape scan (upstream URLs classified)',
    pass: findings.length === 0,
    checked: scanned,
    findings,
    counts: { scanned, occurrences: residual.occurrences, distinct: residual.distinct, ...classCounts },
    residual
  };
}

/* ------------------------------------------------------------------------ *
 * STATIC · determinism (build-record integrity + rebuild reproducibility)
 * ------------------------------------------------------------------------ */

/** Canonical JSON — byte-identical to what remaster.js / cache.js write. */
function canonicalJSON(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

async function readBuild(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, BUILD_NAME), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The determinism check. Two parts, both zero-tolerance:
 *   INTEGRITY     every remastered body hashes to its build-record outputHash
 *                 and its sidecar contentHash (a tampered served body is caught).
 *   REPRODUCIBLE  (given `hermetic`) a fresh rebuild reproduces the committed
 *                 build record byte-for-byte (a stale / drifted build is caught).
 *
 * @param {string} root
 * @param {Awaited<ReturnType<typeof enumerateRemastered>>} entries
 * @param {{ hermetic?: string, skipReproduce?: boolean, onProgress?: (line: string) => void }} [options]
 */
export async function checkDeterminism(root, entries, options = {}) {
  const findings = [];
  const build = await readBuild(root);
  if (build === null) {
    return {
      tier: 'static',
      layer: 'build',
      name: 'determinism (build-record integrity + rebuild)',
      pass: false,
      checked: 0,
      findings: [{ tier: 'static', layer: 'build', key: BUILD_NAME, kind: 'build-missing', detail: `no ${BUILD_NAME} at the remastered root` }]
    };
  }

  const byKey = new Map(build.entries.map(e => [e.key, e]));

  // INTEGRITY — every remastered body vs its build-record + sidecar hash.
  let verified = 0;
  for (const entry of entries) {
    if (entry.status !== 'body') continue;
    const row = byKey.get(entry.key);
    if (!row) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'build-orphan', detail: 'body present but absent from the build record' });
      continue;
    }
    const bytes = await readBody(entry);
    if (bytes === null) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'body-missing', detail: 'build record lists a body the tree lacks' });
      continue;
    }
    const got = sri(bytes);
    verified++;
    if (row.outputHash !== got) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'body-hash', detail: 'body bytes diverge from the build record', expected: row.outputHash ?? '(none)', actual: got });
    }
    if (entry.contentHash !== got) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'sidecar-hash', detail: 'sidecar contentHash diverges from the body', expected: entry.contentHash ?? '(none)', actual: got });
    }
  }

  // REPRODUCIBLE — rebuild from the hermetic source and compare build records.
  let reproduced = false;
  if (options.hermetic && !options.skipReproduce) {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'remaster-verify-rebuild-'));
    try {
      options.onProgress?.(`determinism: rebuilding from ${options.hermetic}`);
      const { build: rebuilt } = await remaster(options.hermetic, tmp);
      reproduced = true;
      if (rebuilt.engineVersion !== build.engineVersion) findings.push(driftFinding('engineVersion', String(build.engineVersion), String(rebuilt.engineVersion)));
      if (rebuilt.ruleVersion !== build.ruleVersion) findings.push(driftFinding('ruleVersion', String(build.ruleVersion), String(rebuilt.ruleVersion)));
      if (rebuilt.v !== build.v) findings.push(driftFinding('buildVersion', String(build.v), String(rebuilt.v)));
      const rebuiltByKey = new Map(rebuilt.entries.map(e => [e.key, e]));
      for (const [key, row] of byKey) {
        const other = rebuiltByKey.get(key);
        if (!other) {
          findings.push({ tier: 'static', layer: 'build', key, kind: 'rebuild-drift', detail: 'entry present in the committed build record, absent from a fresh rebuild', expected: 'present', actual: 'absent' });
          continue;
        }
        if (canonicalJSON(row) !== canonicalJSON(other)) {
          findings.push({ tier: 'static', layer: 'build', key, kind: 'rebuild-drift', detail: 'build-record entry differs from a fresh rebuild', expected: canonicalJSON(row), actual: canonicalJSON(other) });
        }
      }
      for (const key of rebuiltByKey.keys()) {
        if (!byKey.has(key)) findings.push({ tier: 'static', layer: 'build', key, kind: 'rebuild-drift', detail: 'entry produced by a fresh rebuild, absent from the committed build record', expected: 'absent', actual: 'present' });
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  return {
    tier: 'static',
    layer: 'build',
    name: 'determinism (build-record integrity + rebuild)',
    pass: findings.length === 0,
    checked: verified,
    findings,
    ...(options.hermetic && !options.skipReproduce ? {} : { skipped: 'reproducibility skipped (no --hermetic or --no-determinism)' }),
    counts: { verified, entries: build.entries.length, reproduced: reproduced ? 1 : 0 }
  };
}

function driftFinding(field, expected, actual) {
  return { tier: 'static', layer: 'build', key: `(build.${field})`, kind: 'rebuild-drift', detail: `build-record ${field} differs from a fresh rebuild`, expected, actual };
}

/* ------------------------------------------------------------------------ *
 * DYNAMIC · strict-serving browser sweep (reuses probe.js)
 * ------------------------------------------------------------------------ */

/**
 * Render the remastered HTML documents through the shared browser probe against
 * a strict server this function boots. Requires agent-browser; the caller gates
 * on isBrowserAvailable and this throws (via the probe) if invoked without one.
 *
 * @param {string} root
 * @param {RemasterVerifyOptions} options
 * @returns {Promise<LayerReport>}
 */
export async function runDynamic(root, options) {
  const entries = await enumerateRemastered(root);
  const corpus = new Set(entries.map(e => e.key));
  let docs = entries.filter(e => e.status === 'body' && classifyContentType(e.contentType) === 'html');
  if (options.sample !== undefined) docs = docs.slice(0, options.sample);

  const server = await serveCacheRoot({ root });
  // The probe factory is injectable (deps.createProbe) so this loop's
  // fail-closed handling is unit-testable without a real browser; the bin wires
  // the default createBrowserProbe.
  const probe = (options.createProbe ?? createBrowserProbe)({ browserCmd: options.browserCmd, onProgress: options.onProgress });
  const documents = [];
  const findings = [];

  try {
    await probe.open();
    for (const doc of docs) {
      const result = await probe.render(server.url, doc.key, corpus);
      const docFindings = [];
      // A real render always issues at least the top-level document request, so
      // `observed === 0` is not a clean pass — it means navigation or
      // log-collection failed under the tolerant runner (probe.js ~line 241).
      // Fail closed: an empty finding set on no evidence must NOT verify.
      if (result.observed === 0) {
        docFindings.push({
          tier: 'dynamic',
          layer: 'browser',
          key: doc.key,
          kind: 'no-evidence',
          detail: 'browser render produced zero requests — navigation or log collection failed; failing closed'
        });
      }
      for (const req of result.nonLocal) {
        docFindings.push({ tier: 'dynamic', layer: 'browser', key: doc.key, kind: 'non-local-request', detail: 'attempted a request to a non-local origin', url: req.url });
      }
      for (const req of result.dangling) {
        docFindings.push({ tier: 'dynamic', layer: 'browser', key: doc.key, kind: 'dangling-local', detail: 'local capture path not in the corpus', url: req.url });
      }
      for (const msg of result.csp) {
        docFindings.push({ tier: 'dynamic', layer: 'browser', key: doc.key, kind: 'csp-violation', detail: msg.slice(0, 200) });
      }
      documents.push({ key: doc.key, url: result.url, pass: docFindings.length === 0, requests: result.requests, findings: docFindings });
      findings.push(...docFindings);
    }
  } finally {
    try {
      await probe.close();
    } catch {
      /* a failed close never fails the audit */
    }
    await new Promise((resolve, reject) => server.server.close(err => (err ? reject(err) : resolve())));
  }

  return {
    tier: 'dynamic',
    layer: 'browser',
    name: 'strict-serving browser sweep',
    pass: findings.length === 0,
    checked: documents.length,
    findings,
    counts: { documents: documents.length, htmlTotal: entries.filter(e => classifyContentType(e.contentType) === 'html').length },
    documents
  };
}

/* ------------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------------ */

/**
 * Run the requested tiers over a remastered root and return the full report.
 *
 * @param {RemasterVerifyOptions} options
 * @returns {Promise<RemasterVerifyReport>}
 */
export async function runRemasterVerify(options) {
  const tiers = options.tiers ?? ['static'];
  const logger = options.logger ?? NOOP_LOGGER;
  // The former already-formatted `onProgress(line)` string sink folds onto the
  // logger (§2): the determinism-rebuild line and the browser probe's progress
  // both flow through structured info records now.
  const onProgress = line => logger.info({ evt: 'verify-progress' }, line);
  const progressEvery = Number(options.progressEvery) > 0 ? Number(options.progressEvery) : 0;
  const layers = [];

  if (tiers.includes('static')) {
    const entries = await enumerateRemastered(options.root);
    layers.push(await scanEscapes(entries, { logger, progressEvery }));
    layers.push(await checkDeterminism(options.root, entries, { hermetic: options.hermetic, skipReproduce: options.skipDeterminism, onProgress }));
  }

  if (tiers.includes('dynamic')) {
    if (!isBrowserAvailable(options.browserCmd)) {
      layers.push({ tier: 'dynamic', layer: 'browser', name: 'strict-serving browser sweep', pass: true, checked: 0, findings: [], skipped: 'agent-browser not found on PATH' });
    } else {
      layers.push(await runDynamic(options.root, { ...options, onProgress }));
    }
  }

  // Diagnostic fold (§5): each layer verdict at info, each finding at its level
  // (dynamic browser findings warn, static escape/determinism error). Additive —
  // the report stays the DATA the CLI renders.
  for (const layer of layers) {
    logger.info(
      { evt: 'verify-layer', tier: layer.tier, layer: layer.layer, name: layer.name, pass: layer.pass, checked: layer.checked, findings: layer.findings?.length ?? 0 },
      `${layer.tier}/${layer.layer} — ${layer.name}: ${layer.pass ? 'PASS' : `FAIL (${layer.findings?.length ?? 0})`}`
    );
    const emit = layer.tier === 'dynamic' ? logger.warn : logger.error;
    for (const f of layer.findings ?? []) {
      emit.call(logger, { evt: 'verify-finding', tier: f.tier, layer: f.layer, key: f.key, kind: f.kind, detail: f.detail, ...(f.expected !== undefined ? { expected: f.expected } : {}), ...(f.actual !== undefined ? { actual: f.actual } : {}) }, `${f.kind}: ${f.key} — ${f.detail}`);
    }
  }

  return {
    tool: 'remaster-verify',
    root: options.root,
    ...(options.hermetic ? { hermetic: options.hermetic } : {}),
    pass: layers.every(l => l.pass),
    layers
  };
}

/**
 * Render a report as a human summary: one line per layer + the first `firstK`
 * findings under each. The `--json` output is the machine form; this is the
 * terminal form.
 *
 * @param {RemasterVerifyReport} report
 * @param {number} [firstK]
 */
export function formatReport(report, firstK = 10) {
  const lines = [];
  lines.push(`remaster verify: ${report.root}${report.hermetic ? ` (hermetic ${report.hermetic})` : ''}`);
  lines.push(`  ${report.pass ? 'PASS' : 'FAIL'}`);
  for (const layer of report.layers) {
    const counts = layer.counts ? ` [${Object.entries(layer.counts).map(([k, v]) => `${k}=${v}`).join(' ')}]` : '';
    const verdict = layer.skipped && layer.findings.length === 0 && layer.pass && layer.checked === 0 ? 'SKIP' : layer.pass ? 'PASS' : `FAIL (${layer.findings.length})`;
    lines.push(`  ${layer.tier}/${layer.layer} — ${layer.name}: ${verdict} · ${layer.checked} checked${counts}`);
    if (layer.skipped) lines.push(`      note: ${layer.skipped}`);
    for (const cls of Object.values(layer.residual?.classes ?? {})) {
      if (cls.count === 0) continue;
      lines.push(`      ${cls.label} · ${cls.count} · ${cls.status.toUpperCase()} · next: ${cls.next}`);
      for (const e of cls.entries.slice(0, firstK)) lines.push(`        ${e.key ?? e.url}${e.docs > 1 ? ` (${e.docs} docs)` : ''}`);
      if (cls.count > firstK) lines.push(`        … and ${cls.count - firstK} more`);
    }
    const unclassified = layer.findings.filter(f => f.class === undefined);
    for (const f of unclassified.slice(0, firstK)) {
      const loc = f.offset !== undefined ? ` @${f.offset}` : f.url ? ` ${f.url}` : '';
      const cmp = f.expected !== undefined ? ` (expected ${f.expected}, got ${f.actual})` : '';
      lines.push(`      ${f.kind} · ${f.key}${loc}: ${f.detail}${cmp}`);
      if (f.excerpt) lines.push(`        ${f.excerpt}`);
    }
    if (unclassified.length > firstK) lines.push(`      … and ${unclassified.length - firstK} more`);
  }
  return lines.join('\n');
}
