// `waybackify remaster verify` handler — thin front door over the crawl
// package, per Q-T4-B: the load-bearing validator (static escape + determinism
// scan, dynamic strict-serving browser sweep) is spv/waybackify-crawl's
// src/verify.js#runRemasterVerify; this file translates the parsed argv payload
// into a runRemasterVerify() call and maps the verdict to an exit code. The
// dynamic tier's browser code stays entirely inside the crawl package — the CLI
// never imports it.
//
// The engine is imported by workspace specifier and lazily inside the runner,
// so merely loading the CLI surface never pays for it; a test injects
// `deps.runRemasterVerify` (a fake) to exercise the wiring + exit codes offline.

import { EXIT } from '../cli.js';

/** Parse `--tier static,dynamic` into a list; reject anything else. */
function parseTiers(raw, fail) {
  if (raw === undefined) return ['static'];
  const tiers = raw.split(',').map(t => t.trim()).filter(Boolean);
  // An OMITTED --tier defaults to static (above); but an explicitly EMPTY value
  // (`--tier ,` / `--tier " "`) names no tier and must not run — otherwise it
  // verifies nothing and passes vacuously without ever reading the root.
  if (tiers.length === 0) fail('--tier must name at least one of static,dynamic');
  if (tiers.some(t => t !== 'static' && t !== 'dynamic')) fail(`invalid --tier: ${raw} (expected static and/or dynamic)`);
  return tiers;
}

/** Parse a positive-integer flag; reject a non-integer / <1 value. */
function parseSample(raw, fail) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`invalid --sample: ${raw}`);
  return value;
}

/**
 * Build the `remaster verify` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.runRemasterVerify] - the crawl engine (injected → no library load)
 * @param {Function} [deps.formatReport] - the crawl formatter (injected alongside)
 * @returns {Function} paparam runner: ({ flags, out }) => Promise<void>
 */
export function remasterVerifyHandler(deps = {}) {
  return async ({ flags, logger, progressEvery, out = console.log }) => {
    // Progress + findings fold onto the logger (§2); its human stream is stderr,
    // so progress still lands there. stdout (out) stays the report only.

    /** A usage error (exit 2) the root bail handler honors via .exitCode. */
    const fail = message => {
      const e = new Error(`waybackify remaster verify: ${message}`);
      e.exitCode = EXIT.USAGE;
      throw e;
    };

    const tiers = parseTiers(flags.tier, fail);
    const sample = parseSample(flags.sample, fail);

    // Injected fake, or the crawl engine + its formatter (lazy).
    const mod = deps.runRemasterVerify ? deps : await import('@autocache/waybackify-crawl/verify');
    const { runRemasterVerify, formatReport } = mod;

    const report = await runRemasterVerify({
      root: flags.root,
      hermetic: flags.hermetic,
      tiers,
      // paparam registers `--no-determinism` under the name `determinism`
      // (default true); a false value means the user asked to skip the rebuild.
      skipDeterminism: flags.determinism === false,
      sample,
      logger,
      progressEvery
    });

    const rendered = flags.json ? JSON.stringify(report, null, 2) : formatReport(report);
    out(rendered);
    if (flags.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(flags.out, `${rendered}\n`);
    }

    if (!report.pass) {
      // A remastered tree that does not stand alone is a domain failure (exit 1).
      const e = new Error(`waybackify remaster verify: ${flags.root} does not stand alone`);
      e.exitCode = EXIT.DOMAIN;
      throw e;
    }
  };
}
