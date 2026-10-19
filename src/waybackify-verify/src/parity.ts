/**
 * Root ↔ bucket PARITY — the four-layer verifier behind THE MILESTONE gate.
 * Given a local `waybackify cache` root (the archive of record) and a
 * remote S3-compatible bucket that is meant to be its byte-for-byte projection,
 * prove they serve identical content, layer by layer:
 *
 *   LAYER 1  count parity, PER PREFIX — the bucket's `cap/` and `meta/` object
 *            counts each equal the root's entry count (one sidecar = one entry;
 *            a literal total-object count would DOUBLE, since each entry is two
 *            bucket objects). Catches an EXTRA object (nothing local iterates a
 *            key the bucket has but the root lacks) and a MISSING object.
 *   LAYER 2  full metadata sweep — HEAD every `cap/<aa>/<hash>` and assert its
 *            `x-amz-meta-status` == sidecar.status and native Content-Type ==
 *            normalize(sidecar.contentType). Compared POST-NORMALIZATION: a `''`
 *            sidecar's correct native value is `application/octet-stream`, so a
 *            literal field equality would fail a CORRECT bucket — see #compare.
 *   LAYER 3  full body verification — GET every `status:"body"` object, stream-
 *            hash sha256 in constant memory, and compare against the sidecar's
 *            SRI contentHash. Catches a corrupted / truncated body.
 *   LAYER 4  serving-behavior sampling THROUGH the waybackify-serve router —
 *            boot serveCacheRoot
 *            and serveBucket on ephemeral ports (same process) and assert the
 *            two answer identically for sampled keys (status, content-type, body
 *            bytes, redirect Location) plus a guaranteed miss (a local 404 in
 *            both under strict serving).
 *
 * Node-only ON PURPOSE (node:fs walking, node:crypto streaming digest, and the
 * @hono/node-server boot in Layer 4). It lives in waybackify-verify, never in
 * the edge graph of waybackify-serve.
 * It reads through the SAME S3Store the server serves from (Layers 2–4), so a
 * parity pass is a serving guarantee, not a parallel re-implementation. The one
 * capability the read-only Store lacks — enumerating a prefix — is the small
 * standalone `listPrefix` below, signed with the shared SigV4 signer; S3Store's
 * Store interface is left untouched.
 *
 * RESUMABLE. The engine hands checkpoint snapshots (passed layers,
 * verified Layer 3 bodies) to `onCheckpoint`. A run that receives one as
 * `resume` skips that work. See ./verify-checkpoint.ts for the rules.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { capturePath, metaPath } from '@autocache/waybackify/key.js';
import { SIDECAR_VERSION, isSidecarObject } from '@autocache/waybackify-serve/fsstore';
import { S3Store } from '@autocache/waybackify-serve/s3store';
import { serveBucket, serveCacheRoot, type RunningServer } from '@autocache/waybackify-serve/node';
import { signRequest, type SigV4Credentials } from '@autocache/waybackify-serve/sigv4';
import type { Capture, CaptureStatus } from '@autocache/waybackify-serve/store';
import {
  checkpointWriter,
  normalizePrefix,
  positiveInteger,
  snapshotProgress,
  startProgress,
  type BodyProgress,
  type VerifyCheckpoint
} from './verify-checkpoint.ts';

/** Where the bucket lives + how to read it. Credentials arrive from env. */
export interface ParityConfig {
  /** Local `waybackify cache` root — the archive of record. */
  root: string;
  /** Base endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** Signing region; `auto` is right for R2, harmless elsewhere. */
  region: string;
  /** Optional key prefix within the bucket (slashes trimmed). */
  prefix?: string;
  credentials: SigV4Credentials;
}

export interface ParityOptions extends ParityConfig {
  /** Which layers to run; defaults to all four. */
  layers?: number[];
  /** Layer 4 sample size per non-empty status class; defaults to 3. */
  sample?: number;
  /** In-flight HEAD/GET cap for Layers 2–3; defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  /** Emit a progress line every `progressEvery` entries (Layers 2–3). */
  progressEvery?: number;
  /**
   * Layer 3 per-object re-fetch knobs for a THROWN body READ. A broken
   * body surfaces mid-stream — AFTER the dispatcher handed the response off —
   * so ./retry.ts cannot transparently replay it; the heal lives here instead,
   * scoped to exactly that post-handoff phase (see {@link verifyBody}).
   * Tests pass 1ms timeouts to stay instant; prod uses the defaults.
   */
  bodyRetry?: BodyRetryTuning;
  /**
   * A checkpoint of an earlier run. The run skips its passed layers and
   * verified bodies, and trusts that the bucket did not change since then.
   */
  resume?: VerifyCheckpoint;
  /** Gets a snapshot after each layer and every `checkpointEvery` verified bodies. Calls are serialized. */
  onCheckpoint?: (checkpoint: VerifyCheckpoint) => void | Promise<void>;
  /** Layer 3 bodies between two checkpoint snapshots. Default 500. */
  checkpointEvery?: number;
  /** A passing run with a heal rate above this is `PASS-DEGRADED`. Default {@link DEGRADED_HEAL_RATE}. */
  degradedRate?: number;
  /**
   * Injected diagnostic logger (default no-op; a library never constructs pino,
   * design §1). The throttled sweep progress and each Mismatch fold onto
   * structured `logger.*` calls here (§2) — objects, not strings.
   */
  logger?: ParityLogger;
}

