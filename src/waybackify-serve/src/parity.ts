/**
 * Root ↔ bucket PARITY — the four-layer verifier behind THE MILESTONE gate
 * (#292). Given a local `waybackify cache` root (the archive of record) and a
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
 *            both under strict serving; #361).
 *
 * Node-only ON PURPOSE (node:fs walking, node:crypto streaming digest, and the
 * @hono/node-server boot in Layer 4) — it lives here, never in the edge graph.
 * It reads through the SAME S3Store the server serves from (Layers 2–4), so a
 * parity pass is a serving guarantee, not a parallel re-implementation. The one
 * capability the read-only Store lacks — enumerating a prefix — is the small
 * standalone `listPrefix` below, signed with the shared SigV4 signer; S3Store's
 * Store interface is left untouched.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { capturePath, metaPath } from '@charlie.dev/waybackify/key.js';
import { S3Store } from './s3store.ts';
import { serveBucket, serveCacheRoot, type RunningServer } from './node.ts';
import { signRequest, type SigV4Credentials } from './sigv4.ts';
import type { Capture, CaptureStatus } from './store.ts';

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
  /** Human progress sink (a bin wires this to stderr). */
  onProgress?: (line: string) => void;
}

/** In-flight HEAD/GET cap for Layers 2–3 — shared by the pool default and the bin's hint. */
export const DEFAULT_CONCURRENCY = 16;

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
}

export interface ParityReport {
  target: { endpoint: string; bucket: string; region: string; prefix?: string };
  root: string;
  entries: number;
  pass: boolean;
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

/** The v1 sidecar fields this verifier reads (the archive of record). */
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
 * cap/meta keys are exactly what the bucket must carry.
 */
export async function enumerateRoot(root: string): Promise<Entry[]> {
  const metaDir = `${root}/meta`;
  const entries: Entry[] = [];
  for (const aa of await readdirOrEmpty(metaDir)) {
    for (const file of await readdirOrEmpty(`${metaDir}/${aa}`)) {
      if (!file.endsWith('.json')) continue;
      const sidecar = JSON.parse(await fsp.readFile(`${metaDir}/${aa}/${file}`, 'utf8')) as Sidecar;
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
  const bucketPrefix = config.prefix ? `${trimSlashes(config.prefix)}/` : '';
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

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
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

  await mapPool(entries, options.concurrency ?? DEFAULT_CONCURRENCY, options.progressEvery ?? 500, options.onProgress, 'layer 2 (metadata sweep)', entry => entry.capKey, async entry => {
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

export async function checkBodies(config: ParityConfig, entries: Entry[], options: ParityOptions): Promise<LayerReport> {
  const store = new S3Store(config);
  const bodied = entries.filter(e => e.status === 'body');
  const mismatches: Mismatch[] = [];

  await mapPool(bodied, options.concurrency ?? DEFAULT_CONCURRENCY, options.progressEvery ?? 500, options.onProgress, 'layer 3 (body verification)', entry => entry.capKey, async entry => {
    const capture = await store.get(entry.key);
    if (capture === null) {
      mismatches.push({ key: entry.capKey, field: 'presence', expected: 'present', actual: 'missing (404)' });
      return;
    }
    if (!('body' in capture)) {
      // The object's x-amz-meta-status disagrees with the sidecar — it answered
      // bodiless where the root says `body`. That's a metadata defect, surfaced
      // here (Layer 2 catches it too); either way, there are no bytes to hash.
      mismatches.push({ key: entry.capKey, field: 'body', expected: 'body bytes', actual: `bodiless (${capture.status ?? 'body'})` });
      return;
    }
    const actual = await sriOf(capture.body);
    if (actual !== entry.contentHash) {
      mismatches.push({ key: entry.capKey, field: 'contentHash', expected: entry.contentHash ?? '(none)', actual });
    }
  });

  return { layer: 3, name: 'body verification (GET every status:body)', pass: mismatches.length === 0, checked: bodied.length, mismatches };
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
  const sample = options.sample ?? 3;
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
  // Host header, #453) into their title — so the two parity servers, which
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
 * so the host-in-title (#453) does not make two servers on different ports look
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

const LAYER_RUNNERS: Record<number, (config: ParityConfig, entries: Entry[], options: ParityOptions) => Promise<LayerReport>> = {
  1: (config, entries) => checkCounts(config, entries),
  2: checkMetadata,
  3: checkBodies,
  4: checkServing
};

/**
 * Run the requested parity layers against one target, returning the full
 * report. The tool NEVER writes files — the caller owns persistence.
 */
export async function runParityCheck(options: ParityOptions): Promise<ParityReport> {
  const layers = (options.layers ?? [1, 2, 3, 4]).slice().sort((a, b) => a - b);
  const entries = await enumerateRoot(options.root);

  const reports: LayerReport[] = [];
  for (const layer of layers) {
    const run = LAYER_RUNNERS[layer];
    if (!run) throw new Error(`parity: unknown layer ${layer} (expected 1–4)`);
    try {
      reports.push(await run(options, entries, options));
    } catch (error) {
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

  return {
    target: { endpoint: options.endpoint, bucket: options.bucket, region: options.region, prefix: options.prefix },
    root: options.root,
    entries: entries.length,
    pass: reports.every(r => r.pass),
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
  lines.push(`  ${report.entries} entries · region=${report.target.region} · ${report.pass ? 'PASS' : 'FAIL'}`);

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
  return `  layer ${layer.layer} — ${layer.name}: ${verdict} · ${layer.checked} checked${counts}`;
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
  onProgress: ((line: string) => void) | undefined,
  label: string,
  key: (item: T) => string,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  let done = 0;
  const total = items.length;

  async function runner(): Promise<void> {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= total) return;
      try {
        await worker(items[i]);
      } catch (error) {
        // Tag the failing entry with its layer + object key so a run that dies
        // mid-sweep names WHICH read gave out, not just `fetch failed`.
        throw new ParityTaskError(`${label} · ${key(items[i])}`, error);
      }
      done += 1;
      if (onProgress && every > 0 && done % every === 0) onProgress(`${label}: ${done}/${total}`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, total || 1)) }, runner));
}
