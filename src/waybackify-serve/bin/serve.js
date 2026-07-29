#!/usr/bin/env node
/**
 * Serve a wayback mirror — off a local `waybackify cache` root (FsStore) or
 * a remote S3-compatible bucket (S3Store):
 *
 *   waybackify-serve --root /path/to/cache-root [--port N]
 *   waybackify-serve --bucket <name> --endpoint <url> [--region <r>] [--prefix <p>] [--port N]
 *
 * Plain .js on purpose, importing the .ts module directly — Node 22.18+/24
 * type-stripping handles it, and the src stays erasable-syntax-only so that
 * keeps working. Everything real lives in src/node.ts.
 */

import { main } from '../src/node.ts';

await main(process.argv.slice(2));
