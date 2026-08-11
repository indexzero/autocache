/**
 * The wayback mirror Hono app (#249).
 *
 * Runtime-agnostic on purpose: this module is pure Hono + Web APIs and takes
 * its Store (src/store.ts) as an argument, so the SAME app deploys to
 * Cloudflare Workers (src/cloudflare.ts, R2-backed), Fastly Compute
 * (src/fastly.ts, KV-backed), and Node (src/node.ts, cache-root-backed),
 * and tests drive it with app.request() against a MemoryStore — zero
 * network, zero vendor.
 *
 * Serving semantics (`/web/<ts><flag?>/<url>` is accepted everywhere
 * `/<ts><flag?>/<url>` is, and means the same capture — see src/path.ts).
 *
 * STRICT is the default (#361). A miss must not leak, and a page must carry
 * nothing of ours. Every corpus miss — document or requisite — answers a
 * styled local 404, self-contained and `no-store`. The old miss→302-to-live
 * behavior survives only behind `{ liveFallback: true }` (serve.js's
 * `--live-fallback`, or the edge entries' env/config switch), off by default.
 *
 *   /                          → index page (what this service is)
 *   /<ts><flag?>/<url>  HIT    → the stored capture body, correct
 *                                content-type, a year-long immutable
 *                                Cache-Control (captures never change), and
 *                                X-Wayback-Source pointing at the original
 *                                web.archive.org capture. text/html documents
 *                                get the serve-time chrome strip (src/html.ts)
 *                                and the standalone CSP header; everything
 *                                else passes through byte-for-byte. Bodiless
 *                                entries answer per their status
 *                                discriminator (src/store.ts): empty → 200
 *                                with no body, redirect → local 404 (or the
 *                                archive replay under liveFallback), error →
 *                                local 404.
 *   /<ts><flag?>/<url>  MISS   → styled local 404, `no-store`. Under
 *                                liveFallback: 302 to the corresponding
 *                                web.archive.org URL (flag preserved),
 *                                `no-store` — the old graceful-degradation
 *                                story, now opt-in.
 *   anything else              → local 404.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { classifyContentType, rewrite } from '@autocache/waybackify/rewrite.js';
import { stripWaybackChrome } from './html.ts';
import { decodeCapturePath, formatCapturePath, parseWaybackPath } from './path.ts';
import type { Store } from './store.ts';

/** The two header names the standalone CSP can ride, per `cspMode`. */
type CspMode = 'enforce' | 'report-only';

/**
 * The MINIMAL logger the serving path emits through (design §9). Deliberately
 * `warn`-only and object-first: pino, a `console`-shim, and a no-op ALL satisfy
 * it, so the edge stays interchangeable. Node-free ON PURPOSE — this interface
 * rides in the Fastly/Cloudflare bundle graph, so NO stream / `process` /
 * `node:` may leak in (it typechecks under `tsconfig.fastly.json`). Call sites
 * use ONLY `log.warn(obj, msg)` — never `.child()`, a serializer, or a stream.
 */
export interface EdgeLogger {
  warn(obj?: object, msg?: string): void;
}

/**
 * The no-op the app falls back to when no logger is injected. The runtime
 * ENTRIES supply the observable default (a `console`-shim) or the no-op when
 * `WAYBACK_LOG_SILENT` is set — see cloudflare.ts / fastly.ts / node.ts (§9).
 */
const NOOP_EDGE_LOGGER: EdgeLogger = { warn() {} };

/**
 * The observable-by-default `console`-shim the edge entries inject (§9). One
 * line per event, edge-portable: `console` is a global on Workers AND Compute
 * (and is declared in both type worlds, so this stays `node:`-free and
 * typechecks under `tsconfig.fastly.json`). `wrangler tail` / `fastly log-tail`
 * stream it for free; flip `WAYBACK_LOG_SILENT` to inject the no-op instead.
 */
export function edgeConsoleLogger(): EdgeLogger {
  return {
    warn(obj?: object, msg?: string): void {
      console.warn(msg ? `${msg} ${JSON.stringify(obj ?? {})}` : JSON.stringify(obj ?? {}));
    }
  };
}

/** Captures are immutable; say so as loudly as HTTP allows. */
const HIT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Soft 4xx and the opt-in live-fallback 302 steer clients rather than serve
 * capture bytes — nothing here is cacheable, ever. `no-store` ends the cache
 * poisoning the sweep found (soft errors pinned `immutable` for a year, the
 * miss→302 pinned `max-age=300`).
 */
const NO_STORE = 'no-store';

/**
 * The standalone Content-Security-Policy for served HTML documents (#361).
 * The browser itself refuses non-local fetches — the enforcement layer for
 * references no rewriter can catch. Every family is `'self'` (requisites are
 * rewritten to the root-relative `/web/<ts><flag>/<orig>` form, same origin).
 * `'unsafe-inline'` on script-src and style-src is load-bearing for decade-old
 * captures: they carry inline <style> blocks, `style="…"` attributes, and
 * inline event handlers (`onload="…"`), all of which the fixtures exercise.
 * `data:` on img-src covers inline-encoded images defensively.
 */
const DOCUMENT_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  // `form-action` does NOT inherit from `default-src` — without it, hostile
  // archived JS (the content iframe grants `allow-forms`) could POST a
  // cross-origin `<form>` to exfiltrate data despite `connect-src 'self'`.
  // `'self'` keeps same-origin form fidelity; it mirrors the chrome lockdown.
  "form-action 'self'"
];
const DOCUMENT_CSP = DOCUMENT_CSP_DIRECTIVES.join('; ');

/**
 * The archive origins the opt-in `relaxContentCsp` STOPGAP admits into the
 * content CSP (see {@link AppOptions.relaxContentCsp}): live web.archive.org
 * replay plus archive.org itself (replay pages pull static assets from both).
 */
const ARCHIVE_CONTENT_ORIGINS = 'https://web.archive.org https://archive.org';

/**
 * The content directives the relaxation widens — resource-loading families
 * only. Pointedly ABSENT: `default-src`, `form-action`, `base-uri`, and
 * `frame-ancestors` — the relaxation widens directive VALUES on the fetch
 * families, never the document's own posture or its framing/egress contract.
 */
const RELAXABLE_CONTENT_DIRECTIVES = new Set([
  'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'frame-src'
]);

/**
 * DOCUMENT_CSP with the archive origins appended to each relaxable directive —
 * the STOPGAP posture. Built from the directive LIST (append per named
 * directive), not by patching the finished policy string, so a directive
 * reorder or addition cannot silently misplace an origin.
 */
function relaxedDocumentCsp(): string {
  return DOCUMENT_CSP_DIRECTIVES
    .map(d => (RELAXABLE_CONTENT_DIRECTIVES.has(d.slice(0, d.indexOf(' '))) ? `${d} ${ARCHIVE_CONTENT_ORIGINS}` : d))
    .join('; ');
}

