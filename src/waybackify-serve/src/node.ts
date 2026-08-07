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
 * The two modes are mutually exclusive — except under `--index`, where
 * `--bucket` (the serve store) and `--root` (the /_index catalog) combine;
 * see main(). Credentials for --bucket arrive from
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
import { createApp, edgeConsoleLogger, validateSplit, type EdgeLogger, type ServedCopy, type SplitOptions } from './app.ts';
import { loadCorpusCatalog } from './corpus.ts';
import { FsStore } from './fsstore.ts';
import { S3Store } from './s3store.ts';
import type { SigV4Credentials } from './sigv4.ts';

/**
 * Placeholder hostnames for the chrome/content split (#320), the defaults the
 * `--split` shorthand selects. GENERIC — this package names no deployment; a
 * real mirror passes its own hosts via `--chrome-host`/`--content-host` (or the
 * `Host:` header in local dev). The concrete hosts live in the site layer.
 */
const PROD_SPLIT: SplitOptions = {
  chromeHost: 'wayback.example.com',
  contentHost: 'content.example.net'
};

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
   * STOPGAP (`--relax-content-csp`); off by default (strict). Widens the
   * content CSP (and the chrome shell's framing grants) with the archive
   * origins so un-localized web.archive.org references load live — see
   * AppOptions.relaxContentCsp for the exact directive contract.
   */
  relaxContentCsp?: boolean;
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
  /** The chrome/content split (#320); off by default (single-host serving). */
  split?: SplitOptions;
  /**
   * Per-deployment served-page description copy (#453). Absent, the generic
   * site-agnostic defaults ship. Programmatic callers (render/wayback's local
   * dev entry supplies the site COPY); not wired to a CLI flag.
   */
  copy?: ServedCopy;
  /**
   * Local-only cache index (the full capture key-set from loadCorpusKeySet) —
   * enables `GET /_index`, the browsable cache search page. The CLI builds it
   * from the --root cache-root under `--index`; serveBucket takes the same
   * option (a local-root CATALOG over a bucket serve store — see there).
   */
  indexKeys?: Set<string>;
  /**
   * The REQUISITE subset of `indexKeys` (loadCorpusCatalog's `requisites`) —
   * drives /_index's "is requisite?" filter (top-level pages by default).
   */
  indexRequisites?: Set<string>;
  /**
   * Diagnostic sink (design §9), threaded into the app. The `waybackify serve`
   * CLI (`main`) injects the observable `console`-shim by default; programmatic
   * callers (the crawl probe) omit it and stay silent (the app's no-op).
   */
  logger?: EdgeLogger;
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
  /** STOPGAP (`--relax-content-csp`); off by default — see ServeOptions.relaxContentCsp. */
  relaxContentCsp?: boolean;
  /** The chrome/content split (#320); off by default (single-host serving). */
  split?: SplitOptions;
  /** Per-deployment served-page description copy (#453); generic defaults absent. */
  copy?: ServedCopy;
  /**
   * Capture key CATALOG for `GET /_index` (dev tooling) — a Set built from a
   * LOCAL cache-root (loadCorpusKeySet), since a bucket cannot enumerate
   * without a paginated LIST (out of scope). The /_index route is
   * store-agnostic (it only iterates this set), so its same-origin result
   * links resolve against THIS server → bucket GETs. Strict fs↔bucket parity
   * is deliberately not checked: a catalog key the bucket lacks 404s, a
   * useful drift signal. The CLI wires this under `--bucket --index --root`.
   */
  indexKeys?: Set<string>;
  /**
   * The REQUISITE subset of `indexKeys` (loadCorpusCatalog's `requisites`) —
   * drives /_index's "is requisite?" filter (top-level pages by default).
   */
  indexRequisites?: Set<string>;
  /** Diagnostic sink (design §9); the CLI injects the console-shim by default. */
  logger?: EdgeLogger;
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
  const { root, port = 0, hostname = '127.0.0.1', liveFallback = false, relaxContentCsp = false, localize, cspMode, split, copy, indexKeys, indexRequisites, logger } = options;
  return listen(createApp(new FsStore(root), { liveFallback, relaxContentCsp, localize, cspMode, split, copy, indexKeys, indexRequisites, logger }), port, hostname);
}

/**
 * Boot the mirror over a remote S3-compatible bucket (S3Store) — the SAME
 * app, the SAME wire behavior, a different read path. Resolves once the
 * server is listening, with the actual bound address.
 */
