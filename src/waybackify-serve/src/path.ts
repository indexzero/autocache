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

import { captureKey } from '@autocache/waybackify/key.js';

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
export { captureKey } from '@autocache/waybackify/key.js';

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
 * Is `byte` one a request line cannot carry raw — the escape set of
 * {@link formatCapturePath} and the ONLY set {@link decodeCapturePath}
 * decodes, so the pair is an exact inverse by construction.
 *
 * The membership is EMPIRICAL, not aesthetic: it is precisely the bytes the
 * WHATWG URL parser refuses to keep byte-identical in `pathname + search`
 * (which is what src/app.ts hands to parseWaybackPath — no percent-decoding).
 * A raw `#` starts the fragment (dropped client-side, never transmitted); a
 * raw `\` in a path is normalized to `/`; space, `"`, `<`, `>`, `` ` ``,
 * `{`, `}`, `^` are percent-encoded in paths and `'` in (special-URL)
 * queries; C0 controls, DEL, and every byte ≥ 0x80 (a non-ASCII character's
 * UTF-8 bytes) are percent-encoded everywhere. `%` itself is in the set so
 * the encoding is unambiguous — a key that already contains a literal
 * percent-sequence (`…/a%20b`, common in archived URLs) formats to
 * `…/a%2520b` and decodes back to itself, never to a different key.
 *
 * Deliberately NOT in the set: `/`, `:`, `?`, `&`, `=`, `|`, `[`, `]`, `@`,
 * `~` and the other bytes the parser keeps raw — for a key made only of
 * those, formatCapturePath is the IDENTITY, so today's reachable request
 * paths keep working byte-for-byte.
 */
function hrefEscaped(byte: number): boolean {
  if (byte <= 0x1f || byte >= 0x7f) return true; // C0 controls, DEL, non-ASCII
  switch (byte) {
    case 0x20: // space
    case 0x22: // "
    case 0x23: // #
    case 0x25: // % (the escape character itself)
    case 0x27: // '
    case 0x3c: // <
    case 0x3e: // >
    case 0x5c: // \
    case 0x5e: // ^
    case 0x60: // `
    case 0x7b: // {
    case 0x7d: // }
      return true;
    default:
      return false;
  }
}

/**
 * Format a capture key as the request path that dials it — the INVERSE of
 * parseWaybackPath, for building links (the `/_index` cache page). Returns
 * `/<key>` with exactly the {@link hrefEscaped} bytes percent-encoded
 * (UTF-8), so the result is a FIXED POINT of WHATWG URL parsing: a browser
 * navigating the href transmits `pathname + search` byte-identical to what
 * we emitted, no re-encoding, no dropped fragment. The serving side
 * (src/app.ts's `*` route) recovers the byte-exact key by trying the raw
 * parse first and, on a store miss, the {@link decodeCapturePath}'d parse.
 *
 * For a key with no escaped bytes this is exactly `/${key}` — the identity.
 */
export function formatCapturePath(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let out = '/';
  for (const b of bytes) {
    out += hrefEscaped(b)
      ? `%${b.toString(16).toUpperCase().padStart(2, '0')}`
      : String.fromCharCode(b);
  }
  return out;
}

/**
 * Decode a request path (`url.pathname + url.search`) back to the string
 * {@link formatCapturePath} encoded — decoding ONLY `%XX` sequences whose
 * byte is in the {@link hrefEscaped} set, so the pair is an exact inverse.
 * Everything else is untouched: `%2F` is NOT decoded (a `/` is never
 * invented, so the path structure the parser saw cannot change), a lone or
 * malformed `%` passes through literally, and a path with no `%` at all is
 * returned unchanged (===), which is how the caller cheaply detects "nothing
 * to decode".
 */
export function decodeCapturePath(raw: string): string {
  if (!raw.includes('%')) return raw;
  const enc = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw.charCodeAt(i) === 0x25 /* % */) {
      // A truncated tail (`…%2`) yields a short slice the regex rejects.
      const hex = raw.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        const b = parseInt(hex, 16);
        if (hrefEscaped(b)) {
          bytes.push(b);
          i += 3;
          continue;
        }
      }
    }
    // A literal character (surrogate-pair aware): its UTF-8 bytes, verbatim.
    const cp = raw.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    for (const b of enc.encode(ch)) bytes.push(b);
    i += ch.length;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
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
