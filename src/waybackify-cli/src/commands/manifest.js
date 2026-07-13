// `waybackify manifest` handler — thin wiring over the library, per the CLI's
// hard thin-wrapper rule: the load-bearing enumeration (the balanced-paren
// scanner, ledger schema, dedupe, deterministic order, post-id derivation)
// is spv/waybackify/enumerate.js; this file translates the parsed argv payload
// into enumerateFile() calls and prints one JSONL row per reference.
//
// Per-file by design (corpus/tree awareness is NOT built in — that's
// `find words -name index.md | xargs waybackify manifest`). Accepts one or
// more markdown files so the xargs walk works verbatim; each file is
// enumerated in argv order, its refs deduped within the file. Inline links
// only by default; --ledger folds in each file's sibling wayback.json.
//
// The library is imported by workspace-relative specifier (both packages are
// private and in-repo; see render/wayback/src/key.ts for the same-shaped note)
// and lazily, inside the factory, so merely loading the CLI surface never pays
// for the library import.

/**
 * Build the manifest handler. Dependency-injectable for tests; the bin wires
 * the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.enumerateFile] - the library entry point
 * @param {Function} [deps.log] - stdout line sink (one JSONL row per ref)
 * @returns {Function} paparam runner: ({ args, flags, positionals }) => Promise<void>
 */
export function manifestHandler(deps = {}) {
  return async ({ args, flags, positionals }) => {
    const { log = console.log } = deps;
    const enumerateFile = deps.enumerateFile ?? (await import('waybackify/enumerate.js')).enumerateFile;

    // `positionals` is every file the invocation named — one from a plain call,
    // many from an xargs batch (src/cli.js makes the manifest command loose on
    // args). validate() guarantees at least args.file; fall back to it so the
    // handler works under direct injection too.
    const files = positionals?.length ? positionals : [args.file];

    for (const file of files) {
      for (const ref of enumerateFile(file, { ledger: Boolean(flags.ledger) })) {
        // The CLI contract: JSONL, one {post, source, timestamp, originalUrl,
        // waybackUrl} object per line (jq/xargs-friendly).
        log(
          JSON.stringify({
            post: ref.post,
            source: ref.source,
            timestamp: ref.timestamp,
            originalUrl: ref.originalUrl,
            waybackUrl: ref.waybackUrl
          })
        );
      }
    }
  };
}
