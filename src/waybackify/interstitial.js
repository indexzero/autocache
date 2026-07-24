// Interstitial detection (#363) — naming the captures that are not content,
// but the Wayback Machine talking ABOUT content.
//
// The #292 sweep found two species stored as `status: "body"` that a mirror
// must never serve as a page:
//
//   - WRAPPER STUB       a `<title>Wayback Machine</title>` shell with an
//                        `id="playback"` iframe — archive.org's raw-asset
//                        viewer, stored where a PDF or a .txt should be and
//                        served as text/html. The real bytes are one `id_`
//                        refetch away (see refetchRaw()).
//   - REDIRECT INTERSTITIAL  archive navbar chrome plus a `setTimeout(go, 5000)`
//                        stub that bounces the tab to the live archive. The
//                        decoded destination (timestamp + original URL) is the
//                        only content it carries.
//
// Two more signatures round out the set:
//
//   - EXTENSION MISMATCH  a `.pdf`/`.txt` original stored as `text/html` — the
//                        raw asset was never captured; only a wrapper was.
//   - ARCHIVED ERROR      the CDX index says the exact capture's own
//                        `statuscode` is 4xx/5xx even though the replay served
//                        200 (absorbed from #248). Network-derived, so it
//                        arrives as an INJECTED `cdxStatus` — this module never
//                        touches the wire, and tests stay offline.
//
// LIBRARY-FIRST. This is pure detection over bytes + metadata: `commitEntry`
// (cache.js) calls it to REFUSE a body whose signature fires (committing
// `interstitial` instead), `fsck` calls it to REPORT pre-schema `status:body`
// entries that match, and the #364 remediation sweep calls classifyEntry()
// to classify an existing entry without committing. `refetchRaw()` is the
// wrapper-stub remediation primitive: fetch the same capture with wayback's
// `id_` flag (raw bytes), fetch injected so the corpus run is #364's, not a
// live test's.

import { parseWaybackUrl } from './audit.js';

/**
 * The signature names a sidecar records in `sidecar.signature` when it commits
 * `interstitial`. One string per detector — the audit trail for why a capture
 * was refused, and the key the remediation sweep dispatches on.
 * @type {{ wrapperStub: string, redirectInterstitial: string, extensionMismatch: string, archivedError: string }}
 */
export const INTERSTITIAL_SIGNATURES = Object.freeze({
  wrapperStub: 'wrapper-stub',
  redirectInterstitial: 'redirect-interstitial',
  extensionMismatch: 'extension-mismatch',
  archivedError: 'archived-error'
});

// ---------------------------------------------------------------------------
// Signature markers (deliberately narrow — a false positive silently drops a
// real capture, so each marker is the archive's own boilerplate, not a phrase
// a real page might carry).
// ---------------------------------------------------------------------------

