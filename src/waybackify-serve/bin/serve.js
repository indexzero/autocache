#!/usr/bin/env node
/**
 * Serve a wayback mirror — off a local `waybackify cache` root (FsStore) or
 * a remote S3-compatible bucket (S3Store):
 *
 *   waybackify-serve --root /path/to/cache-root [--port N]
 *   waybackify-serve --bucket <name> --endpoint <url> [--region <r>] [--prefix <p>] [--port N]
 *
 * Imports the tshy-built dist, not src/: Node refuses to type-strip
 * TypeScript under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so an src/ import breaks the bin for every npm consumer. In a checkout the
 * package's prepare/pretest/pretypecheck hooks materialize dist before
 * anything runs. Everything real lives in src/node.ts.
 */

import { main } from '../dist/esm/node.js';

await main(process.argv.slice(2));
