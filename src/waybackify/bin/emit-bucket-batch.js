#!/usr/bin/env node
// Emit the cap/ bucket-population batch for a cache root (#291).
//
// Thin wrapper over ../bucket-batch.js — all logic lives there (the thin-CLI
// rule). Walks <root>/meta/ and prints one `s5cmd run` command line per entry
// to stdout, ready to pipe:
//
//   node spv/waybackify/bin/emit-bucket-batch.js --root <root> --bucket <name> \
//     --empty-file "$EMPTY" | s5cmd --endpoint-url <ep> run
//
// See spv/waybackify-cli/docs/SYNC.md for the full population runbook (both
// targets, creds, the meta/ pass, verification).
//
// Usage:
//   --root <dir>          cache root (the archive of record) — REQUIRED
//   --bucket <name>       target bucket ('name' or 's3://name[/prefix]') — REQUIRED
//   --empty-file <path>   zero-byte scratch file for bodiless entries (status
//                         empty/redirect/error). REQUIRED iff the root has any.
//                         Create it OUTSIDE the root: EMPTY="$(mktemp)".
//   --dry-run             emit NOTHING to stdout; write the batch + a summary to
//                         stderr for spot-checking (an accidental `| s5cmd run`
//                         is then a no-op).

import { fileURLToPath } from 'node:url';
import { emitBucketBatch } from '../bucket-batch.js';

function parseArgs(argv) {
  const args = { root: null, bucket: null, emptyFile: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--root') args.root = next();
    else if (a === '--bucket') args.bucket = next();
    else if (a === '--empty-file') args.emptyFile = next();
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (!args.root) throw new Error('--root <dir> is required');
  if (!args.bucket) throw new Error('--bucket <name> is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const { lines, summary } = await emitBucketBatch(args.root, { bucket: args.bucket, emptyFile: args.emptyFile });

  const sink = args.dryRun ? process.stderr : process.stdout;
  if (lines.length > 0) sink.write(lines.join('\n') + '\n');
  process.stderr.write(
    `emit-bucket-batch: ${summary.total} objects (${summary.bodied} bodied, ${summary.bodiless} bodiless)` +
      `${args.dryRun ? ' — dry-run, nothing written to stdout' : ''}\n`
  );
}

// Guard so tests can import this bin without triggering main().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(`emit-bucket-batch: ${error.message}`);
    process.exit(1);
  });
}