/** The minimal duck-typed logger parity emits through (pino / console / no-op all satisfy it). */
export interface ParityLogger {
  info(obj?: object, msg?: string): void;
  warn(obj?: object, msg?: string): void;
  error(obj?: object, msg?: string): void;
}

const NOOP_PARITY_LOGGER: ParityLogger = { info() {}, warn() {}, error() {} };

/** Layer 3 body re-fetch policy — mirrors ./retry.ts's RetryTuning shape. */
export interface BodyRetryTuning {
  /** TOTAL attempts per object (the first try included). Default 3. */
  attempts?: number;
  /** First backoff (ms) before re-fetch #1; doubles per attempt. Default 250. */
  minTimeout?: number;
  /** Backoff cap (ms). Default 2000. */
  maxTimeout?: number;
}

/** Layer 3 body re-fetch defaults — the policy when no tuning arrives. */
const DEFAULT_BODY_RETRY: Required<BodyRetryTuning> = { attempts: 3, minTimeout: 250, maxTimeout: 2000 };

/**
 * Coerce PUBLIC tuning to sane values — bodyRetry crosses the API boundary, so
 * a NaN/Infinity/fractional `attempts` must not break loop termination (the
 * re-fetch loop's only exits are `attempt >= attempts` and success), and a
 * non-finite backoff must not become an eternal sleep.
 */
function sanitizeBodyRetry(tuning: BodyRetryTuning | undefined): Required<BodyRetryTuning> {
  const positiveInt = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  const nonNegative = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    attempts: positiveInt(tuning?.attempts, DEFAULT_BODY_RETRY.attempts),
    minTimeout: nonNegative(tuning?.minTimeout, DEFAULT_BODY_RETRY.minTimeout),
    maxTimeout: nonNegative(tuning?.maxTimeout, DEFAULT_BODY_RETRY.maxTimeout)
  };
}

/** In-flight HEAD/GET cap for Layers 2–3 — shared by the pool default and the bin's hint. */
export const DEFAULT_CONCURRENCY = 16;

/** Layer 4 sample size per status class when no `sample` arrives. */
const DEFAULT_SAMPLE = 3;

/**
 * The default heal-rate ceiling of a clean PASS. A run that heals 12 of
 * 16,376 bodies is ordinary noise. A run that heals 1,300 is a store in trouble.
 */
export const DEGRADED_HEAL_RATE = 0.01;

/** One root entry, as read from its sidecar — the unit Layers 1–4 verify. */
export interface Entry {
  /** The capture key (`<timestamp>/<originalUrl>`) — the app's request key. */
  key: string;
  /** sha256hex(key) — the `<aa>`-shard hash. */
  hash: string;
  /** Rootless object key `cap/<aa>/<hash>`. */
  capKey: string;
  /** Rootless object key `meta/<aa>/<hash>.json`. */
  metaKey: string;
  status: CaptureStatus;
  /** Content-type VERBATIM off the sidecar (may be `''`). */
  contentType: string;
  /** SRI `sha256-<base64>`; present iff status === 'body'. */
  contentHash?: string;
  /** Body byte length; present iff status === 'body'. */
  contentLength?: number;
}

/** A single discrepancy — a bucket object diverging from the root's truth. */
export interface Mismatch {
  /** The capture key or object key at fault. */
  key: string;
  /** Which property diverged (`status`, `contentType`, `body`, `presence`, …). */
  field: string;
  expected: string;
  actual: string;
}

export interface LayerReport {
  layer: number;
  name: string;
  pass: boolean;
  /** Objects/entries examined by this layer. */
  checked: number;
  mismatches: Mismatch[];
  /** Layer-specific roll-up counts (e.g. cap/meta object counts). */
  counts?: Record<string, number>;
  /** True when this verdict came from a resumed checkpoint, with no read in this run. */
  fromCheckpoint?: boolean;
  /** Layer 3: the bodies that `checked` counts as verified by an earlier run. */
  resumed?: number;
  /** Layer 3: the bodies that needed one or more re-fetches. */
  healed?: number;
}

/** A clean PASS, a PASS with a heal rate over the ceiling, or a FAIL. */
export type ParityVerdict = 'PASS' | 'PASS-DEGRADED' | 'FAIL';

export interface ParityReport {
  target: { endpoint: string; bucket: string; region: string; prefix?: string };
  root: string;
  entries: number;
  pass: boolean;
  /** `pass` with the heal rate added: the data is faithful, and the transport was or was not noisy. */
  verdict: ParityVerdict;
  /** Layer 3 bodies that needed one or more re-fetches. 0 when Layer 3 did not run. */
  healed: number;
  /** `healed` divided by the Layer 3 body count. 0 when Layer 3 did not run. */
  healRate: number;
  layers: LayerReport[];
}

/**
 * A per-task failure, tagged with WHERE it happened. A full-corpus sweep issues
 * thousands of signed reads across four layers; when one rejects, the bare cause
 * (`fetch failed`, an errno) names the fault but not the entry. This wraps it with
 * the layer + object context (`layer 3 (body verification) · cap/aa/<hash>`) and
 * keeps the original as {@link cause}, so {@link diagnoseFailure} can excavate the
 * transport cause AND report which object was in flight when the run gave out.
 */
