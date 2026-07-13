#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js;
// implemented handlers are wired here as they land (search and cache are real;
// check and manifest still exit 70).
// process.exitCode (not process.exit) so stdout/stderr flush naturally
// before the process ends.
import { run } from '../src/cli.js';
import { cacheHandler } from '../src/commands/cache.js';
import { searchHandler } from '../src/commands/search.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    search: searchHandler(),
    cache: cacheHandler()
  }
});
