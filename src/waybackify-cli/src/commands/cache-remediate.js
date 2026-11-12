// `waybackify cache remediate` handler — thin wiring over the library's
// remediate.js, per the CLI's hard thin-wrapper rule: the sweep itself (walk
// the root's interstitial sidecars, refetch each wrapper stub raw with `id_`,
// recommit through commitEntry, stop on a throttle) is the library's. This
// file translates the parsed argv payload into a remediate() call, prints one
// JSONL row per interstitial sidecar on stdout, a tally on stderr, and maps
// "a re-run has work left" to a domain-failure exit (1).
//
// Design: docs/CACHE.md (Interstitial refusal). The sweep is ledger-free —
// the root's own sidecars are its worklist.

import { NOOP_LOGGER } from '../logger.js';

/**
 * Build the `cache remediate` handler. Dependency-injectable for tests; the
 * bin wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.remediate] - the library entry point
 * @returns {Function} paparam runner: ({ flags, logger, out }) => Promise<void>
 */
export function cacheRemediateHandler(deps = {}) {
  return async ({ flags, logger = NOOP_LOGGER, out = console.log }) => {
    const remediate = deps.remediate ?? (await import('@autocache/waybackify/remediate.js')).remediate;
    const num = (v, d) => (v === undefined || v === null ? d : Number(v));

    const result = await remediate(flags.root, {
      delayMs: num(flags.delayMs, 3000),
      throttleAfter: num(flags.throttleAfter, 6),
      max: num(flags.max, Infinity),
      dryRun: Boolean(flags.dryRun),
      logger,
      // One row per interstitial sidecar — the command's RESULT (stdout).
      onEntry: row => out(JSON.stringify(row))
    });

    logger.info(
      { evt: 'remediate-summary', root: flags.root, interstitials: result.interstitials, ...result.tally, throttled: result.throttled },
      `${result.interstitials} interstitial sidecar(s): ` +
        (Object.entries(result.tally).map(([k, n]) => `${n} ${k}`).join(' · ') || 'nothing to do')
    );

    if (result.throttled) {
      throw new Error('cache remediate stopped: archive.org is throttling — re-run later to resume');
    }
    if (result.tally.deferred > 0) {
      throw new Error(`cache remediate incomplete: ${result.tally.deferred} refetch(es) deferred — re-run to resume`);
    }
  };
}
