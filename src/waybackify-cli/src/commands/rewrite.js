// `waybackify rewrite` handler — APPLICATION (surface v2, #386): thin wiring
// over the library's manifest.js#apply, per the CLI's hard thin-wrapper rule.
//
// NOTE the name: this FILE is the CLI command `rewrite`; the library module
// spv/waybackify/rewrite.js is the remaster capture-body rewriter and is a
// different thing entirely. The manifest applier is manifest.js#apply — this
// handler adds NO rewrite logic of its own (precedence, fence/link-text
// guards, and the match key all live in the library).
//
// Contract (pinned by --help and the command tests):
//   - reads <source.md> (pristine, live-link form) and -m/--manifest
//     (versions {1, 2}; v1 nulls read as exclude);
//   - writes apply()'s output to -o/--output, ALWAYS — even when some urls
//     had no verdict (they pass through untouched, so the artifact is still
//     the best available published form);
//   - nothing on stdout; warnings (`no verdict: <url>`) go to stderr and the
//     run exits 1 — an uncovered url is surfaced, never guessed at, and a
//     pipeline must notice (the same conservative composition that makes
//     check's suspect verdict nonzero).
//
// The library is imported by workspace-relative specifier and lazily, inside
// the runner, so merely loading the CLI surface never pays for the import.

import fs from 'node:fs';

/**
 * Build the rewrite handler. Dependency-injectable for tests; the bin wires
 * the defaults.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.apply] - the library entry point (manifest.js#apply)
 * @param {Function} [deps.readManifest] - manifest reader
 * @param {Function} [deps.error] - stderr line sink (no-verdict warnings)
 * @returns {Function} paparam runner: ({ args, flags }) => Promise<void>
 */
export function rewriteHandler(deps = {}) {
  return async ({ args, flags }) => {
    const { error = console.error } = deps;
    const apply = deps.apply ?? (await import('@charlie.dev/waybackify/manifest.js')).apply;
    const readManifest = deps.readManifest ?? (await import('@charlie.dev/waybackify/manifest.js')).readManifest;

    const source = fs.readFileSync(args.source, 'utf8');
    // --chrome-host threads the #453 host swap; omit it and apply defaults to
    // DEFAULT_CHROME_HOST (a generic placeholder). paparam camelCases the flag.
    const options = flags.chromeHost ? { chromeHost: flags.chromeHost } : undefined;
    const { content, warnings } = apply(source, readManifest(flags.manifest), options);

    fs.writeFileSync(flags.output, content);

    if (warnings.length > 0) {
      for (const url of warnings) error(`no verdict: ${url}`);
      // Thrown runner errors route through the root bail handler → exit 1
      // (domain failure — the manifest does not cover this source).
      throw new Error(`rewrite incomplete: ${warnings.length} url(s) had no verdict — left untouched`);
    }
  };
}
