// Wayback replay-chrome strip — ported from render/wayback/src/html.ts.
//
// The bytes in the hermetic store are EXACTLY what archive.org's replay
// returned, including the chrome the replay injects into every HTML capture:
// the comment-delimited toolbar, the `_static/` script/CSS includes that
// drive it, and the inline `__wm.*` bootstrap. Remastering for standalone
// serving removes that chrome — it phones home to archive.org on every page
// view (the latency this mirror exists to avoid) and visually claims the page
// for web.archive.org.
//
// This is a DELIBERATE, FAITHFUL PORT of the serve-time transform's strip
// (render/wayback/src/html.ts#stripWaybackChrome) into this package, so the
// remastered tier bakes the strip in at build time instead of paying it per
// request. The two implementations are byte-for-byte equivalent by
// construction — the patterns below are copied verbatim — and the port's
// tests mirror html.test.ts's cases (toolbar block, `_static` includes, the
// `__wm` bootstrap, the End-Wayback-Rewrite marker, and non-wayback HTML
// passing through untouched). The one intentional DIFFERENCE from the serve
// transform: no attribution banner is injected. Capture bytes carry nothing
// of ours; attribution belongs to the serving chrome.

/** The comment-delimited toolbar block, exactly as the replay injects it. */
const TOOLBAR_RE = /<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi;

/**
 * Chrome asset URLs: the replay's own includes, in every spelling the
 * injector has used — absolute (`https://web-static.archive.org/_static/…`,
 * `//archive.org/includes/…`) and root-relative (`/_static/…`, `/static/…`).
 * Matched against a src/href VALUE, never against page text.
 */
const CHROME_SRC_RE = /^(?:(?:https?:)?\/\/(?:web-static\.)?archive\.org\/(?:_?static|includes)\/|\/_?static\/)/i;

/**
 * Inline-script markers only the replay's injector emits: the wombat/replay
 * bootstrap (`__wm.init`, `__wm.wombat`, `__wm.rw`, `__wm.bt`), the archive
 * analytics beacon, and the Ruffle (Flash shim) config. A capture's OWN
 * inline scripts contain none of these.
 */
const CHROME_INLINE_RE = /__wm\.|archive_analytics|window\.RufflePlayer\s*=/;

/** `<script … src="…">…</script>` — captures the src value for the filter. */
const SCRIPT_SRC_RE = /<script\b[^>]*\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/script>[ \t]*\n?/gi;

/** Inline `<script>…</script>` (no src) — body inspected for chrome markers. */
const SCRIPT_INLINE_RE = /<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>[ \t]*\n?/gi;

/** `<link … href="…">` — captures the href value for the filter. */
const LINK_HREF_RE = /<link\b[^>]*\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*\/?>[ \t]*\n?/gi;

/** The injector's own end-of-includes marker comment. */
const REWRITE_MARKER_RE = /<!--\s*End Wayback Rewrite JS Include\s*-->[ \t]*\n?/gi;

function unquote(value) {
  const first = value[0];
  return first === '"' || first === "'" ? value.slice(1, -1) : value;
}

/**
 * Strip the Wayback Machine's injected chrome from a replayed HTML capture.
 *
 * Removes, in order: the comment-delimited toolbar block, `<script src>` /
 * `<link href>` elements pointing at replay chrome assets, inline scripts
 * carrying replay bootstrap markers, and the injector's marker comment. The
 * replay's trailing provenance comments (`FILE ARCHIVED ON …`, playback
 * timings) are KEPT: they render as nothing and say where the bytes came
 * from. Non-wayback HTML passes through unchanged.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripWaybackChrome(html) {
  return html
    .replace(TOOLBAR_RE, '')
    .replace(SCRIPT_SRC_RE, (element, src) => (CHROME_SRC_RE.test(unquote(src)) ? '' : element))
    .replace(LINK_HREF_RE, (element, href) => (CHROME_SRC_RE.test(unquote(href)) ? '' : element))
    .replace(SCRIPT_INLINE_RE, (element, body) => (CHROME_INLINE_RE.test(body) ? '' : element))
    .replace(REWRITE_MARKER_RE, '');
}
