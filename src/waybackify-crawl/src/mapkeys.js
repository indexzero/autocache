/**
 * findings → captureKeys (design "Key mapping", §C2).
 *
 * A leaked runtime request the probe reports arrives in one of two shapes, and
 * this module maps each to the durable `dynamic[]` fact the crawl fixpoint
 * records:
 *
 *   LOCAL 404 (`dangling-local`)   the served body already carried a local
 *                                  `/web/<ts>/<orig>` ref (build-time remaster
 *                                  localized it), but the key is not in the
 *                                  cache → parse with the SERVING parser
 *                                  (`parseWaybackPath`), the parity mirror of
 *                                  the router the browser hit.
 *   FOREIGN wayback (`non-local`)  a ref INSIDE a CSS/JS body that serve-time
 *                                  localize could not rewrite (its key was not
 *                                  yet in the corpus) stayed an absolute
 *                                  `web.archive.org/web/<ts>[flag]/<orig>` URL →
 *                                  parse with the FOREIGN parser
 *                                  (`parseWaybackUrl`, tolerant of replay flags
 *                                  + wayback's proxy-collapsed scheme). These
 *                                  are missing assets too, NOT policy escapes.
 *
 * A genuinely third-party non-local request (a tracker/CDN, not a wayback URL)
 * is NOT a key — it is an allowed-escapes question (src/policy.js). A non-`/web/`
 * archive.org chrome URL is a replay-chrome bug: logged, never recorded, never
 * a key. Unparseable candidates are logged, never recorded — the crawl never
 * fabricates a key.
 *
 * The `dynamic[]` entry shape and the `dynamicEntryError` predicate are the
 * core's (spv/waybackify/cache.js); this module produces entries that predicate
 * accepts (recordDynamic THROWS otherwise).
 */

import { parseWaybackPath } from '@charlie.dev/waybackify-serve/path';
import { parseWaybackUrl } from '@charlie.dev/waybackify/audit.js';
import { isTrackingBeacon } from '@charlie.dev/waybackify/beacons.js';
import { captureKey } from '@charlie.dev/waybackify/key.js';

// The tracking-beacon denylist lives in the CORE (waybackify/beacons.js), not
// here: the gate (fsck.js) needs the SAME predicate, and the crawl depends on
// the core, so the definition sits below the dependency edge and both sides
// import it. Re-export it so crawl.js's `import { isTrackingBeacon } from
// './mapkeys.js'` — and this module's own use below — keep resolving unchanged.
export { isTrackingBeacon } from '@charlie.dev/waybackify/beacons.js';

/** Raw-byte replay flags a `dynamic[]` entry may carry (design; core enum). */
const RAW_FLAGS = new Set(['im_', 'cs_', 'js_', 'oe_']);

/**
 * The replay flag to record for a leaked child. A leaked request's OWN flag is
 * honored ONLY when it is a raw-byte flag (`im_|cs_|js_|oe_`); a FRAMING flag
 * (`if_`/`id_`) is not a raw-byte flag, so it — like an absent flag — falls to
 * inference from the resource type (design's dynamic[] spec + edge-case
 * catalogue). Inference: stylesheet→`cs_`, script→`js_`, image→`im_`, else
 * `oe_` (fonts and everything else fetch as opaque raw bytes).
 *
 * @param {string | undefined | null} ownFlag - flag parsed off the leaked URL
 * @param {string | undefined | null} resourceType - the browser's resourceType
 * @returns {'im_'|'cs_'|'js_'|'oe_'}
 */
export function inferFlag(ownFlag, resourceType) {
  if (ownFlag && RAW_FLAGS.has(ownFlag)) return ownFlag;
  switch ((resourceType ?? '').toLowerCase()) {
    case 'stylesheet':
      return 'cs_';
    case 'script':
      return 'js_';
    case 'image':
    case 'imageset':
      return 'im_';
    default:
      return 'oe_';
  }
}

