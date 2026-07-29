// Content-type-keyed rewrite engine — the heart of the remastered tier.
//
// The hermetic store keeps captures EXACTLY as archive.org's replay returned
// them: sealed, never rewritten. That faithfulness is also a facade — the
// replay's HTML still points hundreds of references per page back at
// web.archive.org (absolute `https://web.archive.org/web/…` URLs in
// attributes, inline CSS `url()`, and JS string literals — mechanism B1),
// or at host-relative `/web/…` paths that only resolve when the page is
// served from archive.org itself (B2). Served from our host those references
// either phone home (the latency this mirror exists to kill) or dangle.
//
// This module rewrites those references to the ROOT-RELATIVE
// `/web/<ts><flag>/<orig>` form — the one shape that resolves against any
// host, because render/wayback's path parser accepts the optional `/web`
// prefix as a first-class capture request (see render/wayback/src/path.ts).
// A reference is rewritten ONLY when its capture exists in the supplied
// corpus map; anything we cannot satisfy is left byte-for-byte foreign, so a
// strict serve/validator can still surface it.
//
// Implementation stance — string surgery, no DOM/CSS parse — is deliberate
// and matches the rest of this package (requisites.js, audit.js) and
// render/wayback's serve transform (html.ts): captures are decade-old tag
// soup no parser round-trips faithfully, the edge runtimes want zero heavy
// dependencies, and a machine-injected wayback reference has one rigid shape
// a scanner matches exactly. Every transform is a pure function of (bytes,
// corpus): same input → same output, which is what makes remaster.js
// deterministic.
//
// SCOPE (defended in the PR's "would have asked" section):
//   - B1 (absolute wayback refs) and B2 (host-relative /web/ refs) are the
//     classes this engine rewrites. Absolute refs lose their host; already-
//     root-relative refs are recognized and preserved (idempotent).
//   - B6 (bare original-site root-relative paths like `/logo.png`) is NOT
//     rewritten here: localizing those needs the containing document's own
//     capture base URL and risks re-pointing genuinely-relative app routes.
//     It is a separate, base-aware pass — noted, not done.
//   - The KEY a reference resolves to is derived exactly the way the serving
//     parser derives it (repairOriginalUrl mirrors path.ts#repairUrl), so
//     "in the corpus" means "the server can actually serve it".

import { stripWaybackChrome } from './strip.js';

export { stripWaybackChrome } from './strip.js';

/**
 * Rewrite-rule version. Bump when the MATCHING or REWRITING behavior changes
 * (a new reference class, a different target form, a strip-pattern change) so
 * a remastered tree's build record notes which rules produced it and
 * remaster verify can detect a stale rebuild.
 */
export const RULE_VERSION = 1;

/* ------------------------------------------------------------------------ *
 * Content-type classification
 * ------------------------------------------------------------------------ */

/**
 * Classify a capture's content type into the rewrite dialect that applies, or
 * null for "pass through untouched". Keyed off the media type only (the
 * `;charset=…` parameter is dropped). Anything not recognized as HTML/CSS/JS
 * — images, fonts, octet-stream, empty — is never text-rewritten.
 *
 * @param {string} contentType
 * @returns {'html'|'css'|'js'|null}
 */
