/**
 * The wayback.charlie.dev Hono app (#249).
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
import { classifyContentType, rewrite } from '@charlie.dev/waybackify/rewrite.js';
import { stripWaybackChrome } from './html.ts';
import { parseWaybackPath } from './path.ts';
import type { Store } from './store.ts';

/** The two header names the standalone CSP can ride, per `cspMode`. */
type CspMode = 'enforce' | 'report-only';

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
const DOCUMENT_CSP = [
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
].join('; ');

/**
 * The styled local 404. Small, self-contained, zero external references (so
 * it renders under its own CSP and leaks nothing), served `no-store`. This is
 * what a corpus miss looks like now — an honest local answer, not a bounce to
 * live web.archive.org.
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not mirrored · wayback.charlie.dev</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  .muted { color: #666; }
</style>
</head>
<body>
<h1>Not mirrored here</h1>
<p>This mirror serves exactly the <a href="https://web.archive.org/">Wayback Machine</a>
captures that <a href="https://charlie.dev/">charlie.dev</a> posts reference. This
capture is not among them.</p>
<p class="muted">No request left this server for it. If you need the original,
it lives at <code>web.archive.org</code>.</p>
</body>
</html>
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wayback.charlie.dev</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
</style>
</head>
<body>
<h1>wayback.charlie.dev</h1>
<p>A self-hosted mirror of the <a href="https://web.archive.org/">Wayback Machine</a>
captures that <a href="https://charlie.dev/">charlie.dev</a> posts reference —
exactly those, nothing more. It exists because archive.org replay is slow and
occasionally down, and these links are load-bearing for decade-old posts.</p>
<p>URLs mirror the wayback shape:
<code>/&lt;timestamp&gt;/&lt;original-url&gt;</code>. Captures not mirrored here
answer a local 404 — the mirror serves what it holds and nothing else.</p>
<p>All mirrored content is the Internet Archive's work. Consider
<a href="https://archive.org/donate/">donating to the Internet Archive</a>.</p>
</body>
</html>
`;

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
   * Chrome origin host (e.g. `wayback.charlie.dev`) — attribution UI, routing,
   * the iframe shell. Requests here serve NO capture bytes, ever.
   */
  chromeHost: string;
  /**
   * Content origin host (e.g. `wayback.charlie.webring.delivery`) — the
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
   * The chrome/content split (#320). When set, serving is Host-keyed: the
   * chrome host gets the iframe shell (no store access), the content host gets
   * capture bytes + the `frame-ancestors` CSP. When absent, the app is
   * single-host — byte-identical to pre-#320 behavior. Threaded from each
   * runtime entry's own config (serve.js `--chrome-host`/`--content-host`, the
   * edge entries' env/config constants).
   */
  split?: SplitOptions;
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
 * The chrome host's own CSP. The chrome origin serves only OUR trusted shell
 * (attribution UI + one iframe), so it is locked down hard: `script-src 'none'`
 * and `object-src 'none'` (v1 is script-free — deep-link sync is deferred,
 * #320 step 3 — so NO script executes on the chrome origin, not even
 * same-origin; `default-src 'self'` alone would permit that), and the only
 * framing permitted is the content origin. `frame-ancestors 'self'` refuses to
 * be embedded by anyone (the shell has no legitimate embedder — anti-
 * clickjacking); `base-uri 'none'` and `form-action 'self'` close the usual
 * escapes.
 */
