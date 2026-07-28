#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js; every command
// is wired to a real handler — the flat verbs (manifest, rewrite, ledger,
// check, search) plus the `cache` group's five subcommands (add, fill, verify,
// remaster, sync). The exit-70 scaffold era is over. process.exitCode (not
// process.exit) so stdout/stderr flush naturally before the process ends.
import { run } from '../src/cli.js';
import { cacheAddHandler } from '../src/commands/cache-add.js';
import { cacheFillHandler } from '../src/commands/cache-fill.js';
import { cacheRemasterHandler } from '../src/commands/cache-remaster.js';
import { cacheSyncHandler } from '../src/commands/cache-sync.js';
import { cacheVerifyHandler } from '../src/commands/cache-verify.js';
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
    cacheAdd: cacheAddHandler(),
    cacheFill: cacheFillHandler(),
    cacheVerify: cacheVerifyHandler(),
    cacheRemaster: cacheRemasterHandler(),
    cacheSync: cacheSyncHandler()
  }
});
