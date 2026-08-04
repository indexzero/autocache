// `waybackify cache fill` handler — thin wiring over the library's backfill.js
// engine, per the CLI's hard thin-wrapper rule: the load-bearing loop (durable
// closure-aware worklist, throttle, defer-on-transient, abort-on-connection-
// failure, resume) is spv/waybackify/backfill.js; this file translates the
// parsed argv payload into a backfill() call, streams progress to stderr,
// prints one JSON summary line to stdout, and turns an abort into a
// domain-failure exit (1 — the mirror image is incomplete; re-run to resume).
//
// The library module keeps its name (backfill.js — the engine is unchanged;
// only the CLI verb moved from `backfill` to `cache fill`). It is imported by
// workspace-relative specifier (both packages are private and in-repo) and
// lazily, inside the runner, so merely loading the CLI surface never pays for
// impit.
//
// Runbook: docs/BACKFILL.md. Cache-root structure: docs/CACHE.md.

import { NOOP_LOGGER } from '../logger.js';

/**
 * Build the `cache fill` handler. Dependency-injectable for tests; the bin wires
 * the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.backfill] - the library entry point
 * @returns {Function} paparam runner: ({ args, flags, logger, out }) => Promise<void>
 */
export function cacheFillHandler(deps = {}) {
  return async ({ args, flags, logger = NOOP_LOGGER, out = console.log }) => {
    const backfill = deps.backfill ?? (await import('@charlie.dev/waybackify/backfill.js')).backfill;

    // paparam does not coerce flag values — they arrive as strings. Number()
    // the numeric knobs; an absent flag keeps the library default.
    const num = (v, d) => (v === undefined || v === null ? d : Number(v));

    const result = await backfill({
      ledgerDir: args.dir,
      // --root|-r is canonical; --against/-o parse under their own names on
      // sibling commands, but fill only speaks --root.
      root: flags.root,
      delayMs: num(flags.delayMs, 1500),
      abortAfter: num(flags.abortAfter, 5),
      max: num(flags.max, Infinity),
      refresh: Boolean(flags.refresh),
      dryRun: Boolean(flags.dryRun),
      // §4 fetch trace (CDX retries + per-capture doc/requisite fetches).
      logger,
      onProgress(ev) {
        switch (ev.type) {
          case 'worklist':
            logger.info(
              { evt: 'fill-progress', type: ev.type, built: ev.built, count: ev.count, path: ev.path },
              `worklist: ${ev.built ? 'built' : 'reused'} ${ev.count} — ${ev.path}`
            );
            break;
          case 'plan':
            logger.info(
              { evt: 'fill-progress', type: ev.type, pending: ev.pending, gone: ev.gone, total: ev.total },
              `plan: ${ev.pending} pending · ${ev.gone} gone · ${ev.total} total`
            );
            break;
          case 'entry':
            logger.info(
              { evt: 'fill-progress', type: ev.type, outcome: ev.outcome, url: ev.url },
              `${ev.outcome.padEnd(8)} ${ev.url}`
            );
            break;
          case 'connfail':
            logger.warn(
              { evt: 'fill-connfail', type: ev.type, streak: ev.streak, abortAfter: ev.abortAfter, url: ev.url },
              `connfail ${ev.streak}/${ev.abortAfter} — ${ev.url}`
            );
            break;
          case 'abort':
            logger.warn(
              { evt: 'fill-progress', type: ev.type, streak: ev.streak, pending: ev.pending },
              `ABORT — ${ev.streak} consecutive connection failures; ${ev.pending} left. ` +
                'Re-run when archive.org recovers.'
            );
            break;
          case 'max':
            logger.info(
              { evt: 'fill-progress', type: ev.type, max: ev.max },
              `--max ${ev.max} network attempts reached; re-run to continue.`
            );
            break;
          case 'dry-run':
            logger.info(
              { evt: 'fill-progress', type: ev.type, pending: ev.pending },
              `--dry-run — ${ev.pending} would be fetched; no network touched.`
            );
            break;
        }
      }
    });

    // ONE summary line on stdout (JSON, jq-friendly).
    out(
      JSON.stringify({
        root: flags.root,
        worklist: result.worklist.count,
        pending: result.pending,
        dryRun: result.dryRun,
        ...(result.stats
          ? {
              fetched: result.stats.fetched,
              cached: result.stats.cached,
              deferred: result.stats.deferred,
              gone: result.stats.gone,
              attempts: result.stats.attempted
            }
          : {}),
        aborted: result.aborted
      })
    );

    // Abort = archive.org unreachable → domain failure (exit 1, like `cache
    // add`'s "incomplete"). Deferrals are NORMAL convergence and exit 0 —
    // re-run to finish. Thrown runner errors route through the root bail
    // handler → exit 1.
    if (result.aborted) {
      throw new Error('cache fill aborted: archive.org unreachable — the mirror is incomplete, re-run to resume');
    }
  };
}
