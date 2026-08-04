// `waybackify ledger` handler — the COLLECTION (surface v2, #386): thin
// wiring over the library's ledger.js (discover / flatten / against), per the
// CLI's hard thin-wrapper rule. File paths are identity throughout — no
// directory-layout conventions, no id derivation.
//
// Three modes (pinned by --help and the command tests; --flatten and
// --against are mutually exclusive at the argv surface):
//
//   default    discovery — one JSONL row per manifest under <dir>:
//              {file, entries, rewrites, exclude} (section COUNTS; the row
//              is a survey line, not the manifest body)
//   --flatten  the union manifest, canonical JSON on stdout — redirect it to
//              bootstrap a seen file for `waybackify manifest`
//   --against  the fetch-worklist join — one JSONL row per referenced
//              capture, key-sorted: {state: unfetched|cached|interstitial|
//              error, key, waybackUrl, timestamp, originalUrl, files, status}
//
// A missing <dir> is a domain failure (exit 1), not an empty ledger — the
// library's discover() reads absence as "no manifests", but a CLI user's
// typo'd path must fail loud, not print nothing.
//
// The library is imported by workspace-relative specifier and lazily, inside
// the runner, so merely loading the CLI surface never pays for the import.

import fs from 'node:fs';

/**
 * Build the ledger handler. Dependency-injectable for tests; the bin wires
 * the defaults.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.discover] - ledger.js#discover
 * @param {Function} [deps.flatten] - ledger.js#flatten
 * @param {Function} [deps.against] - ledger.js#against
 * @param {Function} [deps.canonicalize] - manifest.js#canonicalize (--flatten output)
 * @returns {Function} paparam runner: ({ args, flags, out }) => Promise<void>
 *   — `out` (the stdout result sink) is run()-wired. This command emits no
 *   diagnostics, so it takes no `logger`.
 */
export function ledgerHandler(deps = {}) {
  return async ({ args, flags, out = console.log }) => {
    const discover = deps.discover ?? (await import('@charlie.dev/waybackify/ledger.js')).discover;

    if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
      // Domain failure via the root bail handler → exit 1.
      throw new Error(`no such directory: ${args.dir}`);
    }

    const discovered = discover(args.dir);

    if (flags.flatten) {
      const flatten = deps.flatten ?? (await import('@charlie.dev/waybackify/ledger.js')).flatten;
      const canonicalize = deps.canonicalize ?? (await import('@charlie.dev/waybackify/manifest.js')).canonicalize;
      // ONE canonical JSON document (not JSONL): the same serialization
      // writeManifest uses, so `ledger <dir> --flatten > seen.json` yields a
      // file byte-compatible with what `manifest -s` writes back.
      out(JSON.stringify(canonicalize(flatten(discovered)), null, 2));
      return;
    }

    // --root|-r is canonical; --against is the deprecated alias (cli.js).
    const root = flags.root ?? flags.against;
    if (root) {
      const against = deps.against ?? (await import('@charlie.dev/waybackify/ledger.js')).against;
      const worklists = await against(discovered, root);
      const rows = [];
      for (const [state, items] of Object.entries(worklists)) {
        for (const item of items) rows.push({ state, ...item });
      }
      // One deterministic stream, key-sorted (the library key-sorts within
      // each worklist with default string ordering — match it exactly here
      // while interleaving them back into one stream). Filtering is the
      // consumer's job: `… | jq -r 'select(.state=="unfetched")'`.
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const r of rows) {
        out(
          JSON.stringify({
            state: r.state,
            key: r.key,
            waybackUrl: r.waybackUrl,
            timestamp: r.timestamp,
            originalUrl: r.originalUrl,
            files: r.files,
            status: r.status
          })
        );
      }
      return;
    }

    for (const { file, manifest } of discovered) {
      out(
        JSON.stringify({
          file,
          entries: Object.keys(manifest.entries).length,
          rewrites: Object.keys(manifest.rewrites).length,
          exclude: manifest.exclude.length
        })
      );
    }
  };
}
