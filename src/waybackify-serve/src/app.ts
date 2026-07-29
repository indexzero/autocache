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
  "frame-src 'self'"
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
   * posture for staging a stricter policy without breaking pages. Applied at
   * both CSP call sites (the HTML hit and the 404).
   */
  cspMode?: CspMode;
}

/**
 * Emit the standalone CSP under the header name `mode` selects — the ONE place
 * the header name is chosen, so the HTML-hit branch and the 404 always agree.
 */
function setCsp(c: Context, mode: CspMode): void {
  c.header(mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', DOCUMENT_CSP);
}

/**
 * The styled local 404, served `no-store` under its own CSP. THE strict answer
 * to a miss: an honest local page, no bounce to live web.archive.org.
 */
function notFound(c: Context, cspMode: CspMode): Response {
  c.header('Cache-Control', NO_STORE);
  setCsp(c, cspMode);
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
  const app = new Hono();

  // A capture we cannot serve locally (a store miss, or an archived-redirect
  // entry with no local body): strict answers a local 404, liveFallback bounces
  // to the archive's replay. The 302 is flag-preserving (archiveUrl, not
  // canonicalArchiveUrl) so `if_`/`im_`-framed asset requests keep their replay
  // semantics on the other side. Either way, `no-store` — nothing here is
  // cacheable.
  const liveOr404 = (c: Context, archiveUrl: string): Response => {
    if (liveFallback) {
      c.header('Cache-Control', NO_STORE);
      return c.redirect(archiveUrl, 302);
    }
    return notFound(c, cspMode);
  };

  app.on(['GET', 'HEAD'], '/', c => c.html(INDEX_HTML));

  app.on(['GET', 'HEAD'], '*', async c => {
    // Parse pathname + search as one string: the original URL's own query
    // string is part of the capture identity (`?displaylang=en&...` style
    // originals are all over the corpus), and Hono's router would eat it.
    const url = new URL(c.req.url);
    const parsed = parseWaybackPath(url.pathname + url.search);
    if (parsed === null) {
      return notFound(c, cspMode);
    }

    const capture = c.req.method === 'HEAD'
      ? await store.head(parsed.key)
      : await store.get(parsed.key);
    // MISS → strict local 404 (or the opt-in live fallback).
    if (capture === null) {
      return liveOr404(c, parsed.archiveUrl);
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
      return liveOr404(c, parsed.archiveUrl);
    }
    if (status === 'error') {
      return notFound(c, cspMode);
    }

    c.header('Content-Type', capture.contentType || 'application/octet-stream');
    c.header('Cache-Control', HIT_CACHE_CONTROL);
    // Provenance header on every hit — where this body actually came from.
    // Invisible to the page; visible attribution is #320's chrome.
    c.header('X-Wayback-Source', parsed.canonicalArchiveUrl);

    // HTML documents carry the standalone CSP — the browser enforces
    // same-origin fetches on references no rewriter caught. Set on the
    // response regardless of body presence (HEAD, `empty` html) so the header
    // posture is uniform for anything a browser treats as a document.
    const isHtml = /^text\/html\b/i.test(capture.contentType);
    if (isHtml) setCsp(c, cspMode);

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
      const dialect = classifyContentType(capture.contentType);
      if (dialect !== null) {
        const { text } = rewrite(capture.contentType, await bodyLatin1(), localize);
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
  });

  return app;
}
