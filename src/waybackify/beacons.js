/**
 * Non-deterministic tracking / analytics / ad beacon denylist — CORE, shared by
 * BOTH the crawl (mapkeys.js, which refuses to chase a beacon into the frontier)
 * and the gate (fsck.js, which must not flag a beacon's absent sidecar as an
 * `incompleteClosure`). It lives in the core precisely because the crawl package
 * DEPENDS ON this one: the denylist cannot live upstream in the crawl and be
 * imported down here (a cycle), so the single definition sits here and the crawl
 * re-exports it. This module imports NOTHING from the crawl.
 *
 * A beacon is matched against the ORIGINAL url inside a `/web/<ts>/<original>`
 * replay (host + path).
 */

/**
 * Tracking / analytics / ad beacon denylist, matched against the ORIGINAL url
 * inside a `/web/<ts>/<original>` replay (host + path).
 *
 * WHY DROP THESE. The archived page fired these pixels at render. The replay
 * serves them as legitimate `/web/<ts>/<original>` capture URLs, so the generic
 * non-`/web/` archive.org chrome filter does NOT catch them. Their query
 * strings carry per-render-RANDOM params (GA's `utmn`/`utmhid`, session ids,
 * cache busters), so every render mints a fresh URL → a fresh captureKey → the
 * frontier can never mark them "already cached" and the document never
 * converges. They are un-mirrorable by construction and carry zero page
 * fidelity — fire-and-forget tracking. Dropping them (mirroring the IA-chrome
 * drop) is the only way the fixpoint terminates on such docs; the gate agrees so
 * they never keep the store dirty forever.
 *
 * CONSERVATIVE by design. Match a specific host — or a host whose ENTIRE domain
 * is a beacon collector — plus, where that host ALSO serves real content, an
 * exact path. Never a broad host glob that could eat content: fonts
 * (`fonts.googleapis.com`, Typekit), video (`googlevideo.com`), avatars
 * (`gravatar.com`) and social widgets are CONTENT, not beacons, and stay real
 * findings (see the over-reach test). Extend by appending a rule.
 *
 * Each rule: `host` (exact string, case-insensitive) or a `RegExp`, OR
 * `hostSuffix` (whole-domain beacon collector); with an optional `path` (exact
 * string or `RegExp`) required when the host also serves content.
 * @type {Array<{host?: string|RegExp, hostSuffix?: string, path?: string|RegExp}>}
 */
const TRACKING_BEACONS = [
  // Google Analytics — the classic `__utm.gif` pixel (utmn/utmhid randomized)
  // and the Universal Analytics `/collect` endpoint.
  { host: /^(?:www\.|ssl\.)?google-analytics\.com$/, path: /^\/(?:__utm\.gif|collect)$/ },
  // Adobe / Omniture SiteCatalyst — the entire *.2o7.net and *.omtrdc.net data
  // domains are beacon collectors.
  { hostSuffix: '.2o7.net' },
  { hostSuffix: '.omtrdc.net' },
  // DoubleClick ad beacons.
  { hostSuffix: '.doubleclick.net' },
  // AppNexus ad beacons.
  { hostSuffix: '.adnxs.com' },
  // Google CSI timing beacon — csi.gstatic.com ONLY; gstatic.com at large
  // serves fonts/static content, so never suffix-match it.
  { host: 'csi.gstatic.com' },
  // WordPress.com stats pixels.
  { host: 'pixel.wp.com' },
  { host: 'stats.wp.com' },
  // Facebook pixel — facebook.com serves real content, so scope to the exact
  // `/tr` tracking path.
  { host: /^(?:www\.)?facebook\.com$/, path: /^\/tr$/ },
  // Microsoft Clarity — the entire clarity.ms domain is session-analytics
  // (`n.clarity.ms/collect`).
  { hostSuffix: '.clarity.ms' },
  // Backstory social/analytics widget — the whole getbackstory.com domain is
  // widget infra (`alpha.getbackstory.com/gbs_setup_*.js`).
  { hostSuffix: '.getbackstory.com' },
  // AOL / Verizon ad pixel.
  { host: 'pixel.advertising.com' },
  // Microsoft `c.gif` tracking pixel — microsoft.com serves real content, so
  // scope to the `c1.` beacon host AND the `c.gif` path (`c1.microsoft.com//c.gif?DI=…`).
  { host: 'c1.microsoft.com', path: /^\/+c\.gif$/ }
];

