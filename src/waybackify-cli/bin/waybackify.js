#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js;
// implemented handlers are wired here as they land (cache is real;
// check, search, and manifest still exit 70).
// process.exitCode (not process.exit) so stdout/stderr flush naturally
// before the process ends.
import { run } from '../src/cli.js';
import { cacheHandler } from '../src/commands/cache.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    cache: cacheHandler()
  }
});
