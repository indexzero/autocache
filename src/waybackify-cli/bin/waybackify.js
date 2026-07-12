#!/usr/bin/env node
// waybackify bin (#266). Everything lives in src/cli.js — this file only
// bridges argv in and the exit code out. process.exitCode (not process.exit)
// so stdout/stderr flush naturally before the process ends.
import { run } from '../src/cli.js';

process.exitCode = await run(process.argv.slice(2));
