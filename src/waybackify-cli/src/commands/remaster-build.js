// `waybackify remaster build` handler — thin wiring over the library, per the
// CLI's hard thin-wrapper rule: the load-bearing build (walk meta/, strip
// chrome, localize wayback references, carry sidecars, write a
// content-addressed build record — deterministically) is
// spv/waybackify/remaster.js; this file translates the two positional roots
// into a remaster() call and prints the run summary to stdout (--json for the
// raw record). A build failure throws → domain-failure exit (1).
//
// The library is imported by workspace-relative specifier (both packages are
// private and in-repo) and lazily, inside the runner, so merely loading the
// CLI surface never pays for the import.

import path from 'node:path';

/**
 * Build the `remaster build` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.remaster] - the library entry point
 * @param {Function} [deps.log] - stdout line sink (the summary / JSON)
 * @returns {Function} paparam runner: ({ args, flags }) => Promise<void>
 */
export function remasterBuildHandler(deps = {}) {
  return async ({ args, flags }) => {
    const { log = console.log } = deps;
    const remaster = deps.remaster ?? (await import('@charlie.dev/waybackify/remaster.js')).remaster;

    const hermeticRoot = path.resolve(args.hermeticRoot);
    const remasteredRoot = path.resolve(args.remasteredRoot);
    const report = await remaster(hermeticRoot, remasteredRoot);

    if (flags.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      log(`remaster ${hermeticRoot} → ${remasteredRoot}`);
      log(
        `  ${report.sidecars} sidecars (${report.bodies} bodied) · ` +
          `${report.rewritten} body(ies) rewritten · build ${path.basename(report.buildPath)}` +
          ` (rule v${report.build.ruleVersion} · engine v${report.build.engineVersion})`
      );
    }
  };
}
