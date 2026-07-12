#!/usr/bin/env node
// waybackify bin (#266/#267). Argv parsing + exit codes live in src/cli.js;
// implemented handlers are wired here as they land per sub-issue (#267
// cache; #268 check, #269 search, #270 manifest still exit 70).
// process.exitCode (not process.exit) so stdout/stderr flush naturally
// before the process ends.
import { run } from '../src/cli.js';
import { cacheHandler } from '../src/commands/cache.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    cache: cacheHandler()
  }
});
