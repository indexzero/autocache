// `waybackify cache add` handler — thin wiring over the library, per the
// CLI's hard thin-wrapper rule: the load-bearing implementation (layout, write
// protocol, resume, requisites) is spv/waybackify/cache.js; this file
// translates the parsed argv payload into a cacheCapture() call, streams
// progress + failures through the injected `logger` (stderr), prints the one
// summary line to the run()-wired `out` seam (stdout), and turns requisite
// failures into a domain-failure exit (1).
//
// The library is imported by workspace-relative path and lazily, inside the
// runner, so merely loading the CLI surface never pays for the fetch stack.
//
// Cache-root data structure: docs/CACHE.md. Consumer contract: docs/SERVE.md.

/**
 * Build the `cache add` handler. Dependency-injectable for tests; the bin wires
 * the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.cacheCapture] - the library entry point
 * @returns {Function} paparam runner: ({ args, flags, logger, out }) => Promise<void>
 *   — `out` (stdout result) and `logger` (stderr diagnostics) are run()-wired.
 */
export function cacheAddHandler(deps = {}) {
  return async ({ args, flags, logger, out = console.log }) => {
    const cacheCapture = deps.cacheCapture ?? (await import('@autocache/waybackify/cache.js')).cacheCapture;

    const summary = await cacheCapture(args.waybackUrl, {
      // --root|-r is canonical; --output|-o is the deprecated alias (cli.js).
      root: flags.root ?? flags.output,
      // paparam registers `--no-requisites` under the name `requisites`,
      // default true (see src/cli.js source-driven note 5).
      requisites: flags.requisites,
      // The §4 request/response firehose (doc + requisites) → the injected logger.
      logger,
      // Per-entry progress — a structured record (queryable in the NDJSON sink)
      // carrying a human line for the TTY. Not the §4 trace vocabulary, so the
      // label lives here, not in logger.js's formatTrace.
      onEntry: ({ key, status, action, flag }) =>
        logger.info(
          { evt: 'cache-entry', key, status, action, flag },
          `${action.padEnd(7)} ${status.padEnd(8)} ${flag ?? '   '} ${key}`
        )
    });

    // The CLI contract: ONE summary line on stdout (JSON, jq/xargs-friendly).
    // This is the command's RESULT — the run()-wired `out` seam, distinct from
    // the logger, whose diagnostics are stderr-only.
    out(
      JSON.stringify({
        key: summary.key,
        hash: summary.hash,
        root: summary.root,
        entries: summary.entries.length,
        fetched: summary.fetched,
        skipped: summary.skipped,
        failed: summary.failures.length
      })
    );

    if (summary.failures.length > 0) {
      for (const f of summary.failures) logger.error({ evt: 'cache-fail', key: f.key, error: f.error }, `failed: ${f.key}: ${f.error}`);
      // Thrown runner errors route through the root bail handler → exit 1
      // (domain failure — the mirror image is incomplete; rerun to resume).
      throw new Error(`cache add incomplete: ${summary.failures.length} requisite(s) failed — rerun to resume`);
    }
  };
}
