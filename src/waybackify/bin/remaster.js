#!/usr/bin/env node
// Remaster front door — a thin wrapper over ../remaster.js (thin-CLI rule:
// no logic here, just arg parsing + a summary printer). Reads a hermetic
// cache root and writes a standalone remastered root: chrome stripped,
// wayback references localized, sidecars carried over, a build record at
// the root.
//
// Shipped as a bin (not a `waybackify remaster` subcommand) on purpose: the
// spv/waybackify-cli command tree is a pinned surface (its help text is
// snapshot-tested), and remaster is a build step, not one of the CLI's
// human-operable capture verbs. See the PR's "would have asked" section.
//
// Usage:
//   node spv/waybackify/bin/remaster.js <hermetic-root> <remastered-root>
//     <hermetic-root>     sealed cache root to read (contains cap/ meta/)
//     <remastered-root>   output root to write (created; supply a fresh dir)
//     --json              emit the run summary as JSON
//     -h, --help          print this usage and exit
//
// Exit: 0 on success; 2 on a usage error; 1 on a build failure.

import path from 'node:path';
import { remaster } from '../remaster.js';

const USAGE = `Usage: node bin/remaster.js <hermetic-root> <remastered-root> [--json]

Remaster a hermetic cache root into a standalone remastered root — chrome
stripped, wayback references localized to /web/<ts><flag>/<orig>, sidecars
carried over, a content-addressed build record written at the root.`;

function parseArgs(argv) {
  const args = { positionals: [], json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else args.positionals.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.positionals.length !== 2) {
    console.error('remaster: expected <hermetic-root> <remastered-root>\n');
    console.error(USAGE);
    return 2;
  }

  const [hermeticRoot, remasteredRoot] = args.positionals.map(p => path.resolve(p));
  const report = await remaster(hermeticRoot, remasteredRoot);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`remaster ${hermeticRoot} → ${remasteredRoot}`);
    console.log(
      `  ${report.sidecars} sidecars (${report.bodies} bodied) · ` +
        `${report.rewritten} body(ies) rewritten · build ${path.basename(report.buildPath)}` +
        ` (rule v${report.build.ruleVersion} · engine v${report.build.engineVersion})`
    );
  }
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`remaster: ${error.message}`);
    process.exit(1);
  });