/** Build one well-formed `dynamic[]` entry. */
function entryOf(key, flag, now) {
  return { key, flag, via: 'remaster-verify', firstSeen: now() };
}

/**
 * Map the probe's per-document leak lists to a de-duplicated `dynamic[]`
 * worklist plus the residual third-party escapes.
 *
 * @param {object} leaks
 * @param {Array<{url: string, resourceType?: string}>} [leaks.dangling] -
 *   `dangling-local` findings (local `/web/` 404s).
 * @param {Array<{url: string, resourceType?: string}>} [leaks.nonLocal] -
 *   `non-local-request` findings (any non-local origin).
 * @param {object} [opts]
 * @param {() => string} [opts.now] - ISO clock (injectable for deterministic tests).
 * @param {(line: string) => void} [opts.log] - sink for dropped candidates.
 * @returns {{ entries: Array<{key: string, flag: string, via: string, firstSeen: string}>,
 *   escapes: Array<{url: string, resourceType?: string}>,
 *   unparseable: string[], chrome: string[], beacons: string[] }}
 *   `entries` — the worklist (missing wayback assets, local + foreign, deduped
 *   by key, first occurrence wins the flag). `escapes` — genuinely third-party
 *   non-local requests to weigh against the policy. `unparseable`/`chrome`/
 *   `beacons` — dropped candidates, surfaced for logging, never recorded
 *   (`beacons`: non-deterministic tracking pixels, see `isTrackingBeacon`).
 */
export function mapFindings(leaks, opts = {}) {
  const now = opts.now ?? (() => new Date().toISOString());
  const log = opts.log;
  const byKey = new Map();
  const escapes = [];
  const unparseable = [];
  const chrome = [];
  const beacons = [];

  const add = (key, flag) => {
    if (!byKey.has(key)) byKey.set(key, entryOf(key, flag, now));
  };

  // LOCAL 404s → the serving parser (router parity). A dangling-local finding
  // is, by the probe's own classification, a local path that already parsed —
  // but re-parse here so this mapper is independently testable from a raw URL.
  for (const d of leaks.dangling ?? []) {
    let pathname;
    try {
      pathname = new URL(d.url).pathname;
    } catch {
      pathname = d.url; // already a bare path
    }
    const parsed = parseWaybackPath(pathname);
    if (parsed === null) {
      unparseable.push(d.url);
      log?.(`mapkeys: unparseable dangling-local path, dropped: ${d.url}`);
      continue;
    }
    add(parsed.key, inferFlag(parsed.flag, d.resourceType));
  }

  // NON-LOCAL requests → split. A wayback URL is a missing asset (worklist); an
  // archive.org non-`/web/` URL is chrome (dropped); anything else is a genuine
  // third-party escape (policy's problem, not a key).
  for (const n of leaks.nonLocal ?? []) {
    const wb = parseWaybackUrl(n.url);
    if (wb) {
      // A non-deterministic tracking beacon is a `/web/` URL too, so it slips
      // past the archive.org-chrome filter below — drop it here on its ORIGINAL
      // url, or its per-render-random query mints an unconvergeable key forever.
      if (isTrackingBeacon(wb.original)) {
        beacons.push(n.url);
        log?.(`mapkeys: tracking beacon, dropped: ${n.url}`);
        continue;
      }
      add(captureKey(wb.timestamp, wb.original), inferFlag(wb.flags || null, n.resourceType));
      continue;
    }
    let host = '';
    try {
      host = new URL(n.url).hostname.toLowerCase();
    } catch {
      unparseable.push(n.url);
      log?.(`mapkeys: unparseable non-local URL, dropped: ${n.url}`);
      continue;
    }
    if (host === 'archive.org' || host.endsWith('.archive.org')) {
      chrome.push(n.url);
      log?.(`mapkeys: non-/web/ archive.org chrome URL, dropped: ${n.url}`);
      continue;
    }
    escapes.push(n);
  }

  return { entries: [...byKey.values()], escapes, unparseable, chrome, beacons };
}
