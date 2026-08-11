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
 * @returns {Function} paparam runner: ({ args, flags, out, logger }) => Promise<void>
 *   where `out` (stdout line sink) and `logger` (stderr diagnostics) are
 *   run()-wired into the handler payload.
 */
export function remasterBuildHandler(deps = {}) {
  return async ({ args, flags, logger, progressEvery, out = console.log }) => {
    const remaster = deps.remaster ?? (await import('@autocache/waybackify/remaster.js')).remaster;

    const hermeticRoot = path.resolve(args.hermeticRoot);
    const remasteredRoot = path.resolve(args.remasteredRoot);
    // Silent-loop progress (§6): the long rewrite speaks every --progress-every.
    const report = await remaster(hermeticRoot, remasteredRoot, { logger, progressEvery });

    if (flags.json) {
      out(JSON.stringify(report, null, 2));
    } else {
      out(`remaster ${hermeticRoot} → ${remasteredRoot}`);
      out(
        `  ${report.sidecars} sidecars (${report.bodies} bodied) · ` +
          `${report.rewritten} body(ies) rewritten · build ${path.basename(report.buildPath)}` +
          ` (rule v${report.build.ruleVersion} · engine v${report.build.engineVersion})`
      );
    }
  };
}
