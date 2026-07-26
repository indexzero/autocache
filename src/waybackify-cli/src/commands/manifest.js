// `waybackify manifest` handler — thin wiring over the library, per the CLI's
// hard thin-wrapper rule: the load-bearing enumeration (the balanced-paren
// scanner, manifest schema, dedupe, deterministic order) is
// spv/waybackify/manifest.js#sourceRefs; this file translates the parsed argv
// payload into sourceRefs() calls and prints one JSONL row per reference.
//
// VOCABULARY SHIM (#385 → #386): the library now speaks the settled
// vocabulary — a wayback.json is a MANIFEST, its refs carry
// source: 'manifest', and file paths are identity (no id derivation from
// directory layout anywhere in these packages). This command's OUTPUT,
// however, is the pinned
// v1 surface ({post, source: inline|ledger, ...} rows, a `--ledger` flag),
// so the handler maps the library's terms back onto the pinned field names
// below. #386 replaces this command wholesale (manifest = generation,
// ledger = collection discovery) and deletes the shim with it.
//
// Per-file by design (corpus/tree awareness is NOT built in — that's
// `find <dir> -name '*.md' | xargs waybackify manifest`). Accepts one or
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
 * @param {Function} [deps.sourceRefs] - the library entry point
 * @param {Function} [deps.log] - stdout line sink (one JSONL row per ref)
 * @returns {Function} paparam runner: ({ args, flags, positionals }) => Promise<void>
 */
export function manifestHandler(deps = {}) {
  return async ({ args, flags, positionals }) => {
    const { log = console.log } = deps;
    const sourceRefs = deps.sourceRefs ?? (await import('waybackify/manifest.js')).sourceRefs;

    // `positionals` is every file the invocation named — one from a plain call,
    // many from an xargs batch (src/cli.js makes the manifest command loose on
    // args). validate() guarantees at least args.file; fall back to it so the
    // handler works under direct injection too.
    const files = positionals?.length ? positionals : [args.file];

    for (const file of files) {
      for (const ref of sourceRefs(file, { manifest: Boolean(flags.ledger) })) {
        // The pinned CLI contract: JSONL, one {post, source, timestamp,
        // originalUrl, waybackUrl} object per line (jq/xargs-friendly).
        // `post` is the file path (paths are identity now) and a manifest
        // ref is spelled `ledger` — the v1 surface vocabulary (see header).
        log(
          JSON.stringify({
            post: ref.path,
            source: ref.source === 'manifest' ? 'ledger' : ref.source,
            timestamp: ref.timestamp,
            originalUrl: ref.originalUrl,
            waybackUrl: ref.waybackUrl
          })
        );
      }
    }
  };
}