export function serveBucket(options: ServeBucketOptions): Promise<RunningServer> {
  const { endpoint, bucket, region = 'auto', prefix, credentials, port = 0, hostname = '127.0.0.1', liveFallback = false, relaxContentCsp = false, split, copy, indexKeys, indexRequisites, logger } = options;
  const store = new S3Store({ endpoint, bucket, region, prefix, credentials });
  return listen(createApp(store, { liveFallback, relaxContentCsp, split, copy, indexKeys, indexRequisites, logger }), port, hostname);
}

const USAGE = [
  'usage: waybackify-serve (--root <cache-root> | --bucket <name> --endpoint <url> [--region <r>] [--prefix <p>]) [--port N] [--host H] [--live-fallback] [--relax-content-csp] [--index] [--split | --chrome-host H --content-host H [--split-scheme S]]',
  '  --root   <dir>   serve a local waybackify cache-root (FsStore)',
  '  --bucket <name>  serve a remote S3-compatible bucket (S3Store); --endpoint required,',
  '                   credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the env',
  '  --live-fallback  answer a corpus miss with a 302 to live web.archive.org instead of a',
  '                   local 404 (off by default — strict serving never leaves this server)',
  '  --relax-content-csp',
  '                   STOPGAP: widen the content CSP so un-localized web.archive.org',
  '                   references load live from the archive instead of being blocked',
  '                   (self-containment lost while on; off by default — strict CSP)',
  '  --index          serve a local /_index cache search page, cataloged from the --root',
  '                   cache-root; with --bucket, --root supplies the catalog while the',
  '                   bucket serves the bytes (a bucket cannot enumerate itself)',
  '  --split          enable the #320 chrome/content split with the placeholder hostnames',
  '                   (chrome wayback.example.com, content content.example.net)',
  '  --chrome-host H  chrome-origin host for the split (attribution UI + iframe shell; no bytes)',
  '  --content-host H content-origin host for the split (serves capture bytes cross-origin);',
  '                   --chrome-host and --content-host are given together and override --split',
  '  --split-scheme S scheme for the split cross-origin refs (default https; use http for local dev)'
].join('\n');

/** console.error the message above the usage banner, and set a failing exit. */
function fail(message: string): void {
  console.error(`${message}\n${USAGE}`);
  process.exitCode = 2;
}

/**
 * Resolve the chrome/content split (#320) from CLI flags. Returns the
 * SplitOptions, `undefined` (split off — single-host serving), or an Error
 * message string when the flags are inconsistent (exactly one of
 * --chrome-host/--content-host given). `--chrome-host`+`--content-host`
 * override `--split`; `--split` alone selects the production hostnames.
 */
function resolveSplit(values: {
  split?: boolean;
  'chrome-host'?: string;
  'content-host'?: string;
  'split-scheme'?: string;
}): SplitOptions | undefined | { error: string } {
  const chromeHost = values['chrome-host'];
  const contentHost = values['content-host'];
  const scheme = values['split-scheme'];
  // A DEFINED but blank `--split-scheme` is a mistake, not the https default —
  // fail loud rather than silently drop it to https (the Node analogue of the
  // Cloudflare SPLIT_SCHEME fix). An ABSENT scheme keeps the https default.
  const schemeBlank = scheme !== undefined && scheme.trim() === '';
  let split: SplitOptions | undefined;
  // Presence, not truthiness: `--chrome-host ''` is a mistake, not "unset".
  if (chromeHost !== undefined || contentHost !== undefined) {
    if (!chromeHost || !contentHost) {
      return { error: '--chrome-host and --content-host must be given together (non-empty)' };
    }
    if (schemeBlank) return { error: '--split-scheme must be non-empty ("http" or "https") when given' };
    split = { chromeHost, contentHost, ...(scheme ? { scheme } : {}) };
  } else if (values.split) {
    if (schemeBlank) return { error: '--split-scheme must be non-empty ("http" or "https") when given' };
    split = { ...PROD_SPLIT, ...(scheme ? { scheme } : {}) };
  } else {
    // --split-scheme alone (no hosts, no --split) is a mistake, not a no-op.
    if (scheme !== undefined) return { error: '--split-scheme needs --split or --chrome-host/--content-host' };
    return undefined;
  }
  const err = validateSplit(split);
  if (err) return { error: err };
  return split;
}

