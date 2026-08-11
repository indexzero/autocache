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
import { createApp, edgeConsoleLogger, validateSplit, type ServedCopy, type SplitOptions } from './app.ts';
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
  /**
   * Name of the `[vars]` entry holding the `--relax-content-csp` STOPGAP
   * (#508). OFF by default (strict serving): the content CSP + chrome shell
   * framing grants stay locked to `'self'`/the split origins. Set truthy
   * ("1"/"true") to WIDEN those directives with the archive origins so
   * un-localized web.archive.org references load live instead of being blocked
   * (the mobile "content blocked" break) — self-containment is lost while on.
   * Default `RELAX_CONTENT_CSP`.
   */
  relaxContentCspVar?: string;
  /**
   * Names of the `[vars]` entries carrying the chrome/content split (#320):
   * the chrome host, the content host, and (optionally) the cross-origin
   * scheme. Both host vars must be set to enable Host-keyed serving (chrome =
   * attribution shell, content = capture bytes + `frame-ancestors`); either
   * absent = split off (single-host). Defaults `CHROME_HOST` / `CONTENT_HOST`
   * / `SPLIT_SCHEME`.
   */
  chromeHostVar?: string;
  contentHostVar?: string;
  splitSchemeVar?: string;
  /**
   * Per-deployment served-page description copy (#453) — the index and 404
   * description paragraphs. A BUILD-TIME config value (not a `[vars]` binding):
   * it is site prose supplied by the deploy entry, not operational config the
   * dashboard toggles. Absent, the generic site-agnostic defaults ship. The
   * fragments are TRUSTED, injected as RAW HTML (they carry `<a>` links) — see
   * {@link ServedCopy}.
   */
  copy?: ServedCopy;
  /**
   * Name of the `[vars]` entry that SILENCES edge logging. Observable is the
   * default posture (§9): a `console`-shim streams notable events to
   * `wrangler tail` for free. Setting the var truthy ("1"/"true") injects the
   * no-op instead — you opt INTO the quiet. Default `WAYBACK_LOG_SILENT`.
   */
  logSilentVar?: string;
}

/** The export-default shape Cloudflare's module worker syntax expects. */
export interface CloudflareHandler {
  fetch(request: Request, env: Record<string, unknown>): Response | Promise<Response>;
}

/** A `[vars]` string is truthy only as "1" or "true" (case-insensitive). */
function envFlag(value: unknown): boolean {
  return value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true');
}

/** Read a `[vars]` entry as a string, or undefined when unset (non-strings ignored). */
function envStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build the chrome/content split (#320) from `[vars]` — BOTH hosts, or neither.
 * A PARTIAL config (one host set, the other absent/misspelled) must NOT silently
 * fall back to single-host serving: that would serve capture bytes first-party
 * on the trusted chrome host, the exact vulnerability #320 exists to close. So a
 * partial or invalid config THROWS — the isolate fails to build and the Worker
 * returns 500, fail-closed. Mirrors serve.js's all-or-nothing `--chrome-host`/
 * `--content-host`.
 *
 * Presence is decided on the RAW binding, NOT a string-coerced value. Wrangler
 * permits JSON-valued `[vars]` (objects, numbers, booleans), so a binding that
 * is DEFINED but not a string would coerce to `undefined` and become
 * indistinguishable from truly ABSENT — silently disabling the split and
 * serving hostile archived bytes first-party on the trusted chrome host. The
 * "split off" (return `undefined`, single-host) branch is therefore taken ONLY
 * when all three RAW bindings are truly `undefined`; if ANY is defined we are
 * configuring a split and MUST fail closed on anything invalid.
 */
function envSplit(chromeHostRaw: unknown, contentHostRaw: unknown, schemeRaw: unknown): SplitOptions | undefined {
  // Split-off requires ALL THREE raw bindings absent. A defined-but-non-string
  // (Wrangler JSON var), an empty string, or any partial config falls through
  // to the fail-closed checks below — never quietly to single-host.
  if (chromeHostRaw === undefined && contentHostRaw === undefined && schemeRaw === undefined) return undefined;

  // A split is being configured. Coerce each host VALUE to a string (a
  // non-string binding coerces to undefined here — but presence was already
  // decided on the raw binding above, so this can only fail us CLOSED), and
  // require BOTH hosts to be non-empty: a defined-but-non-string or empty host
  // is a misconfiguration, never single-host. (validateSplit rejects a
  // whitespace-only host by its bare-host regex — see below.)
  const chromeHost = envStr(chromeHostRaw);
  const contentHost = envStr(contentHostRaw);
  if (!chromeHost || !contentHost) {
    throw new Error('chrome/content split misconfigured: set BOTH CHROME_HOST and CONTENT_HOST vars (non-empty strings), or neither');
  }

  // A present-but-invalid scheme must fail LOUD, not silently drop to the https
  // default (fix 2): a DEFINED but non-string / empty / whitespace SPLIT_SCHEME
  // is a misconfiguration. An ABSENT scheme (`undefined`) keeps the https
  // default; validateSplit still validates a provided scheme's format.
  let scheme: string | undefined;
  if (schemeRaw !== undefined) {
    scheme = envStr(schemeRaw);
    if (scheme === undefined || scheme.trim() === '') {
      throw new Error('chrome/content split misconfigured: SPLIT_SCHEME must be a non-empty string ("http"/"https") when set, or unset for the https default');
    }
  }

  const split: SplitOptions = {
    chromeHost,
    contentHost,
    ...(scheme ? { scheme } : {})
  };
  const err = validateSplit(split);
  if (err) throw new Error(`chrome/content split misconfigured: ${err}`);
  return split;
}

/**
 * Build the Workers entry. The app is stateless across requests, so it is
 * built once per isolate — lazily, because bindings only exist inside a
 * request context.
 */
export function createCloudflareHandler(config: CloudflareHandlerConfig = {}): CloudflareHandler {
  const capturesBinding = config.capturesBinding ?? 'WAYBACK_CAPTURES';
  const liveFallbackVar = config.liveFallbackVar ?? 'LIVE_FALLBACK';
  const relaxContentCspVar = config.relaxContentCspVar ?? 'RELAX_CONTENT_CSP';
  const chromeHostVar = config.chromeHostVar ?? 'CHROME_HOST';
  const contentHostVar = config.contentHostVar ?? 'CONTENT_HOST';
  const splitSchemeVar = config.splitSchemeVar ?? 'SPLIT_SCHEME';
  const logSilentVar = config.logSilentVar ?? 'WAYBACK_LOG_SILENT';
  let app: Hono | undefined;
  return {
    fetch(request: Request, env: Record<string, unknown>): Response | Promise<Response> {
      // Observable by default (§9): inject the console-shim unless the deploy
      // var opts into the quiet, in which case leave it unset (app → no-op).
      app ??= createApp(new R2Store(env[capturesBinding] as R2BucketLike), {
        liveFallback: envFlag(env[liveFallbackVar]),
        relaxContentCsp: envFlag(env[relaxContentCspVar]),
        // Pass the RAW bindings: presence must be decided on the binding, not a
        // string-coerced value, or a non-string var (Wrangler permits JSON
        // `[vars]`) would look ABSENT and silently disable the split.
        split: envSplit(env[chromeHostVar], env[contentHostVar], env[splitSchemeVar]),
        // Site prose from the deploy entry (build-time), not a runtime var.
        copy: config.copy,
        logger: envFlag(env[logSilentVar]) ? undefined : edgeConsoleLogger()
      });
      return app.fetch(request);
    }
  };
}