/**
 * The description paragraph each served page carries — the ONE fragment that
 * varies per deployment (#453). Everything else on the index and 404 (title,
 * styles, the "Not mirrored here" heading, the URL-shape explanation, the "No
 * request left this server" line) is site-agnostic and stays baked into the
 * template. A deployment threads its own copy through {@link AppOptions.copy};
 * absent that, the generic defaults below ship.
 *
 * SECURITY: `index`/`notFound` are TRUSTED site configuration — they
 * intentionally contain `<a>` links, so they are injected as RAW HTML, NOT
 * escaped (the site owns its own copy's safety). This is the SOLE unescaped
 * interpolation in a served page; the host (`mirrorHost`/`chromeHost`) can be
 * the attacker-controlled request Host header and MUST stay `escapeHtml`'d.
 */
export interface ServedCopy {
  /** Description paragraph on the index page (raw HTML fragment). */
  index?: string;
  /** Description sentence on the 404 page (raw HTML fragment). */
  notFound?: string;
}

/**
 * The GENERIC, site-agnostic index description — the shipped base case (#453).
 * Names no specific deployment; a real mirror overrides it via
 * {@link AppOptions.copy}. Raw HTML by contract (see {@link ServedCopy}).
 */
const DEFAULT_INDEX_ABOUT =
  'A self-hosted mirror of the <a href="https://web.archive.org/">Wayback Machine</a> ' +
  'captures that its source pages reference — exactly those, nothing more. It exists ' +
  'because archive.org replay is slow and occasionally down, and these links are ' +
  'load-bearing for old pages.';

/**
 * The GENERIC, site-agnostic 404 description — the shipped base case (#453).
 * Names no specific deployment. Raw HTML by contract (see {@link ServedCopy}).
 */
const DEFAULT_NOT_FOUND_ABOUT =
  'This mirror serves exactly the <a href="https://web.archive.org/">Wayback Machine</a> ' +
  'captures that its source pages reference. This capture is not among them.';

/**
 * The styled local 404. Small, self-contained, zero external references (so
 * it renders under its own CSP and leaks nothing), served `no-store`. This is
 * what a corpus miss looks like now — an honest local answer, not a bounce to
 * live web.archive.org. `about` is the (raw-HTML, TRUSTED) site description
 * paragraph — see {@link ServedCopy}.
 */
function notFoundHtml(mirrorHost: string, about: string, archiveUrl?: string): string {
  // SECURITY: mirrorHost can be the attacker-controlled request Host header in
  // single-host mode — escape it exactly like the chrome shell escapes the
  // capture URL, or a hostile Host smuggles markup into the served page. NOTE:
  // `about` is TRUSTED site config (it carries an <a> link) and is injected
  // RAW on purpose — the site owns its safety; the host stays escaped.
  const h = escapeHtml(mirrorHost);
  // The hand-off to the Internet Archive. Rendered ONLY for a capture MISS,
  // where `archiveUrl` names the wayback URL this capture lives at (a generic
  // /index 404 passes none, so it gets no link). It is an explicit hop to a
  // SEPARATE site — new tab (`target="_blank"`, riding the iframe sandbox's
  // existing allow-popups so no sandbox change is needed), `rel="noopener
  // noreferrer"` — and the copy names the Internet Archive plainly, matching
  // the mirror's "NOT affiliated with the Internet Archive" disclaimer voice:
  // an honest referral, not an in-house feature. archiveUrl is derived from the
  // attacker-controlled request path, so it goes through escapeHtml.
  const archiveLink = archiveUrl
    ? `\n<p>This page was archived by the Internet Archive, a separate organization.
<a href="${escapeHtml(archiveUrl)}" target="_blank" rel="noopener noreferrer">View this page on the Internet Archive ↗</a></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not mirrored · ${h} · web.archive.org mirror</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  .muted { color: #666; }
</style>
</head>
<body>
<h1>Not mirrored here</h1>
<p>${about}</p>
<p class="muted">No request left this server for it. If you need the original,
it lives at <code>web.archive.org</code>.</p>${archiveLink}
</body>
</html>
`;
}

function indexHtml(mirrorHost: string, about: string): string {
  // SECURITY: see notFoundHtml — mirrorHost may be the attacker-controlled
  // request Host header, so it MUST go through escapeHtml before interpolation.
  // `about` is TRUSTED site config injected RAW (it carries <a> links).
  const h = escapeHtml(mirrorHost);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h} · web.archive.org mirror</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
