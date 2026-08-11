/// <reference types="@fastly/js-compute" />
/**
 * Fastly Compute adapter — the handler factory the deploy entry calls.
 *
 * Fastly is a shipping target alongside Cloudflare, not a fallback — same
 * runtime-agnostic app (src/app.ts), different storage wiring: S3-compatible
 * Object Storage instead of R2, reached through the S3Store (src/s3store.ts).
 * Fastly Object Storage has NO Compute binding — every read is a
 * SigV4-signed origin fetch — so the store signs each request itself and
 * sends it over a NAMED BACKEND (Compute's fetch requires one). The backend
 * is declared in the deployment's fastly.toml `[backends]`; the store carries
 * the name through its `fetchOptions` seam.
 *
 * Fastly Compute is service-worker-shaped (addEventListener('fetch')) rather
 * than export-default-shaped, and resources are opened by name at request
 * time rather than injected — this module adapts exactly that and nothing
 * else. Calling {@link createFastlyHandler} registers the fetch listener.
 *
 * Unlike the Cloudflare adapter there are NO defaults: every coordinate is a
 * deployment truth (which endpoint, which bucket, which backend, which
 * secret store), and a wrong default would corrupt silently — so the config
 * is required, and the entry that supplies it is the deployment's honest
 * one-file statement of where its bucket lives.
 *
 * Credentials arrive at RUNTIME from a Fastly Secret Store (never from code
 * or config): SecretStore.get() returns an entry whose plaintext() is the
 * value, read under the documented entry names `access-key-id` and
 * `secret-access-key`. Compiled against the ambient types from
 * @fastly/js-compute via the reference directive above, which is why this
 * file typechecks in its own tsconfig (tsconfig.fastly.json) — Fastly's
 * globals and Node's disagree about the world.
 */

import { SecretStore } from 'fastly:secret-store';
import { createApp, edgeConsoleLogger, type ServedCopy, type SplitOptions } from './app.ts';
import { S3Store } from './s3store.ts';

/** Deployment coordinates — all required except the strict-serving switch. */
export interface FastlyHandlerConfig {
  /**
   * Base endpoint of the Object Storage service, PATH-STYLE: object URLs are
   * `<endpoint>/<bucket>/cap/<aa>/<hash>`, so the bucket rides the path,
   * never the hostname. Must agree with the `[backends]` declaration.
   */
  endpoint: string;
  /** Object Storage bucket holding the mirrored captures. */
  bucket: string;
  /**
   * SigV4 signing region — MUST equal the region token in the endpoint host
   * (e.g. `us-east-1` for `us-east-1.object.fastlystorage.app`).
   */
  region: string;
  /**
   * Named backend declared in fastly.toml `[backends]` — the regional Object
   * Storage endpoint. The S3Store merges this into every fetch init via its
   * `fetchOptions` seam; the name and the endpoint host must agree with the
   * backend declaration.
   */
  backend: string;
  /**
   * Secret Store holding the Object Storage access keys under the entries
   * `access-key-id` and `secret-access-key`.
   */
  secretStore: string;
  /**
   * Restore the miss→302-to-live fallback. Strict serving is the default: a
   * corpus miss answers a local 404, never a 302 to live web.archive.org.
   */
  liveFallback?: boolean;
  /**
   * The `--relax-content-csp` STOPGAP (#508), off by default: widen the content
   * CSP + the chrome shell framing grants with the archive origins so
   * un-localized web.archive.org references load live instead of being blocked
   * (the mobile "content blocked" break). A config boolean — Compute has no
   * `[vars]`, so this is the Fastly analogue of Cloudflare's `RELAX_CONTENT_CSP`
   * var. Self-containment is lost while on.
   */
  relaxContentCsp?: boolean;
  /**
   * The chrome/content split (#320): chrome host (attribution shell, no bytes)
   * and content host (capture bytes + `frame-ancestors`), the Fastly analogue
   * of the Cloudflare `CHROME_HOST`/`CONTENT_HOST` vars. Fastly has no runtime
   * `[vars]`, so a deployment supplies this as an owner-side config constant.
   * Absent = split off (single-host), the default until the content zone is
   * onboarded. A malformed split fails loud (createApp validates).
   */
  split?: SplitOptions;
  /**
   * Per-deployment served-page description copy (#453) — the index and 404
   * description paragraphs, supplied as an owner-side config constant (Fastly
   * has no runtime `[vars]`). Absent, the generic site-agnostic defaults ship.
   * TRUSTED, injected as RAW HTML (carries `<a>` links) — see {@link ServedCopy}.
   */
  copy?: ServedCopy;
  /**
   * Silence edge logging. Observable is the default posture (§9): a
   * `console`-shim streams notable events to `fastly log-tail` for free. Set
   * true to inject the no-op instead — the Fastly analogue of Cloudflare's
   * `WAYBACK_LOG_SILENT` var (Compute has no per-request env, so it is a config
   * boolean, exactly like `liveFallback`).
   */
  logSilent?: boolean;
}

async function handle(request: Request, config: FastlyHandlerConfig): Promise<Response> {
  const secrets = new SecretStore(config.secretStore);
  const accessKeyId = (await secrets.get('access-key-id'))?.plaintext();
  const secretAccessKey = (await secrets.get('secret-access-key'))?.plaintext();
  if (!accessKeyId || !secretAccessKey) {
    // Missing credentials is a deploy fault, not a miss — fail loud rather
    // than sign with empty keys and turn every read into a 403.
    return new Response('object storage credentials unavailable', { status: 500 });
  }

  const store = new S3Store({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    credentials: { accessKeyId, secretAccessKey },
    // The seam Compute's fetch requires: every signed read rides this backend.
    fetchOptions: { backend: config.backend }
  });

  // Observable by default (§9): inject the console-shim (streamed free by
  // `fastly log-tail`) unless the deploy opts into the quiet. Fastly has no
  // per-request env, so the silence switch is a config boolean — exactly the
  // shape `liveFallback` already uses.
  return createApp(store, {
    liveFallback: config.liveFallback ?? false,
    relaxContentCsp: config.relaxContentCsp ?? false,
    split: config.split,
    copy: config.copy,
    logger: config.logSilent ? undefined : edgeConsoleLogger()
  }).fetch(request);
}

/**
 * Register the Compute fetch listener over the given coordinates. Everything
 * is per-event: the Secret Store opens by name and its reads are only legal
 * inside a request context, and Compute runs one request per instance anyway
 * — building the store per event keeps no cross-request handle or credential
 * alive.
 */
export function createFastlyHandler(config: FastlyHandlerConfig): void {
  addEventListener('fetch', event => {
    event.respondWith(handle(event.request, config));
  });
}
