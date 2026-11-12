// The wrapper-stub remediation sweep — CACHE.md's "corpus-wide run".
//
// Wayback sometimes answers a replay request with its own viewer page (a
// "Wayback Machine" title around an `id="playback"` iframe) instead of the
// capture. It does this for most non-HTML documents and, now and then, for
// HTML. `commitEntry` refuses that page and commits a bodiless `interstitial`
// sidecar with signature `wrapper-stub`. From then on the capture is stuck:
// the capture key ignores the replay flag, so the sidecar that records the
// refusal also satisfies every later fetch of the same capture — `cache fill`
// leaves interstitials off its worklist and `cacheCapture` skips an existing
// sidecar.
//
// The real bytes are one `id_` refetch away. This sweep walks a root's
// sidecars, refetches each wrapper stub raw (interstitial.js#refetchRaw) and
// recommits it through commitEntry — the store's only writer, which re-runs
// the interstitial checks on the new bytes. It needs no ledger: the root's
// own sidecars are the worklist.
//
// What it leaves alone, and reports:
//   • a stub whose sidecar flag is already `id_` — the raw fetch itself was
//     refused, so asking again changes nothing; it needs a re-pick
//   • every other interstitial signature (redirect-interstitial,
//     archived-error) — a different capture is the fix, not other bytes
//
// `extension-mismatch` (a .pdf/.txt stored as text/html) is the same disease
// as a wrapper stub seen from the content type, so it is swept too.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { commitEntry, isSidecarObject, SIDECAR_VERSION } from './cache.js';
import { INTERSTITIAL_SIGNATURES, refetchRaw } from './interstitial.js';
import { NOOP_LOGGER } from './noop-logger.js';

/** The signatures a raw refetch can cure. */
export const RAW_REFETCH_SIGNATURES = Object.freeze([
  INTERSTITIAL_SIGNATURES.wrapperStub,
  INTERSTITIAL_SIGNATURES.extensionMismatch
]);

/**
 * Every `interstitial` sidecar under a root, in key order.
 * @param {string} root
 * @returns {Promise<object[]>}
 */
export async function interstitials(root) {
  const found = [];
  const metaDir = path.join(root, 'meta');
  let shards;
  try {
    shards = await fsp.readdir(metaDir);
  } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const aa of shards.sort()) {
    let names;
    try {
      names = await fsp.readdir(path.join(metaDir, aa));
    } catch (error) {
      if (error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(metaDir, aa, name);
      const sidecar = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!isSidecarObject(sidecar) || sidecar.v !== SIDECAR_VERSION) {
        throw new Error(`remediate: unsupported sidecar at ${file}`);
      }
      if (sidecar.status === 'interstitial') found.push(sidecar);
    }
  }
  return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Sweep a root's wrapper stubs: refetch each raw and recommit it.
 *
 * Outcomes, one per interstitial sidecar:
 *   fixed        the raw bytes are now stored (`status: body`, `flag: id_`)
 *   still        the raw bytes tripped a signature again — needs a re-pick
 *   unavailable  the archive answered the raw fetch with a settled non-200
 *   deferred     429 / 5xx / no answer — left for a re-run
 *   repick       not curable by a raw refetch (see the header) — untouched
 *
 * A run of `throttleAfter` consecutive deferrals stops the sweep: the archive
 * is throttling, and every remaining request would be wasted.
 *
 * @param {string} root
 * @param {Object} [options]
 * @param {Function} [options.fetch] - fetch-like (default: WaybackMachine impit)
 * @param {number} [options.delayMs=3000] - pacing between refetches
 * @param {number} [options.throttleAfter=6] - consecutive deferrals → stop; 0 disables
 * @param {number} [options.max=Infinity] - cap refetches this run
 * @param {boolean} [options.dryRun=false] - classify only; fetch nothing
 * @param {(row: object) => void} [options.onEntry] - one call per sidecar
 * @param {Function} [options.sleep] - (ms) => Promise (injectable)
 * @param {Object} [options.logger]
 * @returns {Promise<{ interstitials: number, tally: Record<string, number>,
 *   throttled: boolean, dryRun: boolean }>}
 */
export async function remediate(root, options = {}) {
  const {
    delayMs = 3000,
    throttleAfter = 6,
    max = Infinity,
    dryRun = false,
    onEntry = () => {},
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    logger = NOOP_LOGGER
  } = options;
  if (!root) throw new TypeError('remediate: root is required');

  const stubs = await interstitials(root);
  const tally = {};
  const emit = row => {
    tally[row.outcome] = (tally[row.outcome] ?? 0) + 1;
    onEntry(row);
  };

  let fetchImpl = options.fetch;
  let streak = 0;
  let attempts = 0;
  let throttled = false;
  for (const sidecar of stubs) {
    const curable = RAW_REFETCH_SIGNATURES.includes(sidecar.signature) && sidecar.flag !== 'id_';
    if (!curable) {
      emit({ key: sidecar.key, signature: sidecar.signature, outcome: 'repick' });
      continue;
    }
    if (dryRun) {
      emit({ key: sidecar.key, signature: sidecar.signature, outcome: 'would-refetch' });
      continue;
    }
    if (attempts >= max) break;
    if (!fetchImpl) {
      const { WaybackMachine } = await import('./index.js');
      const wayback = new WaybackMachine({ timeout: 120000, logger });
      fetchImpl = url => wayback.impit.fetch(url);
    }
    if (attempts++ > 0 && delayMs > 0) await sleep(delayMs);

    let row;
    try {
      const res = await refetchRaw(sidecar.key, { fetch: fetchImpl });
      if (res.status === 200 && res.body) {
        const written = await commitEntry(root, {
          key: sidecar.key,
          status: 'body',
          contentType: res.contentType,
          flag: 'id_',
          requisites: [],
          body: res.body
        });
        row = written.status === 'interstitial'
          ? { key: sidecar.key, url: res.url, outcome: 'still', signature: written.signature }
          : { key: sidecar.key, url: res.url, outcome: 'fixed', status: written.status, contentType: res.contentType, bytes: written.contentLength ?? 0 };
      } else if (res.status === 429 || res.status >= 500) {
        row = { key: sidecar.key, url: res.url, outcome: 'deferred', status: res.status };
      } else {
        row = { key: sidecar.key, url: res.url, outcome: 'unavailable', status: res.status };
      }
    } catch (error) {
      row = { key: sidecar.key, outcome: 'deferred', error: String(error?.message ?? error).split('\n')[0] };
    }
    emit(row);
    streak = row.outcome === 'deferred' ? streak + 1 : 0;
    if (throttleAfter > 0 && streak >= throttleAfter) {
      throttled = true;
      break;
    }
  }
  return { interstitials: stubs.length, tally, throttled, dryRun };
}
