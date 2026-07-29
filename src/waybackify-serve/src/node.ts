/**
 * Node runtime entry — the mirror served EITHER off a local `waybackify
 * cache` root OR off a remote S3-compatible bucket (the two milestone legs).
 *
 * Thin by contract, exactly like its siblings: everything interesting lives
 * in the runtime-agnostic app (src/app.ts) and the Store abstraction
 * (src/store.ts). Where src/cloudflare.ts adapts Cloudflare's binding model
 * and src/fastly.ts adapts Compute's fetch events, this file adapts Node's
 * HTTP server via @hono/node-server and wires in a Store — the FsStore
 * (src/fsstore.ts) over a local cache-root, or the S3Store (src/s3store.ts)
 * over a remote bucket — behind the identical app:
 *
 *   waybackify-serve --root /path/to/cache-root [--port N]
 *   waybackify-serve --bucket <name> --endpoint <url> \
 *        [--region <r>] [--prefix <p>] [--port N]
 *
 * (bin/serve.js is this package's own entry; render/wayback re-launches it
 * for local dev through bin/localdev.js over @charlie.dev/waybackify-serve/node.)
 *
 * The two modes are mutually exclusive; credentials for --bucket arrive from
 * the standard AWS env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, plus
 * an optional AWS_SESSION_TOKEN), never from flags — an operator's secret
 * belongs in the environment, not the process table.
 *
 * Adapter usage per hono's official Node.js docs
 * (https://hono.dev/docs/getting-started/nodejs): `serve({ fetch: app.fetch,
 * port })`, with the optional second argument — a listening callback
 * receiving the bound `AddressInfo` — per the adapter's own README
 * (https://github.com/honojs/node-server#readme). The port DEFAULTS TO 0 =
 * OS-assigned ephemeral (Node net.Server: "If port is omitted or is 0, the
 * operating system will assign an arbitrary unused port" —
 * https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback),
 * announced via that callback. Deliberately NOT a fixed well-known port:
 * this repo's worktree workflow has been bitten by fixed dev ports colliding
 * across concurrent worktrees, so a stable port is an operator's explicit
 * choice (--port), never a default.
 */

import { serve, type ServerType } from '@hono/node-server';
import { parseArgs } from 'node:util';
import { createApp } from './app.ts';
import { FsStore } from './fsstore.ts';
import { S3Store } from './s3store.ts';
import type { SigV4Credentials } from './sigv4.ts';

export interface ServeOptions {
  /** Cache-root directory (the `waybackify cache -o` target). Required. */
  root: string;
  /** TCP port; 0 (the default) = OS-assigned ephemeral. */
  port?: number;
  /** Bind address; defaults to loopback — exposing the mirror is a choice. */
  hostname?: string;
  /** Restore the miss→302-to-live fallback (`--live-fallback`); off by default. */
  liveFallback?: boolean;
  /**
   * Serve-time reference localization (design §D3) — the corpus key-set to
   * localize wayback references against (build it once with
   * loadCorpusKeySet(root), src/corpus.ts). Programmatic callers only (the
   * crawl probe): `serveCacheRoot({ root, port: 0, localize: corpusKeySet })`.
   * Not wired to a CLI flag here — the bin belongs to T4.
   */
  localize?: { has(key: string): boolean };
  /** CSP header posture (design §D3); `'enforce'` (default) or `'report-only'`. */
  cspMode?: 'enforce' | 'report-only';
}

/** Remote-bucket serving config — the S3Store leg of the two modes. */
export interface ServeBucketOptions {
  /** Base endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /** Bucket name (path-style). */
  bucket: string;
  /** Signing region; defaults to `auto` (right for R2, harmless elsewhere). */
  region?: string;
  /** Optional key prefix within the bucket. */
  prefix?: string;
  /** SigV4 credentials — sourced from env by the CLI, never from flags. */
  credentials: SigV4Credentials;
  /** TCP port; 0 (the default) = OS-assigned ephemeral. */
  port?: number;
  /** Bind address; defaults to loopback — exposing the mirror is a choice. */
  hostname?: string;
  /** Restore the miss→302-to-live fallback (`--live-fallback`); off by default. */
  liveFallback?: boolean;
}

export interface RunningServer {
  server: ServerType;
  /** The ACTUAL bound port (resolves --port 0 to the assigned one). */
  port: number;
  url: string;
}

/**
 * Start the Node HTTP listener over an already-built app. Resolves once the
 * server is listening, with the actual bound address — which is what makes
 * ephemeral ports usable (tests and scripts read the port from the result,
 * not from a convention). Shared by both serving modes so they bind, log,
 * and report identically.
 */
