// `waybackify cache fill` handler — thin wiring over the library's backfill.js
// engine, per the CLI's hard thin-wrapper rule: the load-bearing loop (durable
// closure-aware worklist, throttle, defer-on-transient, abort-on-connection-
// failure, resume) is src/waybackify/backfill.js. This file translates the
// parsed argv payload into a backfill() call, streams progress to stderr,
// prints one JSON summary line to stdout, and turns an abort into a
// domain-failure exit (1 — the mirror image is incomplete; re-run to resume).
// Under --converge the same options go to the library's converge() instead:
// the pass loop, the backoff, and the stall count are the engine's, not a
// shell script's around this command.
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
 * @param {Function} [deps.converge] - the library's pass loop (--converge)
 * @returns {Function} paparam runner: ({ args, flags, logger, out }) => Promise<void>
 */
export function cacheFillHandler(deps = {}) {
  return async ({ args, flags, logger = NOOP_LOGGER, out = console.log }) => {
    const backfill = deps.backfill ?? (await import('@autocache/waybackify/backfill.js')).backfill;
    const converge = flags.converge
      ? deps.converge ?? (await import('@autocache/waybackify/backfill.js')).converge
      : null;

    // paparam does not coerce flag values — they arrive as strings. Number()
    // the numeric knobs; an absent flag keeps the library default.
    const num = (v, d) => (v === undefined || v === null ? d : Number(v));

    const options = {
      ledgerDir: args.dir,
      // --root|-r is canonical; --against/-o parse under their own names on
      // sibling commands, but fill only speaks --root.
      root: flags.root,
      delayMs: num(flags.delayMs, 1500),
      abortAfter: num(flags.abortAfter, 5),
      throttleAfter: num(flags.throttleAfter, 6),
      requestDelayMs: num(flags.requestDelayMs, 0),
      // paparam registers `--no-requisites` under the name `requisites`,
      // default true (see src/cli.js source-driven note 5).
      requisites: flags.requisites !== false,
      pagesOnly: Boolean(flags.pagesOnly),
      max: num(flags.max, Infinity),
      refresh: Boolean(flags.refresh),
      dryRun: Boolean(flags.dryRun),
      // §4 fetch trace (CDX retries + per-capture doc/requisite fetches).
      logger,
      onProgress(ev) {
        switch (ev.type) {
          case 'worklist':
            logger.info(
              { evt: 'fill-progress', type: ev.type, built: ev.built, reason: ev.reason ?? null, count: ev.count, path: ev.path },
              `worklist: ${ev.built ? `built (${ev.reason ?? 'new'})` : 'reused'} ${ev.count} — ${ev.path}`
            );
            break;
          case 'plan':
            logger.info(
              { evt: 'fill-progress', type: ev.type, pending: ev.pending, gone: ev.gone, total: ev.total, held: ev.held ?? 0 },
              `plan: ${ev.pending} pending · ${ev.gone} gone · ${ev.total} total` +
                (ev.held ? ` · ${ev.held} content captures held (--pages-only)` : '')
            );
            break;
          case 'entry':
            logger.info(
              { evt: 'fill-progress', type: ev.type, outcome: ev.outcome, url: ev.url },
              `${ev.outcome.padEnd(8)} ${ev.url}`
            );
            break;
          case 'rename':
            logger.warn(
              { evt: 'fill-rename', type: ev.type, waybackUrl: ev.waybackUrl, from: ev.from, to: ev.to },
              `rename   ${ev.from} → ${ev.to} (rewrite candidate, not gone)`
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
              { evt: 'fill-progress', type: ev.type, reason: ev.reason ?? 'unreachable', streak: ev.streak, pending: ev.pending },
              ev.reason === 'throttled'
                ? `STOP — ${ev.streak} captures in a row deferred with nothing fetched (archive.org is throttling); ${ev.pending} left. ` +
                  'The next run starts after them.'
                : `ABORT — ${ev.streak} consecutive connection failures; ${ev.pending} left. ` +
                  'Re-run when archive.org recovers.'
            );
            break;
          case 'pass':
            logger.info(
              { evt: 'fill-progress', type: ev.type, pass: ev.pass, ...ev.stats, aborted: ev.aborted, reason: ev.reason ?? null },
              `pass ${ev.pass}: ${ev.stats.fetched} fetched · ${ev.stats.deferred} deferred · ${ev.stats.gone} gone` +
                (ev.aborted ? ` · stopped (${ev.reason})` : '')
            );
            break;
          case 'backoff':
            logger.warn(
              { evt: 'fill-progress', type: ev.type, reason: ev.reason, ms: ev.ms, pass: ev.pass },
              `backing off ${Math.round(ev.ms / 1000)}s (${ev.reason})`
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
    };

    let result;
    let loop = null;
    if (converge) {
      loop = await converge({
        ...options,
        backoffMs: num(flags.backoffS, 300) * 1000,
        backoffMaxMs: num(flags.backoffMaxS, 1800) * 1000,
        maxStall: num(flags.maxStall, 6)
      });
      result = loop.last;
    } else {
      result = await backfill(options);
    }

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
        aborted: result.aborted,
        // Fields exist iff meaningful: `reason` only on a stop, the loop's
        // verdict only under --converge (where the counts above are the LAST
        // pass's and `totals` is the whole run's).
        ...(result.reason ? { reason: result.reason } : {}),
        ...(loop ? { passes: loop.passes, converged: loop.converged, stalled: loop.stalled, totals: loop.totals } : {})
      })
    );

    if (loop) {
      if (!loop.converged) {
        throw new Error(
          loop.stalled
            ? `cache fill did not converge: ${result.stats?.deferred ?? 0} capture(s) still deferred after ${loop.passes} passes — they are not transient; see cache status`
            : 'cache fill did not converge — re-run to resume'
        );
      }
      return;
    }

    // Abort = archive.org unreachable → domain failure (exit 1, like `cache
    // add`'s "incomplete"). Deferrals are NORMAL convergence and exit 0 —
    // re-run to finish. Thrown runner errors route through the root bail
    // handler → exit 1.
    if (result.aborted) {
      throw new Error(
        result.reason === 'throttled'
          ? 'cache fill stopped: archive.org is throttling — the mirror is incomplete, re-run later to resume'
          : 'cache fill aborted: archive.org unreachable — the mirror is incomplete, re-run to resume'
      );
    }
  };
}
