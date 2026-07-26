#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js;
// all six commands — manifest, rewrite, ledger, check, search, and cache —
// are wired to real handlers; the exit-70 scaffold era is over.
// process.exitCode (not process.exit) so stdout/stderr flush naturally
// before the process ends.
import { run } from '../src/cli.js';
import { cacheHandler } from '../src/commands/cache.js';
import { checkHandler } from '../src/commands/check.js';
import { ledgerHandler } from '../src/commands/ledger.js';
import { manifestHandler } from '../src/commands/manifest.js';
import { rewriteHandler } from '../src/commands/rewrite.js';
import { searchHandler } from '../src/commands/search.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    manifest: manifestHandler(),
    rewrite: rewriteHandler(),
    ledger: ledgerHandler(),
    check: checkHandler(),
    search: searchHandler(),
    cache: cacheHandler()
  }
});