/** Wrapper stub: the archive's raw-asset viewer shell. */
const WRAPPER_TITLE = /<title>\s*Wayback Machine\s*<\/title>/i;
const WRAPPER_IFRAME = /<iframe\b[^>]*\bid\s*=\s*["']?playback\b/i;

/** Redirect interstitial: the impatient `setTimeout(go, 5000)` bounce + chrome. */
const REDIRECT_TIMEOUT = /setTimeout\s*\(\s*["']?\s*go\s*(?:\(\s*\))?\s*["']?\s*,\s*5000\b/i;
const REDIRECT_CHROME = /webComponentLoaderConfig/;

/**
 * The redirect target embedded in the stub, as a `/web/<ts>[flag]/<original>`
 * reference (relative or absolute). Non-greedy to the closing quote.
 */
const REDIRECT_TARGET =
  /["'](?:https?:\/\/web\.archive\.org)?(\/web\/\d{4,14}(?:[a-z]{2}_)?\/https?[^"'\s\\]+)["']/i;

/** Raw-asset extensions that must never be `text/html` (the named #363 set). */
const RAW_ASSET_EXTENSION = /\.(?:pdf|txt)$/i;

/** Content types the body-shape signatures run over (documents; '' = unknown). */
const isHtmlish = ct => !ct || /html|xhtml/i.test(ct);

/** Bytes | string → text for marker scanning (null stays null). */
function bodyText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  return new TextDecoder('utf-8').decode(body);
}

/**
 * Decode a redirect interstitial's destination into `{ url, timestamp }`, or
 * null when the stub carries no parseable `/web/…` reference. Routed through
 * audit.js#parseWaybackUrl so the scheme-collapse repair and flag handling stay
 * in one place.
 * @param {string} html
 * @returns {{ url: string, timestamp: string } | null}
 */
function decodeRedirectTarget(html) {
  const match = REDIRECT_TARGET.exec(html);
  if (!match) return null;
  const parsed = parseWaybackUrl(`https://web.archive.org${match[1]}`);
  return parsed ? { url: parsed.original, timestamp: parsed.timestamp } : null;
}

/**
 * Does a `.pdf`/`.txt` original arrive as `text/html`? The extension is read
 * off the capture key's original URL (query/fragment stripped); an html-ish
 * content-type over a raw-asset extension means a wrapper was stored, never the
 * bytes. Requires an EXPLICIT html content-type — an empty/absent type is not
 * enough to call it a mismatch.
 * @param {string} key - capture key `${timestamp}/${originalUrl}`
 * @param {string} contentType
 * @returns {boolean}
 */
function isExtensionMismatch(key, contentType) {
  if (!/html|xhtml/i.test(contentType)) return false;
  const sep = typeof key === 'string' ? key.indexOf('/') : -1;
  if (sep < 0) return false;
  const original = key.slice(sep + 1).replace(/[?#].*$/, '');
  return RAW_ASSET_EXTENSION.test(original);
}

/**
 * Classify one capture. Returns null when nothing fires, else
 * `{ signature, target? }` — `target` present IFF a redirect interstitial's
 * destination decoded (fields exist iff meaningful, the sidecar discipline).
 *
 * @param {Object} input
 * @param {string} [input.key] - capture key (drives the extension signature)
 * @param {string} [input.contentType] - as stored (`''` when the archive sent none)
 * @param {Uint8Array|string|null} [input.body] - the stored/fetched bytes;
 *   null when unavailable (a streamed body, or a bodiless caller)
 * @param {string|number|null} [input.cdxStatus] - the exact capture's archived
 *   CDX statuscode, INJECTED (network-derived); null offline
 * @returns {{ signature: string, target?: { url: string, timestamp: string } } | null}
 */
export function detectInterstitial(input = {}) {
  const { key = '', contentType = '', body = null, cdxStatus = null } = input;

  // Signature 0 — the capture's own archived statuscode (injected, so offline
  // callers/tests never hit the wire). 4xx/5xx = archived AS an error, even
  // when the replay lied with a 200.
  if (cdxStatus != null && /^[45]\d\d$/.test(String(cdxStatus))) {
    return { signature: INTERSTITIAL_SIGNATURES.archivedError };
  }

  const html = isHtmlish(contentType) ? bodyText(body) : null;

  if (html) {
    // Redirect interstitial BEFORE wrapper-stub: its markers are more specific
    // and it is the only signature that decodes a target.
    if (REDIRECT_TIMEOUT.test(html) && REDIRECT_CHROME.test(html)) {
      const target = decodeRedirectTarget(html);
      return target
        ? { signature: INTERSTITIAL_SIGNATURES.redirectInterstitial, target }
        : { signature: INTERSTITIAL_SIGNATURES.redirectInterstitial };
    }
    if (WRAPPER_TITLE.test(html) && WRAPPER_IFRAME.test(html)) {
      return { signature: INTERSTITIAL_SIGNATURES.wrapperStub };
    }
  }

  // Extension ↔ content-type disagreement needs no body.
  if (isExtensionMismatch(key, contentType)) {
    return { signature: INTERSTITIAL_SIGNATURES.extensionMismatch };
  }

  return null;
}

/**
 * Report-first path for the #364 remediation sweep: classify an EXISTING
 * entry's body against its sidecar WITHOUT committing anything. A thin adapter
 * over detectInterstitial that reads key + contentType off the sidecar.
 * @param {{ key: string, contentType: string }} sidecar
 * @param {Uint8Array|string|null} body - the stored `cap/` bytes (null if bodiless)
 * @param {Object} [options]
 * @param {string|number|null} [options.cdxStatus] - injected CDX statuscode
 * @returns {{ signature: string, target?: { url: string, timestamp: string } } | null}
 */
export function classifyEntry(sidecar, body, options = {}) {
  return detectInterstitial({
    key: sidecar?.key ?? '',
    contentType: sidecar?.contentType ?? '',
    body,
    cdxStatus: options.cdxStatus ?? null
  });
}

// ---------------------------------------------------------------------------
// Wrapper-stub remediation: the `id_` raw-bytes refetch
// ---------------------------------------------------------------------------

/**
 * The `id_`-flagged replay URL for a capture key — wayback's "identity" flag,
 * which returns the raw captured bytes with no framing wrapper. This is the
 * remediation refetch for a wrapper stub: the same (timestamp, original), asked
 * for verbatim.
 * @param {string} key - capture key `${timestamp}/${originalUrl}`
 * @returns {string}
 */
export function idRefetchUrl(key) {
  const sep = typeof key === 'string' ? key.indexOf('/') : -1;
  if (sep <= 0 || sep === key.length - 1) {
    throw new TypeError(`idRefetchUrl: not a capture key (${JSON.stringify(key)})`);
  }
  return `https://web.archive.org/web/${key.slice(0, sep)}id_/${key.slice(sep + 1)}`;
}

/**
 * Refetch a capture's RAW bytes via the `id_` flag. Library support for the
 * wrapper-stub remediation (#364 owns the corpus-wide run); `fetch` is INJECTED
 * so unit tests exercise it against fixtures with zero live network. Returns
 * the fetched bytes on a 200, null body otherwise (the caller decides what a
 * non-200 raw refetch means).
 * @param {string} key - capture key `${timestamp}/${originalUrl}`
 * @param {Object} options
 * @param {Function} options.fetch - fetch-like (REQUIRED — injected)
 * @returns {Promise<{ url: string, status: number, contentType: string, body: Uint8Array|null }>}
 */
export async function refetchRaw(key, options = {}) {
  const { fetch: fetchImpl } = options;
  if (typeof fetchImpl !== 'function') throw new TypeError('refetchRaw: options.fetch is required');
  const url = idRefetchUrl(key);
  const res = await fetchImpl(url);
  const contentType = res.headers?.get?.('content-type') || '';
  let body = null;
  if (res.status === 200) {
    body =
      typeof res.arrayBuffer === 'function'
        ? new Uint8Array(await res.arrayBuffer())
        : new TextEncoder().encode(await res.text());
  }
  return { url, status: res.status, contentType, body };
}