</style>
</head>
<body>
<h1>${h}</h1>
<p>${about}</p>
<p>URLs mirror the wayback shape:
<code>/&lt;timestamp&gt;/&lt;original-url&gt;</code>. Captures not mirrored here
answer a local 404 — the mirror serves what it holds and nothing else.</p>
<p>All mirrored content is the Internet Archive's work. Consider
<a href="https://archive.org/donate/">donating to the Internet Archive</a>.</p>
</body>
</html>
`;
}

/**
 * The local-only cache index/search page (`GET /_index`). Server-rendered,
 * zero client script (CSP-safe by construction): a plain GET form filters the
 * key list server-side — the `q` substring filter plus the "is requisite?"
 * checkbox (`showReq`), which rides the same GET query (`req` present =
 * checked) and persists across submits via the `checked` attribute.
 * `q` is attacker-controlled (a query param) and every
 * key is arbitrary archived-URL text — both go through escapeHtml, no
 * exceptions. Styled to match {@link indexHtml}.
 */
function indexSearchHtml(mirrorHost: string, q: string, showReq: boolean, shown: string[], total: number): string {
  const h = escapeHtml(mirrorHost);
  // Each link must ROUND-TRIP: clicking it has to land on the byte-exact
  // capture key. escapeHtml alone is XSS-safe but not URL-safe — a raw `#`
  // would become a fragment (dropped client-side) and the WHATWG parser
  // would re-encode spaces/`<`/quotes/Unicode, so the `*` route's parse
  // (which does NOT percent-decode) would see a different key. So the href
  // is built by formatCapturePath (src/path.ts) — the parser's inverse,
  // whose output the browser transmits byte-identically and whose escape
  // set the `*` route's decode-fallback maps back to the exact key — and
  // THEN HTML-escaped for the attribute context.
  const items = shown
    .map(key => `<li><a href="${escapeHtml(formatCapturePath(key))}">${escapeHtml(key)}</a></li>`)
    .join('\n');
  const refine = total > shown.length ? ' — refine to narrow' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cache index · ${h} · web.archive.org mirror</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  ul { padding-left: 1.2rem; }
  li { overflow-wrap: anywhere; }
  .muted { color: #666; }
  footer { margin: 3rem -1rem 0; padding: 0.75rem 1rem; text-align: center; background: #333; color: #fff; }
  footer a { color: #8ab4f8; }
  @media (max-width: 480px) {
    footer { font-size: 12px; }
    footer .clause { display: flex; justify-content: center; gap: 0.3em; white-space: nowrap; max-width: 100%; }
    footer .sep { display: none; }
  }
</style>
</head>
<body>
<h1>Cache index · ${h}</h1>
<form method="get" action="/_index">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="filter capture keys">
  <label><input type="checkbox" name="req"${showReq ? ' checked' : ''}> is requisite?</label>
  <button type="submit">Search</button>
</form>
<p class="muted">showing ${shown.length} of ${total}${refine}</p>
<ul>
${items}
</ul>
<footer>${MIRROR_DISCLAIMER}</footer>
</body>
</html>
`;
}

/**
 * The chrome/content split (#320). One deployed app, two hostnames routed by
 * the Host header: the CHROME host serves attribution UI + a sandboxed iframe
 * shell and NEVER serves capture bytes; the CONTENT host — a declared
 * sacrificial usercontent origin — serves the transformed capture bytes
 * cross-origin, carrying a `frame-ancestors` CSP that lets only the chrome host
 * frame it. Absent this config the app is single-host (today's behavior, which
 * the #292 local-serving milestone relies on).
 */
export interface SplitOptions {
  /**
   * Chrome origin host (e.g. `mirror.example`) — attribution UI, routing,
   * the iframe shell. Requests here serve NO capture bytes, ever.
   */
  chromeHost: string;
  /**
   * Content origin host (e.g. `content.example.net`) — the
   * sacrificial usercontent zone that serves capture bytes, embedded
   * cross-origin. Only this host reaches the store.
   */
  contentHost: string;
  /**
   * Scheme for the cross-origin references (the iframe `src`, the
   * `frame-ancestors` and `frame-src` origins). Defaults to `https` — the
   * production posture; local dev over http can override it.
   */
  scheme?: string;
}

/** Store-agnostic app behavior — the serving MODE, independent of storage. */
export interface AppOptions {
  /**
   * Restore the pre-#361 miss→302-to-live behavior. OFF by default: strict
   * serving answers every miss with a local 404. When on, a miss (and an
   * archived-redirect entry) 302s to web.archive.org, `no-store`. The flag
   * is store-agnostic on purpose — every runtime entry threads its own switch
   * (serve.js `--live-fallback`, the edge entries' env/config) to this option.
   */
  liveFallback?: boolean;
  /**
   * Serve-time reference localization (design §D3). When set, a served text
   * dialect (html/css/js, per `classifyContentType`) has its wayback references
   * rewritten to the root-relative `/web/<ts><flag>/<orig>` form — but ONLY for
   * references whose capture key `has()` returns true, so a reference the mirror
   * cannot satisfy is left byte-for-byte foreign. The set is the corpus key-set
   * (src/corpus.ts), built once at boot. Off by default: css/js pass through
   * untouched and html gets only the chrome strip, exactly as before.
   */
  localize?: { has(key: string): boolean };
  /**
   * How the standalone CSP is emitted (design §D3). `'enforce'` (the default)
   * sends `Content-Security-Policy`; `'report-only'` sends
   * `Content-Security-Policy-Report-Only` with the SAME policy — a monitoring
   * posture for staging a stricter policy without breaking pages. Applied ONLY
   * to the plain single-host document CSP (the HTML hit and the 404). It does
   * NOT govern the content-host `frame-ancestors` variant under the split: that
   * is a hostile-content egress boundary and is ALWAYS enforced, exactly like
   * the chrome origin's own lockdown CSP — report-only on a security boundary
   * (`script-src 'none'` shell lockdown, or the content-host egress-lock) is
   * log-only = a full bypass, so both are exempt.
   */
  cspMode?: CspMode;
  /**
   * STOPGAP (off by default — strict). When true, the CONTENT CSP's
   * resource-loading directives (script/style/img/font/media/connect/frame)
   * additionally allow `https://web.archive.org https://archive.org`, and the
   * chrome shell's `frame-src`/`child-src` allow `https://web.archive.org` —
   * so wayback references the localizer has not (yet) rewritten load LIVE from
   * the archive instead of being blocked (self-containment is lost while it is
   * on). The flag widens directive VALUES only: `default-src 'self'`,
   * `form-action 'self'`, `base-uri`, every `frame-ancestors`, the chrome
   * `script-src 'none'`/`object-src 'none'`, and the enforcement MODE (the
   * boundary policies stay forced-`'enforce'`) are all untouched. Once
   * localization covers the full reference graph this flag is a no-op.
   */
  relaxContentCsp?: boolean;
  /**
   * The chrome/content split (#320). When set, serving is Host-keyed: the
   * chrome host gets the iframe shell (no store access), the content host gets
   * capture bytes + the `frame-ancestors` CSP. When absent, the app is
   * single-host — byte-identical to pre-#320 behavior. Threaded from each
   * runtime entry's own config (serve.js `--chrome-host`/`--content-host`, the
   * edge entries' env/config constants).
   */
  split?: SplitOptions;
  /**
   * Per-deployment served-page copy (#453): the description paragraph of the
   * index and 404 pages. Absent (or a field absent), the generic site-agnostic
   * defaults ship (DEFAULT_INDEX_ABOUT / DEFAULT_NOT_FOUND_ABOUT). TRUSTED site
   * configuration — the fragments are injected as RAW HTML (they carry `<a>`
   * links), so the site owns their safety; see {@link ServedCopy}. Threaded
   * from each runtime entry (serve.js's node config, the edge handlers' config)
   * and, in production, supplied by the site layer (render/wayback's COPY).
   */
  copy?: ServedCopy;
  /**
   * Local-only cache index (the full capture key-set from loadCorpusKeySet).
   * Set ONLY by the Node --root entry; edge entries can't enumerate and must
   * never set it. When present, `GET /_index` serves a search page.
   */
  indexKeys?: Set<string>;
  /**
   * The REQUISITE subset of `indexKeys` (loadCorpusCatalog's `requisites`):
   * keys whose sidecar `flag` marks them a page requisite (`im_`/`cs_`/`js_`/
   * `oe_` — images/styles/scripts/media). `/_index` filters on it: the
   * default listing shows only top-level captures (keys NOT in this set);
   * the "is requisite?" checkbox flips to requisites only. Absent, every key
   * is treated as top-level (the pre-filter behavior).
   */
  indexRequisites?: Set<string>;
  /**
   * Diagnostic sink for the serving path (design §9), same injection pattern as
   * `localize`/`cspMode`. The runtime entry supplies it: a `console`-shim by
   * default (observable for free — `wrangler tail` / `fastly log-tail`), or the
   * no-op when `WAYBACK_LOG_SILENT` is set. Absent → the no-op. Only notable
   * events emit (a corpus miss, a bodiless capture with nothing to serve); the
   * HIT happy path stays silent, so the hot path costs nothing.
   */
  logger?: EdgeLogger;
}

/**
 * Emit a standalone document CSP under the header name `mode` selects — the
 * ONE place the header name is chosen, so the HTML-hit branch and the 404
 * always agree. `policy` is the document policy to stamp (the plain document
 * CSP, or its content-host `frame-ancestors` variant under the split). The
 * chrome origin's own lockdown CSP does NOT go through here: it is always
 * enforced (a `script-src 'none'` trusted-shell lockdown must never be merely
 * report-only).
 */
function setCsp(c: Context, policy: string, mode: CspMode): void {
  c.header(mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', policy);
}

/**
 * HTML-escape a string for interpolation into the chrome shell (text OR
 * attribute context — the conservative five-char set covers both). This is
 * SECURITY-CRITICAL, not cosmetic: the capture URL is attacker-controlled (it
 * is the request path), and the chrome shell renders on the TRUSTED chrome
 * origin. Without escaping, a path like `…/"><script>…` would break out of the
 * iframe `src` attribute and run script with the chrome origin's authority —
 * exactly the first-party XSS #320 exists to prevent.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Make a request-derived string safe to emit as an HTTP header value. Header
 * values are ByteStrings (no NUL/CR/LF; nothing beyond latin1 — a raw U+65E5
 * makes Headers.set THROW, a 500 instead of a capture). Unreachable before
 * the decode-fallback (a wire-derived URL is ASCII), but a fallback hit's
 * identity can carry Unicode/control bytes from the byte-exact key. Values
 * that are already visible-ASCII — every value emitted today — pass through
 * UNTOUCHED (no re-encoding of existing `%XX`, no behavior change); anything
 * else gets its offending bytes percent-encoded (UTF-8), printable ASCII
 * kept verbatim.
 */
function headerSafe(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  let out = '';
  for (const b of new TextEncoder().encode(value)) {
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The chrome host's own CSP. The chrome origin serves only OUR trusted shell
 * (attribution UI + one iframe), so it is locked down hard: `script-src 'none'`
 * and `object-src 'none'` (v1 is script-free — deep-link sync is deferred,
 * #320 step 3 — so NO script executes on the chrome origin, not even
 * same-origin; `default-src 'self'` alone would permit that), and the only
 * framing permitted is the content origin. `frame-ancestors 'self'` refuses to
 * be embedded by anyone (the shell has no legitimate embedder — anti-
 * clickjacking); `base-uri 'none'` and `form-action 'self'` close the usual
 * escapes.
 *
 * `relax` is the {@link AppOptions.relaxContentCsp} STOPGAP: it widens ONLY
 * the framing grants (`frame-src`/`child-src`) with `https://web.archive.org`,
 * so an in-frame navigation to an un-localized archive URL renders instead of
 * blanking the iframe. The lockdown itself — `script-src 'none'`,
 * `object-src 'none'`, `frame-ancestors 'self'`, `base-uri 'none'`,
 * `form-action 'self'` — is never touched, relax or not.
 */
function chromeCsp(contentOrigin: string, relax = false): string {
  const frameTargets = relax ? `${contentOrigin} https://web.archive.org` : contentOrigin;
  return [
    "default-src 'self'",
    "script-src 'none'",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `frame-src ${frameTargets}`,
    `child-src ${frameTargets}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ');
}

/**
 * The iframe sandbox tokens (#320 step 2), EXACT and deliberate:
 * `allow-scripts allow-same-origin allow-forms allow-popups`, and pointedly
 * NOT `allow-top-navigation` — without that token, the framebuster scripts
 * ubiquitous in 2000s captures (`top.location = self.location`) silently fail.
 * The `allow-scripts`+`allow-same-origin` pair is safe here because the embed
 * is CROSS-origin (the MDN sandbox-escape warning is same-origin only), and it
 * keeps captures on their real sacrificial origin rather than an opaque one
 * that breaks legacy storage APIs.
 */
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

/**
 * A bare host authority — `host[:port]`, or a bracketed IPv6 literal with an
 * optional port. Deliberately strict: it accepts DNS names (incl. IDN
 * punycode `xn--…`) and IPs, and REJECTS anything that could smuggle a second
 * CSP directive or an extra origin when the host is interpolated into a policy
 * — whitespace, `;`, `,`, `*`, `/`, `@`, a scheme, a path (MAJOR: split config
 * flows into `frame-ancestors`/`frame-src` and the iframe `src`).
 */
const SPLIT_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;
const SPLIT_IPV6_RE = /^\[[0-9a-f:]+\](?::\d{1,5})?$/i;

/**
 * Validate a SplitOptions before it can shape any security header. Returns an
 * error string (for a caller to surface cleanly) or `null` when valid. Three
 * classes of misconfiguration are fatal, not cosmetic:
 *   1. scheme other than http/https, or a host that is not a bare authority
 *      (empty string included) — either would let a malformed config
 *      inject/terminate a CSP directive.
 *   2. a host the regex admits but the URL parser rejects (an out-of-range
 *      port, malformed IPv6) — caught so the caller gets the error STRING, not
 *      a raw `new URL` TypeError.
 *   3. chrome and content resolving to the SAME origin — that collapses the
 *      Host-routing boundary and serves capture bytes on the chrome origin,
 *      exactly what #320 forbids (default ports are canonicalized first, so
 *      `h` and `h:443`/https are correctly seen as identical).
 */
export function validateSplit(split: SplitOptions): string | null {
  const scheme = split.scheme ?? 'https';
  if (scheme !== 'http' && scheme !== 'https') {
    return `split scheme must be "http" or "https", got ${JSON.stringify(scheme)}`;
  }
  const canon = (host: string): string => new URL(`${scheme}://${host}`).host.toLowerCase();
  const authorities: Record<'chromeHost' | 'contentHost', string> = { chromeHost: '', contentHost: '' };
  for (const [label, host] of [['chromeHost', split.chromeHost], ['contentHost', split.contentHost]] as const) {
    if (typeof host !== 'string' || (!SPLIT_HOST_RE.test(host) && !SPLIT_IPV6_RE.test(host))) {
      return `split ${label} must be a bare host[:port], got ${JSON.stringify(host)}`;
    }
    try {
      authorities[label] = canon(host);
    } catch {
      // The regex admitted it (e.g. `:99999`, `[:::]`) but URL parsing did not.
      return `split ${label} must be a bare host[:port], got ${JSON.stringify(host)}`;
    }
  }
  if (authorities.chromeHost === authorities.contentHost) {
    return `split chromeHost and contentHost resolve to the same origin (${authorities.chromeHost}); they must differ, or the chrome origin would serve capture bytes`;
  }
  return null;
}

/** Short month names for {@link shortDate}. */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a wayback timestamp (`YYYYMMDDHHMMSS`, or any `YYYYMMDD…` prefix) as a
 * short human date — `20090226220257` → `Feb 26 2009`. Falls back to the raw
 * timestamp if it lacks a full, in-range `YYYYMMDD` prefix (the shell shows
 * SOMETHING rather than a blank). Pure digits/month-names out, so it needs no
 * escaping — the caller still escapes it, no exceptions.
 */
function shortDate(ts: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(ts);
  if (!m) return ts;
  const month = MONTHS_SHORT[Number(m[2]) - 1];
  if (!month) return ts;
  return `${month} ${Number(m[3])} ${m[1]}`;
}

/**
 * The mirror-wide disclaimer footer (raw HTML — TRUSTED, hardcoded, carries an
 * `<a>`, like the ServedCopy fragments). The `•` (U+2022) separates the two
 * clauses. Shared by the chrome shell and the /_index page so the attribution
 * reads identically wherever it appears.
 */
const MIRROR_DISCLAIMER =
  '<span class="clause">NOT affiliated with the Internet Archive</span>' +
  '<span class="sep"> • </span>' +
  '<span class="clause">Mirror generated by <a href="https://autocache.dev" rel="noreferrer">autocache.dev</a></span>';

/**
 * Render the chrome shell for a capture request: the attribution chrome (#320
 * now owns ALL visible attribution — the capture link, provenance, and the
 * archive.org credit) wrapping a sandboxed cross-origin iframe that points at
 * the content origin. Everything interpolated from the request is HTML-escaped
 * (escapeHtml) — the capture URL is attacker-controlled.
 */
function renderChromeShell(args: {
  iframeSrc: string;
  originalUrl: string;
  timestamp: string;
  canonicalArchiveUrl: string;
  chromeHost: string;
}): string {
  const src = escapeHtml(args.iframeSrc);
  const original = escapeHtml(args.originalUrl);
  const ts = escapeHtml(args.timestamp);
  const date = escapeHtml(shortDate(args.timestamp));
  const archive = escapeHtml(args.canonicalArchiveUrl);
  // The chrome shell is always served on the chrome host; escape it too (the
  // caller passes the configured chromeHost, but every host interpolated into
  // served HTML goes through escapeHtml, no exceptions).
  const chromeHost = escapeHtml(args.chromeHost);
  const title = `${original} — archived ${ts}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${original} · ${chromeHost} · web.archive.org mirror</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font: 14px/1.5 system-ui, sans-serif; }
  header { padding: 0.5rem 1rem; text-align: center; background: #333; color: #fff; }
  header a { color: #8ab4f8; }
  iframe { flex: 1 1 auto; width: 100%; border: 0; }
  footer { padding: 0.5rem 1rem; text-align: center; background: #333; color: #fff; }
  footer a { color: #8ab4f8; }
  /* Mobile: each • clause becomes its own line (the • is hidden — it IS the
     break), the long URL truncates to one line with an ellipsis, smaller font.
     Pure CSS — the chrome origin runs under script-src 'none'. */
  @media (max-width: 480px) {
    header, footer { font-size: 12px; padding: 0.4rem 0.6rem; }
    .clause { display: flex; justify-content: center; gap: 0.3em; white-space: nowrap; max-width: 100%; }
    .sep { display: none; }
    .url { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  }
</style>
</head>
<body>
<header>
  <span class="clause">Unofficial Mirror of <a class="url" href="${archive}" title="${original}" rel="noreferrer">${original}</a> from ${date}</span><span class="sep"> • </span><span class="clause"><a href="https://archive.org/donate/" rel="noreferrer">Donate</a> to keep knowledge free</span>
</header>
<iframe src="${src}" title="${title}" sandbox="${IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>
<footer>${MIRROR_DISCLAIMER}</footer>
</body>
</html>
`;
}

/**
 * The styled local 404, served `no-store` under a document CSP. THE strict
 * answer to a miss: an honest local page, no bounce to live web.archive.org.
 * The CSP is a parameter because a content-origin miss is rendered INSIDE the
 * chrome iframe (#320) and so must carry the same `frame-ancestors` policy its
 * sibling hits do; a top-level miss carries the plain document CSP. `cspMode`
 * selects the header name for that document policy (design §D3).
 */
function notFound(c: Context, mirrorHost: string, about: string, documentCsp: string = DOCUMENT_CSP, cspMode: CspMode = 'enforce', archiveUrl?: string): Response {
  c.header('Cache-Control', NO_STORE);
  setCsp(c, documentCsp, cspMode);
  return c.html(notFoundHtml(mirrorHost, about, archiveUrl), 404);
}

/**
 * Build the app around a Store. Exported as a factory (not a singleton)
 * because each runtime entry owns constructing its store from its own
 * binding model — and because tests want a fresh app per store fixture.
 */
export function createApp(store: Store, options: AppOptions = {}): Hono {
  const liveFallback = options.liveFallback ?? false;
  const cspMode = options.cspMode ?? 'enforce';
  const relaxContentCsp = options.relaxContentCsp ?? false;
  const localize = options.localize;
  const split = options.split;
  // The per-deployment served-page description copy (#453): resolve each
  // fragment to its site value or the generic default ONCE. RAW HTML by
  // contract (TRUSTED site config carrying <a> links) — see ServedCopy.
  const indexAbout = options.copy?.index ?? DEFAULT_INDEX_ABOUT;
  const notFoundAbout = options.copy?.notFound ?? DEFAULT_NOT_FOUND_ABOUT;
  const indexKeys = options.indexKeys;
  const indexRequisites = options.indexRequisites;
  const log = options.logger ?? NOOP_EDGE_LOGGER;
  const app = new Hono();

  // A misconfigured split must fail LOUD, never silently serve bytes on the
  // wrong origin: reject a bad scheme/host or a chrome≡content collapse before
  // building the app (the runtime entries validate too, for a clean CLI/deploy
  // error; this is the library backstop).
  //
  // PRESENCE, not truthiness (#320). ONLY `split === undefined` means "no split
  // — single-host". ANY other supplied value means a split WAS configured and
  // MUST validate. TypeScript says `SplitOptions | undefined`, but runtime
  // callers (node.ts, fastly.ts) forward the value unchanged, so a present-but-
  // FALSY value (`null`, `false`, `0`, `""`) — or any non-object — can reach
  // here; it MUST throw, never fall through to single-host, which would serve
  // capture bytes first-party on the trusted chrome origin. `hasSplit` (an
  // aliased `!== undefined`) then drives EVERY split-gating branch below in
  // lockstep, so routing and every derived CSP/origin agree on one notion of
  // "split present" — a present-but-invalid split NEVER reaches single-host.
  const hasSplit = split !== undefined;
  // Snapshot the split's three fields into ONE local, reading each source field
  // EXACTLY once, then drive validation AND all routing/CSP derivation from the
  // snapshot — never read `split.*` again. This defeats a validate-then-reread
  // (TOCTOU) attack: a stateful/proxy accessor could pass validateSplit on its
  // first read and return a boundary-collapsing value on the later routing read
  // (e.g. a `contentHost` getter yielding `content.example` then the chrome
  // host), which would make `contentAuthority === chromeAuthority` and let
  // `roleOf` classify the TRUSTED chrome host as `content` and serve capture
  // bytes. With a frozen snapshot the caller's object is consulted exactly once,
  // so no accessor can diverge between check and use.
  let splitCfg: SplitOptions | undefined;
  if (hasSplit) {
    // Guard the non-object/null case (cast through unknown — the declared type
    // excludes them, but the runtime doesn't) BEFORE reading fields, which would
    // crash on `null`/a primitive.
    const candidate = split as unknown;
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error(`invalid AppOptions.split: must be a SplitOptions object, got ${JSON.stringify(split) ?? String(split)}`);
    }
    // The ONLY reads of the caller's object: each source field, once, here.
    const src = split as SplitOptions;
    splitCfg = { chromeHost: src.chromeHost, contentHost: src.contentHost, scheme: src.scheme };
    const err = validateSplit(splitCfg);
    if (err) throw new Error(`invalid AppOptions.split: ${err}`);
  }

  // Precompute the split's derived strings once (they never change per
  // request). Authorities are CANONICAL (`new URL().host`: lowercased, default
  // ports dropped) so routing compares full `host[:port]` authorities EXACTLY
  // — no port stripping, which would collapse two distinct origins on one
  // hostname and cross the boundary. `contentDocumentCsp` is the standalone
  // document CSP with `frame-ancestors` merged in — one header (#320 recipe
  // step 1); `chromeCspValue` locks down the chrome origin's own shell.
  const scheme = splitCfg?.scheme ?? 'https';
  const canonHost = (host: string): string => new URL(`${scheme}://${host}`).host.toLowerCase();
  const chromeAuthority = splitCfg ? canonHost(splitCfg.chromeHost) : '';
  const contentAuthority = splitCfg ? canonHost(splitCfg.contentHost) : '';
  const chromeOrigin = hasSplit ? `${scheme}://${chromeAuthority}` : '';
  const contentOrigin = hasSplit ? `${scheme}://${contentAuthority}` : '';
  // The document CSP this app stamps — the strict DOCUMENT_CSP, or its
  // archive-widened STOPGAP variant under relaxContentCsp. The relaxation
  // happens HERE, before the frame-ancestors merge below, so it can only ever
  // touch the resource-loading directive values — never the framing contract.
  const documentCsp = relaxContentCsp ? relaxedDocumentCsp() : DOCUMENT_CSP;
  // ONLY the chrome origin may frame content — NOT `'self'`. Granting `'self'`
  // would let one content capture frame another within the sacrificial origin
  // (a content page could embed a sibling capture), an over-grant the boundary
  // does not need. The chrome shell is the sole legitimate embedder.
  const contentDocumentCsp = hasSplit
    ? `${documentCsp}; frame-ancestors ${chromeOrigin}`
    : documentCsp;
  const chromeCspValue = hasSplit ? chromeCsp(contentOrigin, relaxContentCsp) : '';

  // The role of an incoming request under the split (#320): `content` only when
  // its Host authority EXACTLY equals the content authority — an ALLOWLIST —
  // else `chrome` (the chrome host, or anything unrecognized: fail-closed to
  // the byte-free shell). `single` when the split is off. Routing AND the CSP
  // both key off this so they can never disagree.
  const roleOf = (url: URL): 'content' | 'chrome' | 'single' => {
    if (!hasSplit) return 'single';
    return url.host.toLowerCase() === contentAuthority ? 'content' : 'chrome';
  };

  // The host DISPLAYED in the served chrome pages (index, 404, capture shell) —
  // the mirror's identity to the reader, distinct from routing (roleOf keys off
  // the URL authority). Under the split it is ALWAYS the configured chrome host
  // (the mirror's canonical identity — even a content-origin miss names it); in
  // single-host mode it is the request's own Host header, which is
  // ATTACKER-CONTROLLABLE, so EVERY interpolation of this value into served HTML
  // MUST pass through escapeHtml (notFoundHtml/indexHtml/renderChromeShell do).
  const mirrorHostOf = (c: Context): string =>
    splitCfg ? splitCfg.chromeHost : (c.req.header('host') ?? '');

  // A capture we cannot serve locally (a store miss, or an archived-redirect
  // entry with no local body): strict answers a local 404, liveFallback bounces
  // to the archive's replay. The 302 is flag-preserving (archiveUrl, not
  // canonicalArchiveUrl) so `if_`/`im_`-framed asset requests keep their replay
  // semantics on the other side. Either way, `no-store` — nothing here is
  // cacheable. `documentCsp` threads the (possibly frame-ancestors-bearing)
  // CSP through to the local 404 the miss falls back to; `mode` is its header
  // posture (enforced for the content-host boundary policy — see serveContent).
  const liveOr404 = (c: Context, archiveUrl: string, documentCsp: string, mode: CspMode): Response => {
    if (liveFallback) {
      c.header('Cache-Control', NO_STORE);
      // headerSafe: Location is a header too — a decode-fallback identity can
      // carry bytes a ByteString cannot (see headerSafe); ASCII values (every
      // pre-fallback redirect) pass through byte-identical.
      return c.redirect(headerSafe(archiveUrl), 302);
    }
    // Strict: a local 404 that ALSO hands off to the archive — `archiveUrl`
    // names the wayback URL this uncaptured capture lives at, so the miss page
    // can offer an explicit new-tab link to the Internet Archive (a capture
    // miss always has one; the generic /index 404s that call notFound directly
    // pass none and stay link-free).
    return notFound(c, mirrorHostOf(c), notFoundAbout, documentCsp, mode, archiveUrl);
  };

  // The content-serving path: store lookup, status discrimination, the hit
  // headers, and the serve-time HTML strip. `documentCsp` is the CSP stamped
  // on responses — plain in single-host mode, frame-ancestors-bearing on the
  // content host under the split. `stampAll` decides WHICH responses carry it:
  // in split/content mode EVERY content response carries `frame-ancestors`
  // (#320 recipe step 1 is origin-wide — a PDF or browser-image document is
  // framable too, and a CSP on an inert image/font subresource is harmless
  // because document policies are not enforced on subresources); single-host
  // mode keeps the pre-#320 posture EXACTLY — the standalone CSP on `text/html`
  // only, so the #292 deployment is byte-identical. This is the ONLY code that
  // reaches the store or emits capture bytes.
  // `alt` is the DECODE-FALLBACK candidate (see the `*` route): the same
  // request re-parsed with formatCapturePath's escape set decoded. Tried ONLY
  // when the raw key misses, so every request that resolves today resolves to
  // the same capture tomorrow — the fallback turns misses into hits, never a
  // hit into a different hit. (Corner: if a corpus holds BOTH byte-variants of
  // one URL — `…/a b` AND `…/a%20b` — the raw key wins and shadows the
  // decoded one; raw-first is the order that cannot regress existing links.)
  const serveContent = async (c: Context, rawParsed: NonNullable<ReturnType<typeof parseWaybackPath>>, documentCsp: string, stampAll: boolean, alt: ReturnType<typeof parseWaybackPath> = null): Promise<Response> => {
    // The content-host security policy (`contentDocumentCsp` — the egress-lock
    // + `frame-ancestors`) is a hostile-content boundary, so it is ALWAYS
    // emitted as enforced `Content-Security-Policy`, exactly like the chrome
    // lockdown: report-only on a hostile-content egress boundary is log-only =
    // a full bypass. `cspMode` governs ONLY the plain single-host `DOCUMENT_CSP`
    // (the non-boundary document policy). `stampAll` is true exactly in
    // split/content mode, so it discriminates the boundary policy from the
    // plain one.
    const documentCspMode: CspMode = stampAll ? 'enforce' : cspMode;
    const lookup = (key: string) => c.req.method === 'HEAD' ? store.head(key) : store.get(key);
    // Raw key first — today's behavior, byte-for-byte. Only a raw MISS
    // consults the decoded candidate; when that hits, `parsed` becomes the
    // decoded identity so every downstream field (key, archiveUrl,
    // X-Wayback-Source) names the capture actually served.
    let parsed = rawParsed;
    let capture = await lookup(parsed.key);
    if (capture === null && alt !== null) {
      const altCapture = await lookup(alt.key);
      if (altCapture !== null) {
        parsed = alt;
        capture = altCapture;
      }
    }
    // MISS → strict local 404 (or the opt-in live fallback). Notable at the
    // edge: it names a capture the mirror could not serve (§9).
    if (capture === null) {
      log.warn({ evt: 'miss', key: parsed.key }, 'corpus miss');
      return liveOr404(c, parsed.archiveUrl, documentCsp, documentCspMode);
    }

    // `body`). `redirect`, `error`, and `interstitial` entries are COMPLETE
    // captures with no local body to serve — the store answered, but there is
    // nothing here to hand a browser:
    //   redirect     → the capture is an archived redirect. We hold no target,
    //                  and strict refuses to bounce to live; a local 404 is the
    //                  honest answer (liveFallback replays it at the archive).
    //   interstitial → we refused to store a wayback fluff page (#363: a
    //                  wrapper stub / redirect interstitial / raw-asset-as-html
    //                  / archived-error capture). We hold no servable content,
    //                  so strict answers a local 404; liveFallback bounces to
    //                  the archive rather than serve the junk — the same
    //                  graceful-degradation path a miss takes.
    //   error        → the archive permanently lacks this asset (recorded at
    //                  population time so it is never re-fetched); always a
    //                  local 404, never a bounce — the archive would only 404
    //                  too.
    const status = capture.status ?? 'body';
    if (status === 'redirect' || status === 'interstitial') {
      log.warn({ evt: 'bodiless', key: parsed.key, status }, 'bodiless capture — no local body to serve');
      return liveOr404(c, parsed.archiveUrl, documentCsp, documentCspMode);
    }
    if (status === 'error') {
      log.warn({ evt: 'bodiless', key: parsed.key, status: 'error' }, 'archived error capture — no body');
      return notFound(c, mirrorHostOf(c), notFoundAbout, documentCsp, documentCspMode, parsed.archiveUrl);
    }

    // Normalize the media type ONCE: trim leading/trailing HTTP optional
    // whitespace so classification agrees with what the browser sees. A stored
    // `" text/html"` would otherwise slip past a `^text/html` test yet reach
    // the browser as executable `text/html` (Headers strips the OWS) — and thus
    // WITHOUT its CSP. Emit the same normalized value we classify on.
    const contentType = (capture.contentType || '').trim();
    c.header('Content-Type', contentType || 'application/octet-stream');
    c.header('Cache-Control', HIT_CACHE_CONTROL);
    // Provenance header on every hit — where this body actually came from.
    // Invisible to the page; visible attribution is #320's chrome.
    c.header('X-Wayback-Source', headerSafe(parsed.canonicalArchiveUrl));

    // The document CSP — the browser enforces same-origin fetches on references
    // no rewriter caught, and (under the split) `frame-ancestors` so only the
    // chrome host may frame the content origin. `stampAll` (split/content mode)
    // stamps EVERY response so the content origin's framing contract is
    // origin-wide (#320 step 1); single-host mode keeps the pre-#320 posture:
    // `text/html` only. Set regardless of body presence (HEAD, `empty`) so the
    // header posture is uniform, under the header name `cspMode` selects. The
    // serve-time chrome strip stays text/html-only (byte surgery on wayback's
    // HTML injection).
    const isHtml = /^text\/html\b/i.test(contentType);
    if (stampAll || isHtml) setCsp(c, documentCsp, documentCspMode);

    // No body to send: a HEAD answer (store.head() spared us the body read
    // entirely) or an `empty` entry (a real archived 200 with zero bytes —
    // served as exactly that).
    if (!('body' in capture)) return c.body(null);

    // Read the body to a UTF-8 text — done lazily, only on the chrome-strip
    // path; a byte-for-byte passthrough never reads it. This path preserves the
    // pre-localize byte behavior exactly (html was already UTF-8 round-tripped
    // through stripWaybackChrome), so it MUST stay UTF-8.
    const bodyText = (): Promise<string> =>
      typeof capture.body === 'string'
        ? Promise.resolve(capture.body)
        : new Response(capture.body as ReadableStream<Uint8Array>).text();

    // Read the body to a LATIN1 string — the lossless byte↔char mapping the
    // localize path needs (see the rationale on the `if (localize)` branch).
    // Web-standard only (edge-portable): latin1 is a 1:1 byte→codepoint map, so
    // decode with chunked String.fromCharCode rather than TextDecoder (whose
    // `encoding` label type is narrowed to utf-8 in some type worlds) — no
    // node:Buffer, no UTF-8 assumption. The chunk cap keeps the spread arg small.
    const bodyLatin1 = async (): Promise<string> => {
      if (typeof capture.body === 'string') return capture.body;
      const bytes = capture.body instanceof Uint8Array
        ? capture.body
        : new Uint8Array(await new Response(capture.body as ReadableStream<Uint8Array>).arrayBuffer());
      let out = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return out;
    };

    // Serve-time localization (design §D3): with a corpus to localize against,
    // rewrite the wayback references we can satisfy to root-relative form. For
    // a text dialect this REPLACES the passthrough/strip below — rewrite()
    // strips the chrome internally for html, so it is NOT stripped again here
    // (no double strip); css/js, which pass through untouched without localize,
    // are localized here. Binary/unknown dialects fall through to the
    // byte-for-byte passthrough.
    //
    // LATIN1, NOT UTF-8. rewrite() (waybackify/rewrite.js) is a pure string
    // transform whose only mutations are ASCII wayback refs; the sibling
    // consumer remaster.js runs it over a LOSSLESS byte↔char latin1 mapping
    // precisely because captures are arbitrary bytes (ISO-8859-1 pages, a UTF-8
    // BOM, binary-ish JS) that a UTF-8 round-trip would corrupt — a latin1 byte
    // ≥0x80 or a BOM would come back as U+FFFD / be stripped even when the
    // corpus changes nothing. So decode/encode latin1 here, edge-portably (no
    // node:Buffer): the unchanged case is byte-exact, matching remaster.js.
    if (localize) {
      const dialect = classifyContentType(contentType);
      if (dialect !== null) {
        const { text } = rewrite(contentType, await bodyLatin1(), localize);
        return c.body(Uint8Array.from(text, ch => ch.charCodeAt(0) & 0xff));
      }
    }

    // HTML captures get the serve-time chrome strip (src/html.ts); everything
    // else (images, stylesheets, decade-old .swf files...) passes through
    // untouched.
    if (isHtml) {
      return c.body(stripWaybackChrome(await bodyText()));
    }

    // The cast collapses Capture's body union onto Hono's Data union —
    // identical at runtime, but Hono spells Uint8Array more narrowly.
    return c.body(capture.body as string | ArrayBuffer | ReadableStream);
  };

  // The chrome shell for a capture request (#320): the attribution UI + a
  // sandboxed cross-origin iframe pointing at the content origin. This path
  // NEVER touches the store and emits NO capture bytes — it is derived purely
  // from the request URL, so a not-yet-mirrored capture simply shows a shell
  // whose iframe 404s inside (v1 accepts "URL = entry capture"; #320 step 3).
  // `no-store`: the shell is cheap to rebuild and we deliberately did not check
  // whether the capture exists, so nothing is worth caching under this URL.
  const chromeShell = (c: Context, url: URL, parsed: NonNullable<ReturnType<typeof parseWaybackPath>>): Response => {
    // The iframe src is the SAME path on the content origin — a pure host swap,
    // exactly the wayback URL shape the mirror already preserves.
    const iframeSrc = `${contentOrigin}${url.pathname}${url.search}`;
    // The chrome origin's lockdown CSP is ALWAYS enforced — a `script-src
    // 'none'` trusted-shell lockdown must never be merely report-only, so it
    // does NOT ride cspMode.
    c.header('Content-Security-Policy', chromeCspValue);
    c.header('Cache-Control', NO_STORE);
    c.header('Content-Type', 'text/html; charset=utf-8');
    if (c.req.method === 'HEAD') return c.body(null);
    return c.body(renderChromeShell({
      iframeSrc,
      originalUrl: parsed.originalUrl,
      timestamp: parsed.timestamp,
      canonicalArchiveUrl: parsed.canonicalArchiveUrl,
      // The chrome shell is only reached on the chrome host (roleOf === 'chrome'),
      // so mirrorHostOf(c) is the configured chrome host here.
      chromeHost: mirrorHostOf(c)
    }));
  };

  // The index page — but only where OUR trusted UI belongs. The content origin
  // (#320) hosts nothing of ours, ever: a bare `/` there (reachable in-frame
  // via any archived site-relative link to the root) answers a content 404
  // under the frame-ancestors CSP, not our index. The chrome origin serves the
  // attribution landing under the locked chrome CSP; single-host serves it as
  // before.
  app.on(['GET', 'HEAD'], '/', c => {
    const role = roleOf(new URL(c.req.url));
    const mirrorHost = mirrorHostOf(c);
    // The content-host boundary policy is always enforced (see serveContent) —
    // never cspMode-governed report-only.
    if (role === 'content') return notFound(c, mirrorHost, notFoundAbout, contentDocumentCsp, 'enforce');
    if (role === 'chrome') {
      // The chrome origin's lockdown CSP is always enforced (see chromeShell).
      c.header('Content-Security-Policy', chromeCspValue);
      return c.html(indexHtml(mirrorHost, indexAbout));
    }
    return c.html(indexHtml(mirrorHost, indexAbout));
  });

  // The local-only cache index/search page. INERT unless `indexKeys` was
  // supplied — only the Node --root entry can enumerate a cache-root, so the
  // edge entries never set it and `/_index` there answers the same styled 404
  // any non-capture path gets (the null-parse shape below). Server-side
  // filtering, zero client script: the page renders under the same document
  // CSP as the rest of the mirror. `no-store` — the cache changes between
  // runs and the listing is an operator tool, not content.
  app.on(['GET', 'HEAD'], '/_index', c => {
    const url = new URL(c.req.url);
    const role = roleOf(url);
    if (!indexKeys) {
      // Edge safety: without the option, /_index does not exist. Mirror the
      // catch-all's null-parse 404 exactly, per-role.
      if (role === 'chrome') {
        c.header('Cache-Control', NO_STORE);
        c.header('Content-Security-Policy', chromeCspValue);
        return c.html(notFoundHtml(mirrorHostOf(c), notFoundAbout), 404);
      }
      return notFound(c, mirrorHostOf(c), notFoundAbout, role === 'content' ? contentDocumentCsp : documentCsp, role === 'content' ? 'enforce' : cspMode);
    }
    // The content origin (#320) hosts nothing of ours, EVER — the listing on
    // the sacrificial origin would leak the whole corpus map into the zone
    // hostile captures run in. A content-host /_index is a content 404 under
    // the always-enforced boundary CSP, exactly like `/` there.
    if (role === 'content') return notFound(c, mirrorHostOf(c), notFoundAbout, contentDocumentCsp, 'enforce');
    const q = url.searchParams.get('q') ?? '';
    // The "is requisite?" checkbox: presence of `req` in the query = checked
    // (an unchecked checkbox never submits its name — standard form-GET
    // semantics, no client script needed). Unchecked (the default) lists only
    // TOP-LEVEL captures — keys NOT in the requisite subset; checked flips to
    // REQUISITES only. With no `indexRequisites` supplied, every key is
    // top-level, so the default listing shows everything (pre-filter behavior).
    const showReq = url.searchParams.get('req') !== null;
    const isReq = (k: string): boolean => indexRequisites?.has(k) ?? false;
    const pool = [...indexKeys].filter(k => (showReq ? isReq(k) : !isReq(k)));
    const all = pool.sort();
    const hits = q ? all.filter(k => k.toLowerCase().includes(q.toLowerCase())) : all;
    const shown = hits.slice(0, 200);
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', NO_STORE);
    if (role === 'chrome') {
      // Our trusted UI on the chrome origin rides the LOCKED chrome CSP,
      // always enforced (never cspMode-governed) — the page is server-rendered
      // with zero <script>, so `script-src 'none'` holds, and `style-src
      // 'self' 'unsafe-inline'` covers its inline <style>.
      c.header('Content-Security-Policy', chromeCspValue);
    } else {
      // single-host: the plain document CSP under the configured posture.
      setCsp(c, documentCsp, cspMode);
    }
    if (c.req.method === 'HEAD') return c.body(null);
    return c.body(indexSearchHtml(mirrorHostOf(c), q, showReq, shown, hits.length));
  });

  app.on(['GET', 'HEAD'], '*', async c => {
    // Parse pathname + search as one string: the original URL's own query
    // string is part of the capture identity (`?displaylang=en&...` style
    // originals are all over the corpus), and Hono's router would eat it.
    const url = new URL(c.req.url);
    const role = roleOf(url);

    const rawPath = url.pathname + url.search;
    const parsed = parseWaybackPath(rawPath);
    if (parsed === null) {
      // A non-capture path. Its 404 must carry the CSP of the ORIGIN it lands
      // on: on the content host it may be rendered in-frame (archived pages
      // link to site-relative paths like `/about`), so it needs the
      // frame-ancestors policy; on the chrome host it is a top-level page under
      // the locked chrome CSP (always enforced — set directly, not via
      // notFound's cspMode-governed document CSP); single-host keeps the
      // standalone document CSP.
      if (role === 'chrome') {
        c.header('Cache-Control', NO_STORE);
        c.header('Content-Security-Policy', chromeCspValue);
        return c.html(notFoundHtml(mirrorHostOf(c), notFoundAbout), 404);
      }
      // The content-host boundary policy is always enforced (see serveContent);
      // the plain single-host document policy stays cspMode-governed.
      return notFound(c, mirrorHostOf(c), notFoundAbout, role === 'content' ? contentDocumentCsp : documentCsp, role === 'content' ? 'enforce' : cspMode);
    }

    // The chrome/content split (#320): capture bytes are served IFF the request
    // arrives on the CONTENT host (roleOf's allowlist). Every other host — the
    // chrome host, or anything unrecognized — gets the sandboxed iframe shell,
    // which never reaches the store, so a spoofed/unknown Host can never coax
    // bytes out of the chrome origin.
    // The chrome shell is a pure host swap of this same URL — the content
    // host does its own key resolution in-frame, so no fallback is needed here.
    if (role === 'chrome') return chromeShell(c, url, parsed);

    // The decode-fallback candidate (the serve side of the /_index link
    // round-trip): the SAME request string with formatCapturePath's escape
    // set decoded, re-parsed by the SAME parser. A key holding bytes a
    // request line cannot carry raw (`#`, space, `<`, quotes, Unicode, …) is
    // only dialable via its formatCapturePath href; decoding that escape set
    // — and ONLY that set — recovers the byte-exact key. `null` whenever the
    // request carries nothing to decode (the common case: decodeCapturePath
    // returns its input by identity), so the hot path pays nothing.
    const decodedPath = decodeCapturePath(rawPath);
    const alt = decodedPath === rawPath ? null : parseWaybackPath(decodedPath);
    // content mode stamps frame-ancestors on EVERY response; single-host keeps
    // the pre-#320 text/html-only posture.
    return serveContent(c, parsed, role === 'content' ? contentDocumentCsp : documentCsp, role === 'content', alt);
  });

  return app;
}
