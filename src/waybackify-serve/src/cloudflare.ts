/**
 * Cloudflare Workers adapter — the handler factory the deploy entry calls.
 *
 * Thin by contract, exactly like its siblings: everything interesting lives
 * in the runtime-agnostic app (src/app.ts) and the Store abstraction
 * (src/store.ts). This module only adapts Cloudflare's binding model — the
 * R2 bucket arrives on `env` per request — to the app factory. Its Fastly
 * twin is src/fastly.ts and its Node sibling src/node.ts; all three must
 * stay this thin or the "one app, three runtimes" contract erodes.
 *
 * The binding names are a CONVENTION the library documents, encoded as the
 * config defaults: an R2 binding `WAYBACK_CAPTURES` and a `[vars]` flag
 * `LIVE_FALLBACK`. A deployment that declares those names in its
 * wrangler.toml needs zero config — `export default createCloudflareHandler()`
 * is the whole entry. A deployment with different names lifts them through
 * {@link CloudflareHandlerConfig}: the specificity is a free variable, never
 * body text.
 *
 * Typed structurally (R2BucketLike is the sliver of R2Bucket we call — see
 * src/store.ts) so this compiles without pulling Cloudflare's ambient global
 * types into a package that also typechecks for Fastly and Node.
 */

import type { Hono } from 'hono';
import { createApp } from './app.ts';
import { R2Store, type R2BucketLike } from './store.ts';

/** Deployment coordinates, all defaulted to the documented convention. */
export interface CloudflareHandlerConfig {
  /** Name of the R2 bucket binding wrangler.toml declares. Default `WAYBACK_CAPTURES`. */
  capturesBinding?: string;
  /**
   * Name of the `[vars]` entry holding the live-fallback switch. Strict
   * serving is the default posture: a corpus miss answers a local 404, never
   * a 302 to live web.archive.org. The var restores the old miss→302
   * behavior when set to a truthy string ("1"/"true"). Default `LIVE_FALLBACK`.
   */
  liveFallbackVar?: string;
}

/** The export-default shape Cloudflare's module worker syntax expects. */
export interface CloudflareHandler {
  fetch(request: Request, env: Record<string, unknown>): Response | Promise<Response>;
}

/** A `[vars]` string is truthy only as "1" or "true" (case-insensitive). */
function envFlag(value: unknown): boolean {
  return value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true');
}

/**
 * Build the Workers entry. The app is stateless across requests, so it is
 * built once per isolate — lazily, because bindings only exist inside a
 * request context.
 */
export function createCloudflareHandler(config: CloudflareHandlerConfig = {}): CloudflareHandler {
  const capturesBinding = config.capturesBinding ?? 'WAYBACK_CAPTURES';
  const liveFallbackVar = config.liveFallbackVar ?? 'LIVE_FALLBACK';
  let app: Hono | undefined;
  return {
    fetch(request: Request, env: Record<string, unknown>): Response | Promise<Response> {
      app ??= createApp(new R2Store(env[capturesBinding] as R2BucketLike), {
        liveFallback: envFlag(env[liveFallbackVar])
      });
      return app.fetch(request);
    }
  };
}
