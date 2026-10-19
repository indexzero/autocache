/**
 * Transient-failure retry, at the PLATFORM DISPATCHER seam — not hand-rolled
 * inside the parity library. A full-corpus bucket-parity audit (`waybackify
 * bucket verify`, ./parity.ts) issues ~22k signed reads; a single resolver
 * hiccup or a momentary 503 must not kill the run. The fix lives ONCE, at the
 * process edge (the `bucket verify` handler installs it as the global
 * dispatcher), so every `fetch` the tool makes — list pages, HEADs,
 * GETs, and the Layer-4 loopback probes — self-heals with no fetch-injection
 * plumbing threaded through the app: application code just calls global `fetch`.
 *
 * undici's RetryAgent wraps a base dispatcher and re-issues idempotent requests
 * on a transient failure with capped exponential backoff (see
 * https://undici.nodejs.org/#/docs/api/RetryAgent). Node-only ON PURPOSE (undici
 * is Node's HTTP core; the edge runtimes bring their own fetch), so this module
 * lives outside the Fastly typecheck graph exactly like ./parity.ts.
 *
 * The policy is the archive audit's, made explicit rather than defaulted so the
 * command and the tests share ONE source of truth:
 *   - methods     GET/HEAD only — this tool never mutates, so retrying is always
 *                 safe (undici's defaults also retry PUT/DELETE/etc., which we
 *                 don't want to imply we do).
 *   - statusCodes 5xx outage + 429 throttle are transient. 404 is a legitimate
 *                 miss finding and 403 a real auth fault — NEITHER is listed, so
 *                 neither is ever retried.
 *   - errorCodes  undici's network-flap defaults PLUS ETIMEDOUT / EAI_AGAIN /
 *                 UND_ERR_CONNECT_TIMEOUT — the DNS/connect classes that killed a
 *                 real run on its first call — which its defaults omit.
 *   - ~4 attempts (1 + maxRetries) with capped, exponential backoff.
 */

import { Agent, RetryAgent, type Dispatcher } from 'undici';

/** Idempotent methods this tool issues — the only ones safe to replay. */
export const RETRY_METHODS = ['GET', 'HEAD'] as const;

/** Transient response statuses: outage (5xx) + throttle (429). 404/403 are NOT here. */
export const RETRY_STATUS_CODES = [500, 502, 503, 504, 429] as const;

/**
 * Transient network-error codes — undici's defaults augmented with the DNS /
 * connect-timeout classes it omits (ETIMEDOUT, EAI_AGAIN, UND_ERR_CONNECT_TIMEOUT).
 */
export const RETRY_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
  // UND_ERR_RES_CONTENT_LENGTH_MISMATCH is deliberately NOT here (#499): it
  // surfaces MID-BODY, after the dispatcher already handed the response off, so
  // a RetryAgent entry cannot replay it — it would only double-retry the rare
  // pre-handoff shape. The heal lives in Layer 3's per-object re-fetch
  // (./parity.ts checkBodies); do not re-add it at this seam.
] as const;

/** Backoff knobs — tests pass tiny timeouts to stay instant; prod uses the defaults. */
export interface RetryTuning {
  /** Retries AFTER the first attempt; total attempts = 1 + maxRetries. Default 3. */
  maxRetries?: number;
  /** First backoff (ms) before retry #1. Default 250. */
  minTimeout?: number;
  /** Backoff cap (ms). Default 5000. */
  maxTimeout?: number;
}

/**
 * Compose a {@link RetryAgent} over `base` (default a fresh {@link Agent}) with
 * the archive-audit retry policy. Tests pass a MockAgent as `base` and tiny
 * timeouts so the error-twice-then-succeed path runs deterministically fast.
 */
export function createRetryAgent(base: Dispatcher = new Agent(), tuning: RetryTuning = {}): RetryAgent {
  const { maxRetries = 3, minTimeout = 250, maxTimeout = 5000 } = tuning;
  return new RetryAgent(base, {
    maxRetries,
    minTimeout,
    maxTimeout,
    timeoutFactor: 2,
    methods: [...RETRY_METHODS],
    statusCodes: [...RETRY_STATUS_CODES],
    errorCodes: [...RETRY_ERROR_CODES]
  });
}
