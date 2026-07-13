#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js;
// implemented handlers are wired here as they land (check, search and cache
// are real; manifest still exits 70).
// process.exitCode (not process.exit) so stdout/stderr flush naturally
// before the process ends.
import { run } from '../src/cli.js';
import { cacheHandler } from '../src/commands/cache.js';
import { checkHandler } from '../src/commands/check.js';
import { searchHandler } from '../src/commands/search.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    check: checkHandler(),
    search: searchHandler(),
    cache: cacheHandler()
  }
});
