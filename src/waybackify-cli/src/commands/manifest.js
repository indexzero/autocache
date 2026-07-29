// `waybackify manifest` handler — GENERATION (surface v2, #386): thin wiring
// over the library's manifest.js#generate, per the CLI's hard thin-wrapper
// rule. The load-bearing pipeline (link extraction, universe subset baking,
// seen-union lookup, archive resolution, canonical serialization) is
// spv/waybackify — this file translates the parsed argv payload into file
// reads, one generate() call, and file writes.
//
// Contract (pinned by --help and the command tests):
//   - reads <source.md> (the pristine, live-link form), -u/--universe
//     (required), and -s/--seen when given AND present on disk (a missing
//     seen file is an empty union — the bootstrap case);
//   - writes the canonical manifest to -o/--output and, when -s was given,
//     writes the extended seen union BACK to the same path (read-write);
//   - prints ONE JSON stats line on stdout
//     ({output, urls, fromUniverse, fromSeen, resolved, deferred});
//   - idempotent: a rerun with the same seen file answers every url from the
//     universe/seen (zero network) and rewrites byte-identical files;
//   - --offline swaps the resolver for one that always throws, so every url
//     the universe and seen file cannot answer lands in `deferred` — and any
//     deferral (offline or a real resolver failure) exits 1 AFTER writing
//     the partial manifest + seen: verdicts already obtained are kept, and a
//     rerun resumes instead of restarting.
//
// The library is imported by workspace-relative specifier (both packages are
// private and in-repo) and lazily, inside the runner, so merely loading the
// CLI surface never pays for the library import.

import fs from 'node:fs';

/**
 * Build the manifest handler. Dependency-injectable for tests; the bin wires
 * the defaults.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.generate] - the library entry point (manifest.js#generate)
 * @param {Function} [deps.readManifest] - seen-file reader
 * @param {Function} [deps.writeManifest] - canonical writer (manifest + seen)
 * @param {Function} [deps.readUniverse] - universe-file reader
 * @param {Function} [deps.resolve] - archive resolver override (offline tests)
 * @param {Function} [deps.log] - stdout line sink (the stats JSON)
 * @param {Function} [deps.error] - stderr line sink (deferred urls)
 * @returns {Function} paparam runner: ({ args, flags }) => Promise<void>
 */
export function manifestHandler(deps = {}) {
  return async ({ args, flags }) => {
    const { log = console.log, error = console.error } = deps;
    const generate = deps.generate ?? (await import('waybackify/manifest.js')).generate;
    const readManifest = deps.readManifest ?? (await import('waybackify/manifest.js')).readManifest;
    const writeManifest = deps.writeManifest ?? (await import('waybackify/manifest.js')).writeManifest;
    const readUniverse = deps.readUniverse ?? (await import('waybackify/universe.js')).readUniverse;

    const source = fs.readFileSync(args.source, 'utf8');
    const universe = readUniverse(flags.universe);
    // -s names the read-write union; absent-on-disk reads as the empty union
    // (generate() treats null as empty) so the very first run bootstraps it.
    const seen = flags.seen && fs.existsSync(flags.seen) ? readManifest(flags.seen) : null;

    const options = {};
    // --near passes straight through to generate → resolve(url, { near }):
    // the library picks the archive capture closest to this timestamp for
    // never-seen urls (covered/seen urls are answered offline, unaffected).
    if (flags.near) options.near = flags.near;
    if (flags.offline) {
      // Offline resolution: the resolver never runs the network — it throws,
      // generate() records the url in `deferred`, and the exit-1 path below
      // fails the run with every unresolved url surfaced.
      options.resolve = url => {
        throw new Error('offline: not answered by the universe or seen file');
      };
    } else if (deps.resolve) {
      options.resolve = deps.resolve;
    }

    const result = await generate(source, universe, seen, options);

    // Write order: manifest first (the artifact -o names), then the seen
    // union — the RETURNED seen (a normalized, extended copy), per the
    // library's read-write contract.
    writeManifest(flags.output, result.manifest);
    if (flags.seen) writeManifest(flags.seen, result.seen);

    // ONE JSON stats line on stdout (jq/xargs-friendly, like cache's summary).
    log(
      JSON.stringify({
        output: flags.output,
        urls: result.stats.urls,
        fromUniverse: result.stats.fromUniverse,
        fromSeen: result.stats.fromSeen,
        resolved: result.stats.resolved,
        deferred: result.deferred.length
      })
    );

    if (result.deferred.length > 0) {
      for (const d of result.deferred) error(`unresolved: ${d.url}: ${d.error}`);
      // Thrown runner errors route through the root bail handler → exit 1
      // (domain failure — the manifest is incomplete; the partial output +
      // extended seen file make the rerun cheap).
      throw new Error(
        `manifest incomplete: ${result.deferred.length} url(s) unresolved — ` +
          (flags.offline ? 'rerun without --offline to resolve' : 'rerun to resume')
      );
    }
  };
}
