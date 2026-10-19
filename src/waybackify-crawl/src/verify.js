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
import { BUILD_NAME, remaster } from '@autocache/waybackify/remaster.js';
import { isUnmirrorable } from '@autocache/waybackify/beacons.js';
import { dynamicEntryError } from '@autocache/waybackify/cache.js';
import { classifyContentType, refCaptureKey, WAYBACK_REF_RE } from '@autocache/waybackify/rewrite.js';
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

/** Walk `<root>/meta/<aa>/*.json` in a stable order. */
export async function enumerateRemastered(root) {
  const metaDir = path.join(root, 'meta');
  const out = [];
  for (const aa of (await readdirOrEmpty(metaDir)).sort()) {
    for (const file of (await readdirOrEmpty(path.join(metaDir, aa))).sort()) {
      if (!file.endsWith('.json')) continue;
      const metaPath = path.join(metaDir, aa, file);
      const sidecar = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
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
        capPath: path.join(root, 'cap', aa, hash),
        metaPath
      });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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

// The raw-text content of an HTML <script> or <style> block. A browser does
// not decode entities there, so a ref inside keeps its entity text in the key.
const RAW_TEXT_OPEN_RE = /<(script|style)(?=[\s/>])/gi;

/**
 * The index just past the '>' that ends the open tag at `from`, or -1. Walks
 * the attributes the way an HTML tokenizer does, so a '>' inside a quoted
 * attribute value does not end the tag.
 */
function openTagEnd(html, from) {
  let i = from;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '>') return i + 1;
    if (ch === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return -1;
        i = close + 1;
        continue;
      }
      continue; // an unquoted value ends at whitespace or '>', which this loop handles
    }
    i++;
  }
  return -1;
}

/** The [start, end) spans of the raw-text blocks in an HTML body. */
function rawTextSpans(html) {
  const spans = [];
  RAW_TEXT_OPEN_RE.lastIndex = 0;
  for (let m = RAW_TEXT_OPEN_RE.exec(html); m !== null; m = RAW_TEXT_OPEN_RE.exec(html)) {
    const start = openTagEnd(html, m.index + m[0].length);
    if (start === -1) break; // an unterminated open tag has no content
    const close = new RegExp(`</${m[1]}(?=[\\s/>])`, 'gi');
    close.lastIndex = start;
    const end = close.exec(html)?.index ?? html.length; // an unclosed block runs to the end
    spans.push([start, end]);
    RAW_TEXT_OPEN_RE.lastIndex = end;
  }
  return spans;
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
 * rewriter's own WAYBACK_REF_RE) is `archive-org` and carries the upstream `url`
 * and the `upstreamKey` the server resolves. An archive.org byte run outside every
 * such ref is `archive-org-bare`. The absolute-web-path scan skips any match
 * whose host is in the archive family. Root-relative refs are never findings.
 *
 * @param {string} key
 * @param {string} text
 * @param {{ html?: boolean }} [options] - the body is HTML. A browser decodes
 *   entities in its markup but not in its <script> or <style> text, so
 *   `upstreamKey` decodes them only outside those blocks.
 */
export function scanBody(key, text, { html = false } = {}) {
  const findings = [];
  const owned = [];
  const raw = html ? rawTextSpans(text) : [];
  for (const m of text.matchAll(WAYBACK_REF_RE)) {
    const [full, host, ts, flag, rawOriginal] = m;
    if (!host) continue; // root-relative: the correct remastered form
    const decodeEntities = html && !raw.some(([start, end]) => start <= m.index && m.index < end);
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
    if (RESOURCE_FLAGS.has(f.flag)) upstream.resource = true;
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
    let bytes;
    try {
      bytes = await fsp.readFile(entry.capPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        findings.push({ tier: 'static', layer: 'escape', key: entry.key, kind: 'body-missing', detail: `no cap/ body for a status:body sidecar` });
        continue;
      }
      throw error;
    }
    scanned++;
    // Silent-loop progress (design §6): the per-body scan had no hook.
    if (progressEvery && scanned % progressEvery === 0) {
      logger.info({ evt: 'verify-scan-progress', done: scanned }, `remaster verify: ${scanned} bodies scanned`);
    }
    // latin1 is a lossless byte↔char map, so byte offset === string index.
    const html = classifyContentType(entry.contentType) === 'html';
    for (const f of scanBody(entry.key, bytes.toString('latin1'), { html })) {
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
    let bytes;
    try {
      bytes = await fsp.readFile(entry.capPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'body-missing', detail: 'build record lists a body the tree lacks' });
        continue;
      }
      throw error;
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
