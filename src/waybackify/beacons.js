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
  { host: /^(?:www\.)?facebook\.com$/, path: /^\/tr$/ }
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