function chromeCsp(contentOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'none'",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `frame-src ${contentOrigin}`,
    `child-src ${contentOrigin}`,
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
}): string {
  const src = escapeHtml(args.iframeSrc);
  const original = escapeHtml(args.originalUrl);
  const ts = escapeHtml(args.timestamp);
  const archive = escapeHtml(args.canonicalArchiveUrl);
  const title = `${original} — archived ${ts}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${original} · wayback.charlie.dev</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font: 14px/1.5 system-ui, sans-serif; color: #222; }
  header { padding: 0.5rem 1rem; border-bottom: 1px solid #ddd; background: #fafafa; }
  header a { color: #06c; }
  .muted { color: #666; }
  iframe { flex: 1 1 auto; width: 100%; border: 0; }
</style>
</head>
<body>
<header>
  <span>Archived mirror of <a href="${archive}" rel="noreferrer">${original}</a></span>
  <span class="muted"> — captured ${ts}. The <a href="https://web.archive.org/" rel="noreferrer">Internet Archive</a> did the work; consider <a href="https://archive.org/donate/" rel="noreferrer">donating</a>.</span>
</header>
<iframe src="${src}" title="${title}" sandbox="${IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>
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
function notFound(c: Context, documentCsp: string = DOCUMENT_CSP, cspMode: CspMode = 'enforce'): Response {
  c.header('Cache-Control', NO_STORE);
  setCsp(c, documentCsp, cspMode);
  return c.html(NOT_FOUND_HTML, 404);
}

/**
 * Build the app around a Store. Exported as a factory (not a singleton)
 * because each runtime entry owns constructing its store from its own
 * binding model — and because tests want a fresh app per store fixture.
 */
export function createApp(store: Store, options: AppOptions = {}): Hono {
  const liveFallback = options.liveFallback ?? false;
  const cspMode = options.cspMode ?? 'enforce';
  const localize = options.localize;
  const split = options.split;
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
  // ONLY the chrome origin may frame content — NOT `'self'`. Granting `'self'`
  // would let one content capture frame another within the sacrificial origin
  // (a content page could embed a sibling capture), an over-grant the boundary
  // does not need. The chrome shell is the sole legitimate embedder.
  const contentDocumentCsp = hasSplit
    ? `${DOCUMENT_CSP}; frame-ancestors ${chromeOrigin}`
    : DOCUMENT_CSP;
  const chromeCspValue = hasSplit ? chromeCsp(contentOrigin) : '';

  // The role of an incoming request under the split (#320): `content` only when
  // its Host authority EXACTLY equals the content authority — an ALLOWLIST —
  // else `chrome` (the chrome host, or anything unrecognized: fail-closed to
  // the byte-free shell). `single` when the split is off. Routing AND the CSP
  // both key off this so they can never disagree.
  const roleOf = (url: URL): 'content' | 'chrome' | 'single' => {
    if (!hasSplit) return 'single';
    return url.host.toLowerCase() === contentAuthority ? 'content' : 'chrome';
  };

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
      return c.redirect(archiveUrl, 302);
    }
    return notFound(c, documentCsp, mode);
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
  const serveContent = async (c: Context, parsed: NonNullable<ReturnType<typeof parseWaybackPath>>, documentCsp: string, stampAll: boolean): Promise<Response> => {
    // The content-host security policy (`contentDocumentCsp` — the egress-lock
    // + `frame-ancestors`) is a hostile-content boundary, so it is ALWAYS
    // emitted as enforced `Content-Security-Policy`, exactly like the chrome
    // lockdown: report-only on a hostile-content egress boundary is log-only =
    // a full bypass. `cspMode` governs ONLY the plain single-host `DOCUMENT_CSP`
    // (the non-boundary document policy). `stampAll` is true exactly in
    // split/content mode, so it discriminates the boundary policy from the
    // plain one.
    const documentCspMode: CspMode = stampAll ? 'enforce' : cspMode;
    const capture = c.req.method === 'HEAD'
      ? await store.head(parsed.key)
      : await store.get(parsed.key);
    // MISS → strict local 404 (or the opt-in live fallback).
    if (capture === null) {
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
      return liveOr404(c, parsed.archiveUrl, documentCsp, documentCspMode);
    }
    if (status === 'error') {
      return notFound(c, documentCsp, documentCspMode);
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
    c.header('X-Wayback-Source', parsed.canonicalArchiveUrl);

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
      canonicalArchiveUrl: parsed.canonicalArchiveUrl
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
    // The content-host boundary policy is always enforced (see serveContent) —
    // never cspMode-governed report-only.
    if (role === 'content') return notFound(c, contentDocumentCsp, 'enforce');
    if (role === 'chrome') {
      // The chrome origin's lockdown CSP is always enforced (see chromeShell).
      c.header('Content-Security-Policy', chromeCspValue);
      return c.html(INDEX_HTML);
    }
    return c.html(INDEX_HTML);
  });

  app.on(['GET', 'HEAD'], '*', async c => {
    // Parse pathname + search as one string: the original URL's own query
    // string is part of the capture identity (`?displaylang=en&...` style
    // originals are all over the corpus), and Hono's router would eat it.
    const url = new URL(c.req.url);
    const role = roleOf(url);

    const parsed = parseWaybackPath(url.pathname + url.search);
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
        return c.html(NOT_FOUND_HTML, 404);
      }
      // The content-host boundary policy is always enforced (see serveContent);
      // the plain single-host document policy stays cspMode-governed.
      return notFound(c, role === 'content' ? contentDocumentCsp : DOCUMENT_CSP, role === 'content' ? 'enforce' : cspMode);
    }

    // The chrome/content split (#320): capture bytes are served IFF the request
    // arrives on the CONTENT host (roleOf's allowlist). Every other host — the
    // chrome host, or anything unrecognized — gets the sandboxed iframe shell,
    // which never reaches the store, so a spoofed/unknown Host can never coax
    // bytes out of the chrome origin.
    if (role === 'chrome') return chromeShell(c, url, parsed);
    // content mode stamps frame-ancestors on EVERY response; single-host keeps
    // the pre-#320 text/html-only posture.
    return serveContent(c, parsed, role === 'content' ? contentDocumentCsp : DOCUMENT_CSP, role === 'content');
  });

  return app;
}
