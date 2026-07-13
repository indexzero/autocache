#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js;
// all four commands — check, search, manifest, and cache — are wired
// to real handlers; the exit-70 scaffold era is over.
// process.exitCode (not process.exit) so stdout/stderr flush naturally
// before the process ends.
import { run } from '../src/cli.js';
import { cacheHandler } from '../src/commands/cache.js';
import { checkHandler } from '../src/commands/check.js';
import { manifestHandler } from '../src/commands/manifest.js';
import { searchHandler } from '../src/commands/search.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    check: checkHandler(),
    search: searchHandler(),
    manifest: manifestHandler(),
    cache: cacheHandler()
  }
});