export class ParityTaskError extends Error {
  /** The layer + entry/page locus, ready to prefix a one-line diagnosis. */
  readonly context: string;

  constructor(context: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${context}: ${detail}`, { cause });
    this.name = 'ParityTaskError';
    this.context = context;
  }
}

/** THE READ-CONTRACT NORMALIZATION: a `''`/absent content-type IS octet-stream. */
export function normalizeContentType(contentType: string): string {
  return contentType || 'application/octet-stream';
}

/** The sidecar fields this verifier reads (the archive of record). */
interface Sidecar {
  v: number;
  key: string;
  status: CaptureStatus;
  contentType: string;
  contentHash?: string;
  contentLength?: number;
}

/* ------------------------------------------------------------------------ *
 * Root enumeration — the sidecar IS the entry
 * ------------------------------------------------------------------------ */

/**
 * Walk `<root>/meta/<aa>/*.json` — the sidecar count is the ENTRY count, the
 * same completion token FsStore trusts. Each sidecar's `key` re-derives its
 * object keys through the shared key module (never hand-rolled), so the entry's
 * cap/meta keys are exactly what the bucket must carry. The walk reads the
 * current sidecar version only, the same `SIDECAR_VERSION` the serve reader
 * exports, so the two never drift. Any other version is an error at
 * enumeration, before any bucket read, never a silent entry. Rebuild such a
 * root with `cache add` or `cache fill`.
 */
export async function enumerateRoot(root: string): Promise<Entry[]> {
  const metaDir = `${root}/meta`;
  const entries: Entry[] = [];
  for (const aa of await readdirOrEmpty(metaDir)) {
    for (const file of await readdirOrEmpty(`${metaDir}/${aa}`)) {
      if (!file.endsWith('.json')) continue;
      const metaFile = `${metaDir}/${aa}/${file}`;
      const parsed: unknown = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      if (!isSidecarObject(parsed)) {
        throw new Error(`parity: malformed sidecar at ${metaFile} (not a JSON object)`);
      }
      const sidecar = parsed as unknown as Sidecar;
      if (sidecar.v !== SIDECAR_VERSION) {
        throw new Error(`parity: unsupported sidecar version ${sidecar.v} at ${metaFile}`);
      }
      const capKey = await capturePath(sidecar.key);
      const metaKey = await metaPath(sidecar.key);
      entries.push({
        key: sidecar.key,
        hash: capKey.slice(capKey.lastIndexOf('/') + 1),
        capKey,
        metaKey,
        status: sidecar.status,
        contentType: sidecar.contentType,
        contentHash: sidecar.contentHash,
        contentLength: sidecar.contentLength
      });
    }
  }
  // Deterministic order so progress + first-K mismatch reporting are stable.
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/* ------------------------------------------------------------------------ *
 * ListObjectsV2 — the one read the Store interface deliberately lacks
 * ------------------------------------------------------------------------ */

/**
 * Enumerate every object key under `prefix` via paginated ListObjectsV2
 * (`list-type=2`, continuation tokens), signed with the shared SigV4 signer.
 * Returns keys ROOTLESS of any configured bucket prefix (so they compare
 * directly against an entry's `cap/…` / `meta/…` object keys). A standalone
 * helper on purpose: S3Store is read-only HEAD/GET and its Store interface must
 * not grow a list op the edge runtimes never call.
 *
 * Calls the PLATFORM `fetch` directly — a flaky list page self-heals because
 * `waybackify bucket verify` installs a retrying global dispatcher (./retry.ts);
 * tests that need to intercept compose that same dispatcher over a MockAgent.
 */
export async function listPrefix(config: ParityConfig, prefix: string): Promise<string[]> {
  const bucketPrefix = bucketPrefixOf(config);
  const listPrefixValue = `${bucketPrefix}${prefix}`;
  const keys: string[] = [];
  let token: string | undefined;
  let page = 0;

  do {
    page += 1;
    const context = `layer 1 (count parity) · list ${listPrefixValue} page ${page}`;
    const url = new URL(`${config.endpoint.replace(/\/+$/, '')}/${config.bucket}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', listPrefixValue);
    if (token) url.searchParams.set('continuation-token', token);

    const headers = await signRequest({
      method: 'GET',
      url,
      region: config.region,
      service: 's3',
      credentials: config.credentials
      // payloadHash defaults to UNSIGNED-PAYLOAD — the list carries no body.
    });
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers });
    } catch (error) {
      // A flap that outlived the dispatcher's retries — tag it with the page so
      // the bin can name where the enumeration gave out, then excavate the cause.
      throw new ParityTaskError(context, error);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ParityTaskError(context, new Error(`${response.status} ${response.statusText}`));
    }
    const xml = await response.text();
    for (const key of parseListedKeys(xml)) {
      // Strip the configured bucket prefix so keys are the entry's own object
      // keys (`cap/<aa>/<hash>`) regardless of where in the bucket they live.
      keys.push(bucketPrefix && key.startsWith(bucketPrefix) ? key.slice(bucketPrefix.length) : key);
    }
    token = parseNextToken(xml);
  } while (token);

  return keys;
}

/** Every `<Key>…</Key>` in a ListBucketResult, XML-entity-decoded. */
function parseListedKeys(xml: string): string[] {
  const keys: string[] = [];
  for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(decodeXml(match[1]));
  return keys;
}

/** The continuation token IFF the result is truncated (else undefined = done). */
function parseNextToken(xml: string): string | undefined {
  if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) return undefined;
  const match = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The key prefix that every bucket read uses, as `<prefix>/` or `''`. It comes
 * from the same normal form as the checkpoint identity, so a prefix of `/` or
 * `a/` reads exactly the keys that its checkpoint describes.
 */
function bucketPrefixOf(config: ParityConfig): string {
  const prefix = normalizePrefix(config.prefix);
  return prefix ? `${prefix}/` : '';
}

/* ------------------------------------------------------------------------ *
 * LAYER 1 — count parity, per prefix
 * ------------------------------------------------------------------------ */

export async function checkCounts(config: ParityConfig, entries: Entry[]): Promise<LayerReport> {
  const [capKeys, metaKeys] = await Promise.all([
    listPrefix(config, 'cap/'),
    listPrefix(config, 'meta/')
  ]);

  const mismatches: Mismatch[] = [
    ...diffKeys('cap', new Set(entries.map(e => e.capKey)), capKeys),
    ...diffKeys('meta', new Set(entries.map(e => e.metaKey)), metaKeys)
  ];

  const counts = { entries: entries.length, cap: capKeys.length, meta: metaKeys.length };
  return {
    layer: 1,
    name: 'count parity (per prefix)',
    // Set equality subsumes the count assertion: equal counts with a swapped
    // key (one missing, one extra) is still a broken bucket.
    pass: mismatches.length === 0 && counts.cap === counts.entries && counts.meta === counts.entries,
    checked: capKeys.length + metaKeys.length,
    mismatches,
    counts
  };
}

/** Report keys the bucket is MISSING (in root, not listed) or has EXTRA. */
function diffKeys(prefix: string, expected: Set<string>, listed: string[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const listedSet = new Set(listed);
  for (const key of expected) {
    if (!listedSet.has(key)) mismatches.push({ key, field: `${prefix}-missing`, expected: 'present', actual: 'absent' });
  }
  for (const key of listedSet) {
    if (!expected.has(key)) mismatches.push({ key, field: `${prefix}-extra`, expected: 'absent', actual: 'present' });
  }
  return mismatches;
}

/* ------------------------------------------------------------------------ *
 * LAYER 2 — full metadata sweep
 * ------------------------------------------------------------------------ */

export async function checkMetadata(config: ParityConfig, entries: Entry[], options: ParityOptions): Promise<LayerReport> {
  const store = new S3Store(config);
  const mismatches: Mismatch[] = [];

  await mapPool(entries, options.concurrency ?? DEFAULT_CONCURRENCY, options.progressEvery ?? 500, options.logger ?? NOOP_PARITY_LOGGER, 'layer 2 (metadata sweep)', entry => entry.capKey, async entry => {
    const meta = await store.head(entry.key);
    if (meta === null) {
      mismatches.push({ key: entry.capKey, field: 'presence', expected: 'present', actual: 'missing (404)' });
      return;
    }
    // COMPARE POST-NORMALIZATION: S3Store already normalizes the native
    // Content-Type (absent → application/octet-stream) exactly as the sidecar
    // read mask does, so both sides are normalized before equality — a literal
    // compare would fail a correct bucket on every `''`-content-type sidecar.
    const expectedType = normalizeContentType(entry.contentType);
    if (meta.contentType !== expectedType) {
      mismatches.push({ key: entry.capKey, field: 'contentType', expected: expectedType, actual: meta.contentType });
    }
    const actualStatus = meta.status ?? 'body';
    if (actualStatus !== entry.status) {
      mismatches.push({ key: entry.capKey, field: 'status', expected: entry.status, actual: actualStatus });
    }
  });

  return { layer: 2, name: 'metadata sweep (HEAD every cap/)', pass: mismatches.length === 0, checked: entries.length, mismatches };
}

/* ------------------------------------------------------------------------ *
 * LAYER 3 — full body verification
 * ------------------------------------------------------------------------ */

export async function checkBodies(
  config: ParityConfig,
  entries: Entry[],
  options: ParityOptions,
  progress: BodyProgress = { verified: new Set(), healed: new Set() }
): Promise<LayerReport> {
  const store = new S3Store(config);
  const bodied = entries.filter(e => e.status === 'body');
  const pending = bodied.filter(e => !progress.verified.has(e.capKey));
  const mismatches: Mismatch[] = [];
  const logger = options.logger ?? NOOP_PARITY_LOGGER;
  const retry = sanitizeBodyRetry(options.bodyRetry);

  // The per-object re-fetch lives INSIDE verifyBody, phase-scoped to the
  // body read — see the ownership boundary documented there. This callback
  // deliberately adds no retry of its own: wrapping the WHOLE verify (including
  // store.get) in a retry loop is exactly the bug the phase guard removes.
  await mapPool(pending, options.concurrency ?? DEFAULT_CONCURRENCY, options.progressEvery ?? 500, logger, 'layer 3 (body verification)', entry => entry.capKey, async entry => {
    const outcome = await verifyBody(store, entry, mismatches, retry, logger);
    if (outcome.attempts > 1) progress.healed.add(entry.capKey);
    if (outcome.verified) {
      progress.verified.add(entry.capKey);
      progress.onVerified?.();
    }
  });

  const healed = bodied.filter(e => progress.healed.has(e.capKey)).length;
  return {
    layer: 3,
    name: 'body verification (GET every status:body)',
    pass: mismatches.length === 0,
    checked: bodied.length,
    mismatches,
    resumed: bodied.length - pending.length,
    healed
  };
}

/**
 * The mid-stream body-transport failures the Layer 3 re-fetch may heal — and
 * NOTHING else. These are the errors that surface WHILE the response body is
 * being consumed, AFTER the dispatcher handed the response off, which is why
 * they cannot live in ./retry.ts's RETRY_ERROR_CODES (a RetryAgent cannot
 * re-issue a request whose body handoff already began).
 *
 * THE BAR FOR MEMBERSHIP: retry only a failure whose recovery you can
 * name in one sentence —
 *
 *   UND_ERR_RES_CONTENT_LENGTH_MISMATCH  body ended short of its Content-Length
 *                                        → a fresh GET gets a whole one.
 *   UND_ERR_SOCKET                       socket died mid-body ("other side
 *                                        closed") → a new connection carries it.
 *   ECONNRESET / EPIPE                   peer reset / broken pipe mid-stream
 *                                        → a fresh socket re-carries the bytes.
 *
 * ERR_ASSERTION is deliberately NOT here: an assertion is
 * undici reaching a state it declared impossible — there is no sentence naming
 * what a retry would fix, so it FAILS CLOSED (surfaced, not healed).
 *
 * Deliberately an ALLOWLIST: S3Store.get also throws on terminal HTTP faults
 * (403 auth, exhausted-retry 5xx, …), and retrying those could heal a flapping
 * terminal error into a false PASS — the one thing a verification gate must
 * never do.
 */
const RETRYABLE_BODY_ERROR_CODES = new Set([
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'EPIPE'
]);

/**
 * True iff some link of `error`'s cause chain carries a
 * {@link RETRYABLE_BODY_ERROR_CODES} code. The chain walk matters: undici's
 * fetch wraps the mid-stream break as `TypeError('terminated', { cause })`, so
 * the discriminating `code` sits one (or more) `cause` links down.
 */
function isRetryableBodyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const { code, cause } = node as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && RETRYABLE_BODY_ERROR_CODES.has(code)) return true;
    node = cause;
  }
  return false;
}

/**
 * GET + stream-hash ONE bodied entry, folding any divergence into `mismatches`,
 * with the per-object re-fetch scoped to EXACTLY the post-handoff phase.
 *
 * THE PHASE CUT IS AN OWNERSHIP BOUNDARY. Every failure BEFORE the response is
 * handed off — connect, pre-header resets, 5xx, 429 — belongs to the DISPATCHER
 * (./retry.ts's RetryAgent), which already replayed it as many times as policy
 * allows. So when `store.get` throws, the dispatcher is either exhausted or the
 * fault is terminal (403, …) — and app-retrying it AGAIN would grant the read
 * more attempts than policy and could heal a genuinely failing object into a
 * false PASS. `store.get` therefore sits OUTSIDE the try: its throw PROPAGATES
 * untouched, always.
 *
 * The APP owns exactly ONE failure class: a throw while CONSUMING
 * `capture.body`, after the handoff, which the dispatcher can never replay (the
 * body stream already left its hands). Only that read is retryable — the
 * transient body-transport allowlist ({@link isRetryableBodyError}), and a
 * retry loops back to re-issue a FRESH idempotent GET. After `attempts` the
 * last error propagates unchanged — a persistently broken body still fails the
 * run.
 *
 * Every verify OUTCOME — miss, bodiless, hash mismatch — RETURNS as Mismatch
 * data, never throws. The return value states if the body verified, and how
 * many GETs it took (heal accounting).
 */
async function verifyBody(store: S3Store, entry: Entry, mismatches: Mismatch[], retry: Required<BodyRetryTuning>, logger: ParityLogger): Promise<{ verified: boolean; attempts: number }> {
  const { attempts, minTimeout, maxTimeout } = retry;
  for (let attempt = 1; ; attempt += 1) {
    // PRE-HANDOFF — dispatcher-owned. A throw here propagates (never app-retried).
    const capture = await store.get(entry.key);
    if (capture === null) {
      mismatches.push({ key: entry.capKey, field: 'presence', expected: 'present', actual: 'missing (404)' });
      return { verified: false, attempts: attempt };
    }
    if (!('body' in capture)) {
      // The object's x-amz-meta-status disagrees with the sidecar — it answered
      // bodiless where the root says `body`. That's a metadata defect, surfaced
      // here (Layer 2 catches it too); either way, there are no bytes to hash.
      mismatches.push({ key: entry.capKey, field: 'body', expected: 'body bytes', actual: `bodiless (${capture.status ?? 'body'})` });
      return { verified: false, attempts: attempt };
    }
    try {
      // POST-HANDOFF — app-owned. ONLY this body read is retryable.
      const actual = await sriOf(capture.body);
      if (actual !== entry.contentHash) {
        mismatches.push({ key: entry.capKey, field: 'contentHash', expected: entry.contentHash ?? '(none)', actual });
        return { verified: false, attempts: attempt };
      }
      return { verified: true, attempts: attempt };
    } catch (error) {
      if (!isRetryableBodyError(error) || attempt >= attempts) throw error;
      logger.warn(
        { evt: 'parity-body-retry', key: entry.capKey, attempt, attempts, error: error instanceof Error ? error.message : String(error) },
        `layer 3 (body verification) · ${entry.capKey}: broken body (attempt ${attempt}/${attempts}), re-fetching`
      );
      await sleep(Math.min(minTimeout * 2 ** (attempt - 1), maxTimeout));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Stream-hash a capture body → SRI `sha256-<base64>`, constant memory. */
async function sriOf(body: Capture['body']): Promise<string> {
  const hash = createHash('sha256');
  const stream = body instanceof ReadableStream ? body : (new Response(body).body as ReadableStream<Uint8Array>);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return `sha256-${hash.digest('base64')}`;
}

/* ------------------------------------------------------------------------ *
 * LAYER 4 — serving-behavior sampling THROUGH the waybackify-serve router
 * ------------------------------------------------------------------------ */

export async function checkServing(config: ParityConfig, entries: Entry[], options: ParityOptions): Promise<LayerReport> {
  const sample = options.sample ?? DEFAULT_SAMPLE;
  const sampled = sampleKeys(entries, sample);

  const rootServer = await serveCacheRoot({ root: config.root });
  const bucketServer = await serveBucket({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    prefix: config.prefix,
    credentials: config.credentials
  });

  const mismatches: Mismatch[] = [];
  try {
    for (const key of sampled) mismatches.push(...(await compareServed(rootServer, bucketServer, key)));

    // A GUARANTEED-ABSENT key: both must miss identically. Under strict serving
    // (the default both servers boot with) that is a local 404; the parity gate
    // only cares that root and bucket agree, whatever the miss answer is.
    const missKey = `20140403040000/http://parity.invalid/__absent_${Date.now()}__`;
    mismatches.push(...(await compareServed(rootServer, bucketServer, missKey)));
  } finally {
    await Promise.all([closeServer(rootServer), closeServer(bucketServer)]);
  }

  return {
    layer: 4,
    name: 'serving parity (through the serve router)',
    pass: mismatches.length === 0,
    checked: sampled.length + 1,
    mismatches
  };
}

/** N keys per NON-EMPTY status class; deterministic (first N of the sorted set). */
function sampleKeys(entries: Entry[], n: number): string[] {
  const byStatus = new Map<CaptureStatus, string[]>();
  for (const entry of entries) {
    const bucket = byStatus.get(entry.status) ?? [];
    bucket.push(entry.key);
    byStatus.set(entry.status, bucket);
  }
  const keys: string[] = [];
  for (const bucket of byStatus.values()) keys.push(...bucket.slice(0, n));
  return keys;
}

/**
 * Fetch one key from BOTH servers (redirects NOT followed) and diff the four
 * serving-parity fields the milestone names: status code, content-type, body
 * bytes, and the redirect Location. Reports each divergence precisely.
 */
async function compareServed(root: RunningServer, bucket: RunningServer, key: string): Promise<Mismatch[]> {
  const [a, b] = await Promise.all([fetchKey(root, key), fetchKey(bucket, key)]);
  const mismatches: Mismatch[] = [];
  const note = (field: string, expected: string, actual: string) => mismatches.push({ key, field, expected, actual });

  // The styled 404/index pages now render the mirror's OWN host (the request
  // Host header) into their title — so the two parity servers, which
  // listen on different ephemeral ports, legitimately serve host-differing
  // bytes for a miss. Parity is a LOGICAL equivalence over one mirror, so
  // normalize each server's own authority to a constant before diffing bytes;
  // capture-byte hits never contain the authority, so this is a no-op for them.
  const aBody = normalizeMirrorHost(a.body, new URL(root.url).host);
  const bBody = normalizeMirrorHost(b.body, new URL(bucket.url).host);

  if (a.status !== b.status) note('status', `root ${a.status}`, `bucket ${b.status}`);
  if (a.contentType !== b.contentType) note('content-type', `root ${a.contentType}`, `bucket ${b.contentType}`);
  if (a.location !== b.location) note('location', `root ${a.location}`, `bucket ${b.location}`);
  if (!bytesEqual(aBody, bBody)) note('body', `root ${aBody.length}B`, `bucket ${bBody.length}B`);
  return mismatches;
}

/**
 * Replace a server's own host authority (`host:port`) with a fixed placeholder
 * so the host-in-title does not make two servers on different ports look
 * divergent. latin1 is a lossless byte↔char map, so a binary capture body that
 * never contains the authority round-trips byte-for-byte (a genuine no-op).
 */
function normalizeMirrorHost(body: Uint8Array, authority: string): Uint8Array {
  const text = Buffer.from(body).toString('latin1');
  if (!text.includes(authority)) return body;
  return new Uint8Array(Buffer.from(text.replaceAll(authority, '<mirror-host>'), 'latin1'));
}

interface Served {
  status: number;
  contentType: string | null;
  location: string | null;
  body: Uint8Array;
}

async function fetchKey(server: RunningServer, key: string): Promise<Served> {
  const response = await fetch(`${server.url}/${key}`, { redirect: 'manual' });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    location: response.headers.get('location'),
    body: new Uint8Array(await response.arrayBuffer())
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function closeServer(running: RunningServer): Promise<void> {
  return new Promise((resolve, reject) => running.server.close(error => (error ? reject(error) : resolve())));
}

/* ------------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------------ */

const LAYER_RUNNERS: Record<number, (config: ParityConfig, entries: Entry[], options: ParityOptions, bodies: BodyProgress) => Promise<LayerReport>> = {
  1: (config, entries) => checkCounts(config, entries),
  2: checkMetadata,
  3: checkBodies,
  4: checkServing
};

/**
 * Run the requested parity layers against one target, returning the full
 * report. The engine never writes files. It hands checkpoint snapshots to
 * `onCheckpoint`, and the caller stores them.
 */
export async function runParityCheck(options: ParityOptions): Promise<ParityReport> {
  const logger = options.logger ?? NOOP_PARITY_LOGGER;
  const layers = (options.layers ?? [1, 2, 3, 4]).slice().sort((a, b) => a - b);
  // One normal form of the prefix for every read, the checkpoint identity, and
  // the report. `/`, `a/`, and `/a` therefore mean what `''` and `a` mean.
  const config: ParityOptions = { ...options, prefix: normalizePrefix(options.prefix) };
  const entries = await enumerateRoot(config.root);
  const progress = startProgress(config, entries, config.sample ?? DEFAULT_SAMPLE, logger);
  const writer = checkpointWriter(options.onCheckpoint, () => snapshotProgress(progress), logger);
  const every = positiveInteger(options.checkpointEvery, 500);
  let sinceSave = 0;
  const bodies: BodyProgress = {
    verified: progress.verified,
    healed: progress.healed,
    onVerified: () => {
      sinceSave += 1;
      if (sinceSave < every) return;
      sinceSave = 0;
      writer.save();
    }
  };

  const reports: LayerReport[] = [];
  for (const layer of layers) {
    const run = LAYER_RUNNERS[layer];
    if (!run) throw new Error(`parity: unknown layer ${layer} (expected 1–4)`);
    const carried = progress.passed.get(layer);
    if (carried) {
      // A layer that passed under the same signature and target is not read again.
      reports.push({ ...carried, fromCheckpoint: true });
      logger.info(
        { evt: 'parity-layer', layer, name: carried.name, pass: true, checked: carried.checked, mismatches: 0, fromCheckpoint: true },
        `layer ${layer} — ${carried.name}: PASS (from checkpoint)`
      );
      continue;
    }
    try {
      const report = await run(config, entries, config, bodies);
      reports.push(report);
      if (report.pass) progress.passed.set(layer, report);
      writer.save();
      // Diagnostic fold (§2/§5): the layer verdict at info, each Mismatch at
      // error (a real divergence). The report itself stays the DATA the CLI
      // renders — this is additive.
      logger.info(
        { evt: 'parity-layer', layer: report.layer, name: report.name, pass: report.pass, checked: report.checked, mismatches: report.mismatches.length },
        `layer ${report.layer} — ${report.name}: ${report.pass ? 'PASS' : `FAIL (${report.mismatches.length})`}`
      );
      for (const m of report.mismatches) {
        logger.error(
          { evt: 'parity-mismatch', layer: report.layer, key: m.key, field: m.field, expected: m.expected, actual: m.actual },
          `parity mismatch ${m.key} · ${m.field}: expected ${m.expected}, got ${m.actual}`
        );
      }
    } catch (error) {
      // Store the progress that the failed layer earned before it gave out, so
      // that a resume starts from it.
      writer.save();
      await writer.flush();
      // A layer gave out mid-run. The layers that already finished hold real
      // verdicts (they passed, or found honest mismatches) — attach them to the
      // thrown error so the bin can print "nothing failed verification, the
      // network gave out at layer N" before the one-line diagnosis. This is the
      // ONLY escape from the loop, so `reports` holds exactly the completed layers.
      if (error && typeof error === 'object') {
        (error as { completedLayers?: LayerReport[] }).completedLayers = reports;
      }
      throw error;
    }
  }
  await writer.flush();

  const pass = reports.every(r => r.pass);
  const bodyReport = reports.find(r => r.layer === 3);
  const healed = bodyReport?.healed ?? 0;
  const healRate = bodyReport && bodyReport.checked > 0 ? healed / bodyReport.checked : 0;
  const ceiling = options.degradedRate ?? DEGRADED_HEAL_RATE;
  const verdict: ParityVerdict = !pass ? 'FAIL' : healRate > ceiling ? 'PASS-DEGRADED' : 'PASS';

  return {
    target: { endpoint: config.endpoint, bucket: config.bucket, region: config.region, prefix: config.prefix },
    root: config.root,
    entries: entries.length,
    pass,
    verdict,
    healed,
    healRate,
    layers: reports
  };
}

/**
 * Render a report as a human summary: one line per layer (pass/fail + counts)
 * and the first `firstK` mismatches under each failing layer. The `--json`
 * output is the machine form; this is the terminal form.
 */
export function formatReport(report: ParityReport, firstK = 10): string {
  const lines: string[] = [];
  const target = report.target.prefix
    ? `${report.target.bucket} (${report.target.endpoint}, prefix=${report.target.prefix})`
    : `${report.target.bucket} (${report.target.endpoint})`;
  lines.push(`parity: ${report.root} ↔ ${target}`);
  const heal = report.healed > 0 ? ` (healed ${report.healed}, rate ${(report.healRate * 100).toFixed(2)}%)` : '';
  lines.push(`  ${report.entries} entries · region=${report.target.region} · ${report.verdict}${heal}`);

  for (const layer of report.layers) {
    lines.push(formatLayerVerdict(layer));
    for (const m of layer.mismatches.slice(0, firstK)) {
      lines.push(`      ${m.key} · ${m.field}: expected ${m.expected}, got ${m.actual}`);
    }
    if (layer.mismatches.length > firstK) {
      lines.push(`      … and ${layer.mismatches.length - firstK} more`);
    }
  }
  return lines.join('\n');
}

/** The one-line PASS/FAIL verdict for a layer — the header formatReport prints, reused by the bin to surface COMPLETED layers when a later one gives out. */
export function formatLayerVerdict(layer: LayerReport): string {
  const counts = layer.counts
    ? ` [${Object.entries(layer.counts).map(([k, v]) => `${k}=${v}`).join(' ')}]`
    : '';
  const verdict = layer.pass ? 'PASS' : `FAIL (${layer.mismatches.length})`;
  let notes = '';
  if (layer.fromCheckpoint) notes += ' · from checkpoint';
  else if (layer.resumed) notes += ` · ${layer.resumed} from checkpoint`;
  if (layer.healed) notes += ` · healed ${layer.healed}`;
  return `  layer ${layer.layer} — ${layer.name}: ${verdict} · ${layer.checked} checked${counts}${notes}`;
}

/** Retry-after / throttle statuses whose fix is fewer in-flight reads, not a re-run. */
const THROTTLE_STATUSES = new Set([429, 503]);

/** The subset of undici's RequestRetryError this reads — its HTTP-response fields. */
interface RetryErrorLike {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
  data?: { count?: number };
}

/**
 * Render a failed audit run as ONE informative line (no command prefix — the
 * caller adds that). Walks the cause chain: undici's RetryAgent, once it exhausts
 * its attempts, surfaces the giving-up cause under `.cause` — a RequestRetryError
 * (`code: 'UND_ERR_REQ_RETRY'`) carrying the HTTP `statusCode`, response `headers`,
 * and `data.count` (attempts) when the last failure was a response, else the raw
 * network errno; `fetch()` wraps either as `TypeError('fetch failed', { cause })`.
 * A {@link ParityTaskError} contributes the layer/entry `context` prefix.
 *
 *   layer 3 (body verification) · cap/aa/9f…: HTTP 503 after 4 attempts (Retry-After: 2)
 *     — persistent throttling at --concurrency 16? try --concurrency 8
 *
 * The concurrency hint appears ONLY for a throttle shape (429/503), naming the
 * CURRENT concurrency so the remedy is concrete.
 */
export function diagnoseFailure(error: unknown, concurrency: number): string {
  const context = typeof (error as { context?: unknown })?.context === 'string'
    ? (error as { context: string }).context
    : undefined;
  const prefix = context ? `${context}: ` : '';

  let retry: RetryErrorLike | undefined;
  let errno: string | undefined;
  let deepestMessage: string | undefined;
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const record = node as { code?: unknown; message?: unknown; cause?: unknown } & RetryErrorLike;
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (code === 'UND_ERR_REQ_RETRY') retry = record;
    else if (code) errno = code; // walk deeper; the innermost network errno wins
    if (typeof record.message === 'string') deepestMessage = record.message;
    node = record.cause;
  }

  if (retry && retry.statusCode != null) {
    const attempts = typeof retry.data?.count === 'number' ? retry.data.count : undefined;
    const retryAfter = retry.headers?.['retry-after'];
    let body = `HTTP ${retry.statusCode}`;
    if (attempts) body += ` after ${attempts} attempts`;
    if (retryAfter) body += ` (Retry-After: ${retryAfter})`;
    const hint = THROTTLE_STATUSES.has(retry.statusCode)
      ? ` — persistent throttling at --concurrency ${concurrency}? try --concurrency ${Math.max(1, Math.floor(concurrency / 2))}`
      : '';
    return `${prefix}${body}${hint}`;
  }

  if (errno) return `${prefix}${errno}`;

  return `${prefix}${deepestMessage ?? String(error)}`;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, emitting a progress
 * line every `every` completions. Bounded concurrency keeps a full-corpus sweep
 * from opening 11k sockets at once; the progress sink is optional.
 */
async function mapPool<T>(
  items: T[],
  limit: number,
  every: number,
  logger: ParityLogger,
  label: string,
  key: (item: T) => string,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  let done = 0;
  let failure: ParityTaskError | undefined;
  const total = items.length;

  // After the first failure, no runner takes a new item. The pool rejects
  // only after every item in flight settles, so that no work outlives it.
  async function runner(): Promise<void> {
    while (!failure && index < total) {
      const i = index;
      index += 1;
      try {
        await worker(items[i]);
      } catch (error) {
        // Tag the failing entry with its layer + object key so a run that dies
        // mid-sweep names WHICH read gave out, not just `fetch failed`.
        failure ??= new ParityTaskError(`${label} · ${key(items[i])}`, error);
        return;
      }
      done += 1;
      // Structured throttled progress (was an already-formatted string sink, §2).
      if (every > 0 && done % every === 0) logger.info({ evt: 'parity-progress', label, done, total }, `${label}: ${done}/${total}`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, total || 1)) }, runner));
  if (failure) throw failure;
}