export function classifyContentType(contentType) {
  if (!contentType) return null;
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml' || /(?:^|\/)xhtml\b/.test(type)) {
    return 'html';
  }
  if (type === 'text/css') return 'css';
  if (
    type === 'text/javascript' ||
    type === 'application/javascript' ||
    type === 'application/x-javascript' ||
    type === 'text/ecmascript' ||
    type === 'application/ecmascript' ||
    /(?:java|ecma)script/.test(type)
  ) {
    return 'js';
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Reference → capture-key derivation (serving-parser parity)
 * ------------------------------------------------------------------------ */

// A wayback reference: an OPTIONAL archive.org host (absolute or protocol-
// relative), then `/web/<ts><flag?>/<original>`. The original is captured
// liberally ([^"'\s<>\\]+) and trimmed/repaired below — the same tempered
// scan requisites.js and manifest.js#extractArchiveUrls apply.
const WAYBACK_REF_RE = /((?:https?:)?\/\/web\.archive\.org)?\/web\/(\d{4,14})([a-z]{1,3}_)?\/([^"'\s<>\\]+)/g;

/**
 * Truncate an original-URL token at its first UNBALANCED ')' — the
 * CommonMark-style paren rule requisites.js/manifest.js already use, needed
 * for refs inside CSS `url(…)` where a bare ')' closes the function while
 * balanced '(…)' pairs are real URL content (msdn's `…(VS.85).aspx`).
 * @param {string} original
 * @returns {string}
 */
function trimUnbalanced(original) {
  let depth = 0;
  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return original.slice(0, i);
      depth--;
    }
  }
  return original;
}

/**
 * Decode the few named entities an HTML attribute value legally carries.
 * Applied ONLY to derive the lookup key (the byte the browser would fetch),
 * never to the emitted bytes — an attribute keeps its `&amp;` verbatim, and
 * the browser decodes it the same whether the host prefix is present or not.
 * Same conservative set requisites.js uses.
 * @param {string} s
 * @returns {string}
 */
function decodeAttrEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/**
 * Repair the embedded original URL EXACTLY the way render/wayback's serving
 * parser does (path.ts#repairUrl): collapse a proxy-flattened scheme
 * (`http:/host` → `http://host`), assume https for protocol-relative, assume
 * http for a scheme-less host, and reject anything that still isn't a URL
 * with a host (null). Parity is load-bearing: a reference is "satisfiable"
 * iff the server, re-parsing the exact bytes we emit, derives a key we hold.
 * @param {string} rest
 * @returns {string|null}
 */
function repairOriginalUrl(rest) {
  const collapsed = rest.replace(/^(https?):\/(?!\/)/i, '$1://');
  if (/^https?:\/\/[^/]/i.test(collapsed)) return collapsed;
  if (collapsed.startsWith('//') && /^\/\/[^/]/.test(collapsed)) return `https:${collapsed}`;
  if (/^[\w-]+(\.[\w-]+)+([:/?#]|$)/.test(collapsed)) return `http://${collapsed}`;
  return null;
}

/**
 * Localize every wayback reference in a text region. Absolute refs shed their
 * host; host-relative refs are emitted unchanged (already the target form).
 * A ref is rewritten only when its derived capture key is in `corpus`.
 *
 * @param {string} text
 * @param {{ has(key: string): boolean }} corpus - captureKey → present.
 * @param {Object} [options]
 * @param {boolean} [options.decodeEntities=false] - decode HTML entities when
 *   deriving the key (true for HTML attribute / inline-style contexts, where
 *   the value is entity-encoded; false for CSS/JS bodies, which are not).
 * @returns {{ text: string, count: number }} count = refs actually changed.
 */
function localizeRefs(text, corpus, { decodeEntities = false } = {}) {
  let count = 0;
  const out = text.replace(WAYBACK_REF_RE, (full, _host, ts, flag, rawOriginal) => {
    const trimmed = trimUnbalanced(rawOriginal);
    const suffix = rawOriginal.slice(trimmed.length); // e.g. a trailing ')' — kept as literal text
    const candidate = decodeEntities ? decodeAttrEntities(trimmed) : trimmed;
    const original = repairOriginalUrl(candidate);
    if (original === null || original === '') return full; // not a satisfiable URL shape → foreign
    if (!corpus.has(`${ts}/${original}`)) return full; // capture absent → stays foreign
    const replacement = `/web/${ts}${flag || ''}/${trimmed}${suffix}`;
    if (replacement !== full) count++;
    return replacement;
  });
  return { text: out, count };
}

/* ------------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------------ */

/**
 * Rewrite a CSS body. `url()`, `@import`, and `@font-face { src: url() }` all
 * reduce to the same job — a wayback reference embedded in the stylesheet —
 * so one scan localizes them all; the unbalanced-paren trim in localizeRefs
 * is exactly what lets a `url(…)` ref end at its closing paren.
 * @param {string} css
 * @param {{ has(key: string): boolean }} corpus
 * @param {Object} [options] - { decodeEntities } (true only for style attrs)
 * @returns {{ text: string, changed: boolean, count: number }}
 */
export function rewriteCss(css, corpus, options = {}) {
  const { text, count } = localizeRefs(css, corpus, options);
  return { text, changed: text !== css, count };
}

/* ------------------------------------------------------------------------ *
 * JavaScript
 * ------------------------------------------------------------------------ */

// EXACT wayback-URL string literals only — nothing clever. The literal's
// ENTIRE content must be an absolute `https://web.archive.org/web/…` URL: a
// quote, the URL, the matching quote. Concatenations, substrings, template
// interpolations, host-relative forms — all left alone (we cannot know their
// runtime value without executing the script).
const JS_LITERAL_RE = /(["'])(https?:\/\/web\.archive\.org\/web\/(\d{4,14})([a-z]{1,3}_)?\/((?:(?!\1)[^\r\n\\])*))\1/g;

/**
 * Rewrite absolute wayback-URL string literals in a JS body to the root-
 * relative form, when the capture exists. Deliberately conservative.
 * @param {string} js
 * @param {{ has(key: string): boolean }} corpus
 * @returns {{ text: string, changed: boolean, count: number }}
 */
export function rewriteJs(js, corpus) {
  let count = 0;
  const text = js.replace(JS_LITERAL_RE, (full, quote, _url, ts, flag, original) => {
    const repaired = repairOriginalUrl(original);
    if (repaired === null || repaired === '') return full;
    if (!corpus.has(`${ts}/${repaired}`)) return full;
    count++;
    return `${quote}/web/${ts}${flag || ''}/${original}${quote}`;
  });
  return { text, changed: text !== js, count };
}

/* ------------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------------ */

// URL-bearing attributes we localize. `srcset` rides through localizeRefs
// unchanged (each candidate URL ends at whitespace before its descriptor);
// `style` is inline CSS, handled via rewriteCss; `data-*` is a family,
// matched by prefix. Deliberately a small, explicit set — see would-ask.
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'poster']);

// One opening/self-closing tag. `[^>]*` cannot span a '>' inside an
// attribute value, but wayback URLs never contain a raw '>' (it terminates
// the token), the same tolerance html.ts relies on. Closing tags (`</x>`)
// don't match — the class requires a letter right after '<'.
const OPEN_TAG_RE = /<[a-zA-Z][^>]*>/g;

// One attribute inside a tag: name, the `=` (with optional spaces), value
// (double/single-quoted or bare). A bare tagname is never captured — the
// `=` is required.
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;

// Inline <style>…</style> and inline <script>…</script> (no src) blocks.
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const SCRIPT_BLOCK_RE = /(<script\b(?![^>]*\ssrc\s*=)[^>]*>)([\s\S]*?)(<\/script>)/gi;

/**
 * Rewrite the URL-bearing attributes of every opening tag. `style` values are
 * treated as inline CSS; every other target is a single URL region. Values
 * keep their quoting and their entity encoding; only a wayback reference
 * inside them is localized.
 */
function rewriteAttributes(html, corpus, counter) {
  return html.replace(OPEN_TAG_RE, tag =>
    tag.replace(ATTR_RE, (full, name, eq, value) => {
      const lower = name.toLowerCase();
      const isStyle = lower === 'style';
      if (!isStyle && !URL_ATTRS.has(lower) && !lower.startsWith('data-')) return full;
      const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
      const inner = q ? value.slice(1, -1) : value;
      const res = isStyle
        ? rewriteCss(inner, corpus, { decodeEntities: true })
        : localizeRefs(inner, corpus, { decodeEntities: true });
      counter.count += res.count;
      return `${name}${eq}${q}${res.text}${q}`;
    })
  );
}

/**
 * Rewrite an HTML capture: strip the Wayback Machine's injected chrome
 * (toolbar, `_static` includes, `__wm` bootstrap — ported from render/
 * wayback's serve transform), then localize wayback references in URL-bearing
 * attributes, inline `<style>` blocks, and inline `<script>` literals.
 *
 * The attribution banner is NOT injected here — capture bytes carry nothing
 * of ours; attribution is the serving chrome's job.
 *
 * @param {string} html
 * @param {{ has(key: string): boolean }} corpus
 * @returns {{ text: string, changed: boolean, count: number }}
 */
export function rewriteHtml(html, corpus) {
  const counter = { count: 0 };
  let out = stripWaybackChrome(html);
  out = rewriteAttributes(out, corpus, counter);
  out = out.replace(STYLE_BLOCK_RE, (_full, open, body, close) => {
    const res = rewriteCss(body, corpus); // <style> content is raw text — no entity decode
    counter.count += res.count;
    return `${open}${res.text}${close}`;
  });
  out = out.replace(SCRIPT_BLOCK_RE, (_full, open, body, close) => {
    const res = rewriteJs(body, corpus);
    counter.count += res.count;
    return `${open}${res.text}${close}`;
  });
  return { text: out, changed: out !== html, count: counter.count };
}

/* ------------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------------ */

/**
 * Rewrite a capture body by its content type. Unknown/binary types pass
 * through untouched. The one entry point remaster.js and a future serve-time
 * `--root` dev mode share.
 *
 * @param {string} contentType - the capture's sidecar contentType
 * @param {string} text - the body as a (latin1-safe) string
 * @param {{ has(key: string): boolean }} corpus
 * @returns {{ text: string, changed: boolean, count: number, dialect: 'html'|'css'|'js'|null }}
 */
export function rewrite(contentType, text, corpus) {
  const dialect = classifyContentType(contentType);
  switch (dialect) {
    case 'html':
      return { ...rewriteHtml(text, corpus), dialect };
    case 'css':
      return { ...rewriteCss(text, corpus), dialect };
    case 'js':
      return { ...rewriteJs(text, corpus), dialect };
    default:
      return { text, changed: false, count: 0, dialect: null };
  }
}