/**
 * CLI shim for bin/serve.js — two modes:
 *   --root <cache-root>                     FsStore (local)
 *   --bucket <name> --endpoint <url> ...    S3Store (remote)
 * Mutually exclusive EXCEPT under `--index` (dev tooling): there `--bucket`
 * is the serve store and `--root` is the /_index CATALOG — the same-origin
 * result links resolve against this server, so clicking one GETs the bucket.
 * Resolves to the RunningServer on a successful boot (programmatic callers
 * and tests close it; bin/serve.js ignores it), or undefined on `--help` and
 * on the fail() paths. parseArgs is Node's own stable argv parser
 * (https://nodejs.org/api/util.html#utilparseargsconfig) — no dependency
 * needed for a handful of flags.
 *
 * `defaults` carries deployment values that have no CLI flag (#453): the
 * served-page `copy`. render/wayback's local-dev entry passes its site COPY
 * here so `pnpm dev` renders the same description production does; a bare
 * `waybackify-serve` invocation omits it and ships the generic defaults.
 */
export async function main(argv: string[], defaults: { copy?: ServedCopy } = {}): Promise<RunningServer | undefined> {
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
        'live-fallback': { type: 'boolean' },
        'relax-content-csp': { type: 'boolean' },
        index: { type: 'boolean' },
        split: { type: 'boolean' },
        'chrome-host': { type: 'string' },
        'content-host': { type: 'string' },
        'split-scheme': { type: 'string' }
      }
    }));
  } catch (error) {
    fail((error as Error).message);
    return;
  }
  const { root, bucket, endpoint, region, prefix, port: portArg, host, 'live-fallback': liveFallback = false, 'relax-content-csp': relaxContentCsp = false } = values;

  const port = portArg === undefined ? 0 : Number(portArg);
  if (Number.isNaN(port)) {
    fail(`invalid --port: ${portArg}`);
    return;
  }

  const split = resolveSplit(values);
  if (split && 'error' in split) {
    fail(split.error);
    return;
  }

  // Exactly one SERVE store: --root or --bucket, never neither, and both
  // only under --index — where the bucket serves and the root is merely the
  // /_index catalog (a bucket cannot enumerate itself without a paginated
  // LIST, out of scope; a local cache-root can, via loadCorpusKeySet).
  if (root && bucket && !values.index) {
    fail('--root and --bucket are mutually exclusive — pick one mode (or add --index to serve the bucket with --root as the /_index catalog)');
    return;
  }
  if (!root && !bucket) {
    fail('one of --root or --bucket is required');
    return;
  }
  // `--index` in bucket mode NEEDS the local catalog — without --root the
  // flag could only silently do nothing, and a flag that silently does
  // nothing is a lie — fail loud instead.
  if (bucket && values.index && !root) {
    fail('--index in bucket mode needs --root <cache-root> as the /_index catalog');
    return;
  }

  if (root && !bucket) {
    // The CLI is a runtime ENTRY: inject the observable console-shim (§9), so
    // `waybackify serve` surfaces misses/bodiless captures on stderr by default.
    // `--index` enumerates the cache-root ONCE at boot (loadCorpusCatalog) and
    // enables the local-only /_index search page — FsStore/--root only. The
    // catalog's requisite subset drives the page's "is requisite?" filter.
    const catalog = values.index ? await loadCorpusCatalog(root) : undefined;
    const running = await serveCacheRoot({ root, port, hostname: host, liveFallback, relaxContentCsp, split, copy: defaults.copy, indexKeys: catalog?.keys, indexRequisites: catalog?.requisites, logger: edgeConsoleLogger() });
    console.error(`wayback mirror: serving cache-root ${root} at ${running.url}${liveFallback ? ' (live-fallback on)' : ''}${relaxContentCsp ? ' (relax-content-csp on — STOPGAP, self-containment lost)' : ''}${split ? ` (split: chrome ${split.chromeHost} / content ${split.contentHost})` : ''}`);
    return running;
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

  // `--bucket --index`: the /_index CATALOG is the --root cache-root (the
  // guard above made sure it's present), enumerated ONCE at boot exactly as
  // the --root leg does. Dev tooling — no fs↔bucket parity check on purpose:
  // a catalog key the bucket lacks 404s from the bucket, a useful drift
  // signal, never a boot failure.
  const catalog = values.index ? await loadCorpusCatalog(root!) : undefined;
  const running = await serveBucket({ endpoint, bucket: bucket!, region, prefix, credentials, port, hostname: host, liveFallback, relaxContentCsp, split, copy: defaults.copy, indexKeys: catalog?.keys, indexRequisites: catalog?.requisites, logger: edgeConsoleLogger() });
  console.error(`wayback mirror: serving bucket ${bucket} (${endpoint}) at ${running.url}${liveFallback ? ' (live-fallback on)' : ''}${relaxContentCsp ? ' (relax-content-csp on — STOPGAP, self-containment lost)' : ''}${split ? ` (split: chrome ${split.chromeHost} / content ${split.contentHost})` : ''}${catalog ? ` (/_index catalog: ${root})` : ''}`);
  return running;
}