function listen(app: ReturnType<typeof createApp>, port: number, hostname: string): Promise<RunningServer> {
  return new Promise(resolve => {
    // serve(options, listeningListener) — the listener receives Node's
    // net.AddressInfo for the bound socket (hono Node.js adapter; see the
    // module header for doc citations).
    const server = serve({ fetch: app.fetch, port, hostname }, info => {
      resolve({ server, port: info.port, url: `http://${hostname}:${info.port}` });
    });
  });
}

/**
 * Boot the mirror over a local cache-root (FsStore). Resolves once the
 * server is listening, with the actual bound address.
 */
export function serveCacheRoot(options: ServeOptions): Promise<RunningServer> {
  const { root, port = 0, hostname = '127.0.0.1', liveFallback = false, localize, cspMode } = options;
  return listen(createApp(new FsStore(root), { liveFallback, localize, cspMode }), port, hostname);
}

/**
 * Boot the mirror over a remote S3-compatible bucket (S3Store) — the SAME
 * app, the SAME wire behavior, a different read path. Resolves once the
 * server is listening, with the actual bound address.
 */
export function serveBucket(options: ServeBucketOptions): Promise<RunningServer> {
  const { endpoint, bucket, region = 'auto', prefix, credentials, port = 0, hostname = '127.0.0.1', liveFallback = false } = options;
  const store = new S3Store({ endpoint, bucket, region, prefix, credentials });
  return listen(createApp(store, { liveFallback }), port, hostname);
}

const USAGE = [
  'usage: waybackify-serve (--root <cache-root> | --bucket <name> --endpoint <url> [--region <r>] [--prefix <p>]) [--port N] [--host H] [--live-fallback]',
  '  --root   <dir>   serve a local waybackify cache-root (FsStore)',
  '  --bucket <name>  serve a remote S3-compatible bucket (S3Store); --endpoint required,',
  '                   credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the env',
  '  --live-fallback  answer a corpus miss with a 302 to live web.archive.org instead of a',
  '                   local 404 (off by default — strict serving never leaves this server)'
].join('\n');

/** console.error the message above the usage banner, and set a failing exit. */
function fail(message: string): void {
  console.error(`${message}\n${USAGE}`);
  process.exitCode = 2;
}

/**
 * CLI shim for bin/serve.js — two mutually exclusive modes:
 *   --root <cache-root>                     FsStore (local)
 *   --bucket <name> --endpoint <url> ...    S3Store (remote)
 * parseArgs is Node's own stable argv parser
 * (https://nodejs.org/api/util.html#utilparseargsconfig) — no dependency
 * needed for a handful of flags.
 */
export async function main(argv: string[]): Promise<void> {
  // `--help` / `-h` is a request, not a bad invocation: print the usage banner
  // and exit 0 (before parseArgs, which is strict and would reject the unknown
  // flag with exit 2). The exit-2 path stays reserved for genuine usage errors.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        bucket: { type: 'string' },
        endpoint: { type: 'string' },
        region: { type: 'string' },
        prefix: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'live-fallback': { type: 'boolean' }
      }
    }));
  } catch (error) {
    fail((error as Error).message);
    return;
  }
  const { root, bucket, endpoint, region, prefix, port: portArg, host, 'live-fallback': liveFallback = false } = values;

  const port = portArg === undefined ? 0 : Number(portArg);
  if (Number.isNaN(port)) {
    fail(`invalid --port: ${portArg}`);
    return;
  }

  // Exactly one mode: --root or --bucket, never both, never neither.
  if (root && bucket) {
    fail('--root and --bucket are mutually exclusive — pick one mode');
    return;
  }
  if (!root && !bucket) {
    fail('one of --root or --bucket is required');
    return;
  }

  if (root) {
    const running = await serveCacheRoot({ root, port, hostname: host, liveFallback });
    console.error(`wayback mirror: serving cache-root ${root} at ${running.url}${liveFallback ? ' (live-fallback on)' : ''}`);
    return;
  }

  // --bucket mode: --endpoint is required, and credentials come from the
  // environment ONLY (never flags) — fail fast and clearly if they're absent.
  if (!endpoint) {
    fail('--bucket requires --endpoint <url>');
    return;
  }
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    fail('--bucket mode needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment');
    return;
  }
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const credentials: SigV4Credentials = sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };

  const running = await serveBucket({ endpoint, bucket: bucket!, region, prefix, credentials, port, hostname: host, liveFallback });
  console.error(`wayback mirror: serving bucket ${bucket} (${endpoint}) at ${running.url}${liveFallback ? ' (live-fallback on)' : ''}`);
}