/** Does `host` satisfy a beacon rule's host constraint? */
function beaconHostMatches(host, rule) {
  if (rule.hostSuffix) {
    return host === rule.hostSuffix.replace(/^\./, '') || host.endsWith(rule.hostSuffix);
  }
  if (rule.host instanceof RegExp) return rule.host.test(host);
  return host === rule.host;
}

/** Does `path` satisfy a beacon rule's (optional) path constraint? */
function beaconPathMatches(path, rule) {
  if (!rule.path) return true;
  if (rule.path instanceof RegExp) return rule.path.test(path);
  return path === rule.path;
}

/**
 * Is `originalUrl` a known non-deterministic tracking/analytics/ad beacon?
 * These are un-capturable by construction (per-render-random query params) and
 * carry no page fidelity, so a beacon finding is DROPPED rather than recorded as
 * a captureKey the frontier could never converge on. See `TRACKING_BEACONS`.
 * @param {string} originalUrl - the `<original>` from a `/web/<ts>/<original>`.
 * @returns {boolean}
 */
export function isTrackingBeacon(originalUrl) {
  let host;
  let path;
  try {
    const u = new URL(originalUrl);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return false; // unparseable → not our call to make; leave it a finding.
  }
  return TRACKING_BEACONS.some(rule => beaconHostMatches(host, rule) && beaconPathMatches(path, rule));
}

/**
 * Schemes / shapes a requisite must NEVER be: inline or pseudo URLs a wayback
 * replay can't serve and an extractor should never have emitted. These reach the
 * frontier because the archived page's CSS/HTML referenced them and the replay
 * rewrote them into `/web/<ts><flag>/<original>` refs anyway:
 *   - a CSS `url(data:<mime>/...)` inline font mis-resolved as a relative PATH
 *     (`.../genericons/data:application/font-woff;base64,…`),
 *   - `javascript:` handlers (`javascript:parent.adsIframeHtml()`),
 *   - `mailto:` / `blob:` / `about:` / `tel:` pseudo-URLs,
 *   - a schemeless keyword resolved to a bare host (`http://javascript/`).
 */
const UNFETCHABLE_SCHEME = /^(?:data|javascript|mailto|blob|about|tel|vbscript):/i;

/**
 * Is `originalUrl` a real, fetchable http(s) resource — i.e. NOT one of the
 * inline/pseudo/malformed shapes above? A replay could never serve those, so
 * they are neither fetched nor counted toward a doc's closure.
 * @param {string} originalUrl - the `<original>` from a `/web/<ts>/<original>`.
 * @returns {boolean}
 */
export function isFetchableResource(originalUrl) {
  if (typeof originalUrl !== 'string' || originalUrl === '') return false;
  if (UNFETCHABLE_SCHEME.test(originalUrl)) return false;
  if (/data:[a-z]+\/[a-z0-9.+-]/i.test(originalUrl)) return false; // data:<mime>/ mis-resolved mid-URL
  if (/^https?:\/\/javascript(?:[:/]|$)/i.test(originalUrl)) return false; // `http://javascript/`
  return true;
}

/**
 * Is `originalUrl` an UN-MIRRORABLE frontier child — a tracking beacon OR a
 * non-fetchable resource? The union predicate the frontier sites consult: the
 * fetcher (cacheCapture) skips these so a run never wastes a request/timeout on
 * them, and the gate (fsck) skips them so their absence never keeps the store
 * dirty. A capturable, real requisite is neither.
 * @param {string} originalUrl - the `<original>` from a `/web/<ts>/<original>`.
 * @returns {boolean}
 */
export function isUnmirrorable(originalUrl) {
  return !isFetchableResource(originalUrl) || isTrackingBeacon(originalUrl);
}
