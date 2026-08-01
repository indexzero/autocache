/**
 * Wayback path parsing (#249).
 *
 * A wayback mirror mirrors the Wayback Machine's replay path shape so that
 * pointing a corpus link at the mirror is a pure host swap:
 *
 *   web.archive.org/web/20140403040000/http://sudomakethought.com/post/...
 *   wayback.example.com/20140403040000/http://sudomakethought.com/post/...
 *
 * Everything here is pure string work — no runtime globals — so the same
 * parser serves three masters: the edge handler (src/app.ts), the corpus
 * enumerator (render/wayback/src/enumerate.ts), and #248's wayback-404 audit.
 * One parser, one definition of "what is a capture", or the mirror and the
 * audit drift.
 */

/** A parsed wayback-style path. All fields derived, none guessed. */
export interface WaybackPath {
  /** Capture timestamp: 4–14 digits (YYYY[MM[DD[HHMMSS]]]), as-given. */
  timestamp: string;
  /**
   * Replay modifier suffixed to the timestamp (`if_`, `id_`, `im_`, `js_`,
   * `cs_`, ...). Wayback uses these to select iframe/raw/asset rendering;
   * we tolerate + preserve them on parse but they never enter the capture
   * key — a capture is one body per (timestamp, url), however it's framed.
   */
  flag?: string;
  /** The archived original URL, after liberal repair (see repairUrl). */
  originalUrl: string;
  /**
   * Capture key: `${timestamp}/${originalUrl}`. THE storage contract —
   * the store impls (src/store.ts) look up by this key and the future
   * mirror-population tooling (blocked on the #248 audit) must write by
   * it. Derive it with captureKey(); never hand-roll.
   */
  key: string;
  /** Flag-preserving web.archive.org URL — the miss-redirect target. */
  archiveUrl: string;
  /** Flagless canonical capture URL — attribution / X-Wayback-Source. */
  canonicalArchiveUrl: string;
}

import { captureKey } from '@charlie.dev/waybackify/key.js';

/**
 * `/<timestamp><flag?>/<rest>` — timestamps are 4–14 digits (wayback accepts
 * date prefixes down to a bare year), flags are 1–3 letters + underscore.
 *
 * The optional `/web` prefix makes `/web/<ts><flag?>/<url>` a first-class
 * capture request, byte-identical in meaning to the unprefixed form. Replay
 * HTML references its page requisites ROOT-RELATIVE in exactly that shape
 * (`src="/web/<ts>im_/<original>"` — the wayback rewrite), so accepting the
 * prefix means a stored document needs ZERO URL rewriting to have its assets
 * resolve against this mirror: the browser asks for the rewritten path
 * as-is, and it parses to the same capture key. The prefix never enters the
 * key — it is routing, not identity.
 */
const PATH_RE = /^\/(?:web\/)?(\d{4,14})([a-z]{1,3}_)?\/(.+)$/;

// The key derivation itself lives in the shared waybackify package (a pure,
// extraction-ready module — it's the storage contract the #254 waybackify CLI
// shares); re-exported here because the parser is where consumers meet keys.
export { captureKey } from '@charlie.dev/waybackify/key.js';

/**
 * Parse a wayback-style path (pathname + search of an incoming request).
 * Returns null for anything that isn't a plausible capture reference —
 * the caller decides whether that's a 404 or a skip.
 *
 * Liberal by design: replay flags on the timestamp are tolerated, scheme
 * slashes collapsed by intermediaries are repaired, protocol-relative and
 * scheme-less originals are accepted (wayback itself accepts all of these).
 */
export function parseWaybackPath(path: string): WaybackPath | null {
  const m = PATH_RE.exec(path);
  if (m === null) return null;

  const [, timestamp, flag, rest] = m;
  const originalUrl = repairUrl(rest);
  if (originalUrl === null) return null;

  return {
    timestamp,
    ...(flag ? { flag } : {}),
    originalUrl,
    key: captureKey(timestamp, originalUrl),
    archiveUrl: `https://web.archive.org/web/${timestamp}${flag ?? ''}/${originalUrl}`,
    canonicalArchiveUrl: `https://web.archive.org/web/${timestamp}/${originalUrl}`
  };
}

/**
 * Parse a full `https://web.archive.org/web/...` URL into the same shape.
 * This is how the corpus enumerator and the #248 audit reuse the parser:
 * a corpus reference and an incoming edge request agree on (timestamp,
 * originalUrl, key) because they go through the same code.
 */
export function parseArchiveUrl(url: string): WaybackPath | null {
  const m = /^https?:\/\/web\.archive\.org\/web(\/.+)$/i.exec(url);
  if (m === null) return null;
  return parseWaybackPath(m[1]);
}

/**
 * Repair/normalize the embedded original URL, mirroring wayback's own
 * tolerance:
 *
 * - `http:/host/...` → `http://host/...` — proxies and URL normalizers love
 *   collapsing the `//` inside an embedded URL; wayback replays these fine
 *   and so do we.
 * - `//host/...` (protocol-relative) → assume https.
 * - `host.tld/...` (scheme-less) → assume http — historical corpus originals
 *   are overwhelmingly http-era.
 *
 * Anything that still doesn't look like a URL with a host is rejected
 * (null), which the app turns into a 404 rather than a bogus redirect.
 */
function repairUrl(rest: string): string | null {
  const collapsed = rest.replace(/^(https?):\/(?!\/)/i, '$1://');
  if (/^https?:\/\/[^/]/i.test(collapsed)) return collapsed;
  if (collapsed.startsWith('//') && /^\/\/[^/]/.test(collapsed)) return `https:${collapsed}`;
  if (/^[\w-]+(\.[\w-]+)+([:/?#]|$)/.test(collapsed)) return `http://${collapsed}`;
  return null;
}
