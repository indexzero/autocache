#!/usr/bin/env node
// Cache-store fsck front door — a thin wrapper over ../fsck.js (thin-CLI
// rule: no logic here, just arg parsing + a summary printer). Verifies a
// populated cache root against its own sidecars; REPORT-ONLY by default,
// `--fix` opts into reaping orphan cap/ + stale tmp/ (never valid entries,
// never corruption). Exits non-zero when discrepancies remain.
//
// Usage:
//   node spv/waybackify/bin/fsck.js --root <dir> [options]
//     --root <dir>   store root to check (REQUIRED) — contains cap/ meta/ tmp/
//     --fix          reap orphan cap/ files + stale tmp/ scratch (opt-in);
//                    refuses to touch hash/key mismatches — those are
//                    corruption to investigate, reported loudly
//     --json         emit the raw report as JSON (for tooling/checkpoints)
//     --quiet        summary line + findings only (suppress the per-category
//                    "ok" lines)
//     -h, --help     print this usage and exit
//
// Exit: 0 when the store is clean (or made clean by --fix); 1 when
// discrepancies remain; 2 on a usage error.

import path from 'node:path';
import { fsck, CATEGORIES, totalFindings, unresolvedFindings } from '../fsck.js';

const USAGE = `Usage: node bin/fsck.js --root <dir> [--fix] [--json] [--quiet]

Verify a waybackify cache root against its own sidecars (report-only by
default). --fix reaps orphan cap/ files and stale tmp/ scratch — nothing else.`;

function parseArgs(argv) {
  const args = { root: null, fix: false, json: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--root') args.root = path.resolve(next());
    else if (a === '--fix') args.fix = true;
    else if (a === '--json') args.json = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

/** One human line per finding — enough to locate and explain it on disk. */
function describe(category, f) {
  switch (category) {
    case 'malformed':
      return `${f.aa}/${f.hash}.json — ${f.error}`;
    case 'hashMismatch':
      return `${f.aa}/${f.hash}  expected ${f.expected} · got ${f.actual}  (key: ${f.key})`;
    case 'keyMismatch':
      return `${f.aa}/${f.hash}  key hashes to ${f.derived}  (key: ${f.key})`;
    case 'missingBody':
      return `${f.aa}/${f.hash}  (key: ${f.key})`;
    case 'schemaVersion':
      return `${f.aa}/${f.hash}  v=${f.v}  (key: ${f.key})`;
    case 'foreignRoot':
      return `${f.name}${f.isDir ? '/' : ''}`;
    case 'orphanCap':
      return `${f.aa}/${f.hash}`;
    case 'staleTmp':
      return `${f.name}`;
    default:
      return JSON.stringify(f);
  }
}

function printReport(report, args) {
  const { counts } = report;
  console.log(`fsck ${report.root}`);
  console.log(
    `  inventory: ${counts.sidecars} sidecars (${counts.bodies} bodied) · ` +
      `${counts.capFiles} cap/ files · ${counts.tmpFiles} tmp/ entries · schema v${report.schemaVersion}`
  );
  console.log('');

  for (const { key, label, severity } of CATEGORIES) {
    const hits = report.findings[key];
    if (hits.length === 0) {
      if (!args.quiet) console.log(`  ${'ok'.padEnd(6)} ${label}`);
      continue;
    }
    const reaped = report.reaped?.[key]?.length ?? 0;
    const tag = severity === 'reapable' ? (reaped === hits.length ? 'reaped' : 'REAP') : severity === 'advisory' ? 'flag' : 'FAIL';
    console.log(`  ${tag.padEnd(6)} ${label}: ${hits.length}${reaped ? ` (${reaped} reaped)` : ''}`);
    for (const f of hits) {
      const mark = report.reaped?.[key]?.includes(f.path) ? '×' : '-';
      console.log(`        ${mark} ${describe(key, f)}${f.reapError ? `  [reap failed: ${f.reapError}]` : ''}`);
    }
  }

  console.log('');
  const total = totalFindings(report);
  const unresolved = unresolvedFindings(report);
  if (total === 0) {
    console.log('  clean — every sidecar verifies against its body; no orphans, no stragglers.');
  } else if (report.reaped) {
    console.log(`  ${total} finding(s); reaped ${total - unresolved}; ${unresolved} unresolved.`);
  } else {
    console.log(`  ${total} finding(s) — report-only (pass --fix to reap orphan cap/ + stale tmp/).`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.root) {
    console.error('fsck: --root <dir> is required\n');
    console.error(USAGE);
    return 2;
  }

  const report = await fsck(args.root, { fix: args.fix });

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, args);

  return unresolvedFindings(report) > 0 ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`fsck: ${error.message}`);
    process.exit(2);
  });
