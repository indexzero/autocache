// Page-requisite extraction from wayback replay HTML.
//
// The wayback replay rewrites every asset reference in a captured HTML page
// to point back into the archive, tagging the timestamp with a replay flag
// that selects raw/asset rendering: `im_` (images), `cs_` (stylesheets),
// `js_` (scripts), `oe_` (media/objects/embeds). Those flagged refs ARE the
// page's requisites: cache each one and a mirrored page renders with local
// assets.
//
// Scope is DELIBERATE: exactly the four flags above, extracted
// from the replayed document's raw HTML. `if_`/`id_` frame the page itself
// and are not requisites; refs inside fetched CSS/JS bodies (e.g. url(...)
// inside an im_'d stylesheet) are one level deeper than the document scan
// and out of scope here — the debate's DAG records document→requisite edges
// only.
//
// Pure string surgery, same rationale as audit.js's chrome stripping:
// decade-old tag soup doesn't survive DOM round-trips, and the replay's
// rewritten URLs have one rigid shape that a scan matches exactly. The
// replay emits them in two forms — absolute
// (https://web.archive.org/web/<ts><flag>/<original>) and root-relative
// (/web/<ts><flag>/<original>, resolved against web.archive.org). Both are
// matched; the URL token ends at any character that would end it in HTML
// markup (quote, whitespace, angle bracket) or at a backslash (never legal
// in a URL, common in corrupt soup).
//
// Two deliberately CONTEXT-FREE heuristics ride on top of the scan (the
// scanner cannot know whether a match sits in an attribute, a <style>
// block, or prose — and parsing 2009 tag soup to find out is the cure
// that's worse): (1) HTML attribute entities are decoded, because rewritten
// URLs live overwhelmingly in attributes where `&amp;` spells `&`; (2) a
// bare unbalanced `)` terminates the URL, because CSS `url(...)` refs are
// common while unbalanced parens in real URLs are not — the exact tempered
// rule manifest.js#extractArchiveUrls applies to markdown (balanced pairs like msdn's
// `(VS.85)` are kept). Both trade vanishing-rare URL shapes for the
// overwhelmingly common contexts; the residual cases are recorded
// trade-offs, not oversights.

const REQUISITE_FLAGS = new Set(['im_', 'cs_', 'js_', 'oe_']);

// One pattern, two anchors: full-host or root-relative /web/. The original
// URL is captured liberally and repaired below (the same proxy-collapse
// repairs parseWaybackUrl in audit.js performs).
const REF_RE = /(?:https?:\/\/web\.archive\.org)?\/web\/(\d{4,14})(im_|cs_|js_|oe_)\/([^"'\s<>\\]+)/g;

/**
 * Truncate at the first UNBALANCED ')' — the CommonMark-style paren rule
 * manifest.js#extractArchiveUrls already applies to markdown link destinations, needed here
 * for refs inside CSS `url(...)` (style attributes / <style> blocks) where
 * a bare ')' closes the CSS function, while balanced '(...)' pairs are real
 * URL content (msdn's `...(VS.85).aspx` originals).
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
 * Decode the few named entities HTML attribute values legally carry —
 * replay HTML entity-encodes rewritten URLs in attributes (src="...&amp;..."),
 * and the archived ORIGINAL is the decoded form a browser would fetch.
 * Same conservative set audit.js's decodeEntities uses, minus &nbsp;
 * (whitespace already terminates the token).
 */
function decodeAttrEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** Repair the original-URL shapes wayback itself tolerates (see audit.js). */
function repairOriginal(original) {
  let out = decodeAttrEntities(trimUnbalanced(original));
  out = out.replace(/^(https?):\/(?!\/)/, '$1://');
  if (out.startsWith('//')) out = `https:${out}`;
  return out;
}

/**
 * Extract the page requisites from a replayed HTML body.
 *
 * @param {string} html - Raw replay HTML (NOT chrome-stripped: the replay's
 *   own _static assets never carry im_/cs_/js_/oe_ flags, so archive chrome
 *   cannot leak in as a requisite).
 * @returns {Array<{ timestamp: string, flag: 'im_'|'cs_'|'js_'|'oe_',
 *   original: string, key: string, waybackUrl: string }>}
 *   Deduped by capture key (`${timestamp}/${original}` — flagless, one body
 *   per (timestamp, url) however it's framed; see render/wayback/src/path.ts).
 *   `waybackUrl` keeps the flag: it is the FETCH url (the flagged replay
 *   serves the raw asset bytes), while `key` is the flagless identity the
 *   body is stored under.
 */
export function extractRequisites(html) {
  const seen = new Map();
  for (const m of html.matchAll(REF_RE)) {
    const [, timestamp, flag, rawOriginal] = m;
    if (!REQUISITE_FLAGS.has(flag)) continue; // unreachable via REF_RE; guards edits
    const original = repairOriginal(rawOriginal);
    if (original === '') continue; // e.g. `url(/web/<ts>im_/)` degenerate ref
    const key = `${timestamp}/${original}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      timestamp,
      flag,
      original,
      key,
      waybackUrl: `https://web.archive.org/web/${timestamp}${flag}/${original}`
    });
  }
  return [...seen.values()];
}
