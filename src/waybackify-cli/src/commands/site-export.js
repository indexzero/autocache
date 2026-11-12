// `waybackify site export` handler — thin wiring over
// @autocache/waybackify-site, per the CLI's hard thin-wrapper rule: the path
// plan, the collision handling, and every file written are that package's
// exportTree(). This file translates the parsed argv payload into that call
// and prints one JSON summary line on stdout.
//
// Design: docs/SITE.md.

/**
 * Build the `site export` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.exportTree] - the package entry point
 * @returns {Function} paparam runner: ({ args, flags, out }) => Promise<void>
 */
export function siteExportHandler(deps = {}) {
  return async ({ args, flags, out = console.log }) => {
    const exportTree = deps.exportTree ?? (await import('@autocache/waybackify-site/export')).exportTree;
    const summary = exportTree(flags.root, flags.out, { ledger: args.dir, dryRun: Boolean(flags.dryRun) });
    // ONE summary line on stdout (JSON, jq-friendly).
    out(JSON.stringify(summary));
  };
}
