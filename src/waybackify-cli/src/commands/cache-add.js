// `waybackify cache add` handler — thin wiring over the library, per the
// CLI's hard thin-wrapper rule: the load-bearing implementation (layout, write protocol,
// resume, requisites) is spv/waybackify/cache.js; this file translates the
// parsed argv payload into a cacheCapture() call, streams progress to
// stderr, prints the summary line to stdout, and turns requisite failures
// into a domain-failure exit (1).
//
// The library is imported by workspace-relative path (both packages are
// private and in-repo; see render/wayback/src/key.ts for the same-shaped
// note) and lazily, inside the factory, so merely loading the CLI surface
// (src/cli.js, --help, the other commands) never pays for impit.
//
// Cache-root data structure: docs/CACHE.md. Consumer contract: docs/SERVE.md.

/**
 * Build the `cache add` handler. Dependency-injectable for tests; the bin wires
 * the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.cacheCapture] - the library entry point
 * @param {Function} [deps.log] - stdout line sink (summary)
 * @param {Function} [deps.error] - stderr line sink (progress + failures)
 * @returns {Function} paparam runner: ({ args, flags }) => Promise<void>
 */
export function cacheAddHandler(deps = {}) {
  return async ({ args, flags }) => {
    const { log = console.log, error = console.error } = deps;
    const cacheCapture = deps.cacheCapture ?? (await import('waybackify/cache.js')).cacheCapture;

    const summary = await cacheCapture(args.waybackUrl, {
      // --root|-r is canonical; --output|-o is the deprecated alias (cli.js).
      root: flags.root ?? flags.output,
      // paparam registers `--no-requisites` under the name `requisites`,
      // default true (see src/cli.js source-driven note 5).
      requisites: flags.requisites,
      onEntry({ key, status, action, flag }) {
        error(`${action.padEnd(7)} ${status.padEnd(8)} ${flag ?? '   '} ${key}`);
      }
    });

    // The CLI contract: files under the shared key scheme; ONE summary
    // line on stdout (JSON, jq/xargs-friendly).
    log(
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
      for (const f of summary.failures) error(`failed: ${f.key}: ${f.error}`);
      // Thrown runner errors route through the root bail handler → exit 1
      // (domain failure — the mirror image is incomplete; rerun to resume).
      throw new Error(`cache add incomplete: ${summary.failures.length} requisite(s) failed — rerun to resume`);
    }
  };
}
