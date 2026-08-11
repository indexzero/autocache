/**
 * Transient-failure retry — proven at the PLATFORM DISPATCHER seam, where the
 * fix actually lives (src/retry.ts; the `waybackify bucket verify` handler
 * installs it globally). Each test composes the PRODUCTION retry policy
 * (`createRetryAgent`) over an undici MockAgent — the exact agent the command
 * installs, only with tiny backoff timeouts so the error-then-recover path runs
 * instantly — and drives the REAL library code (`listPrefix`, `S3Store`,
 * `runParityCheck`) through global `fetch`.
 *
 * The six intents mirror the audit's failure modes: a network flap on a list
 * page self-heals, a 5xx self-heals, a 4xx does NOT (surfaced as-is), an object
 * read (Layers 2–4) self-heals, an always-failing transport is retried to the
 * cap and then rejects (exactly 1 + maxRetries attempts), and a never-recovering
 * read makes the whole run reject — the single clean line `bucket verify` prints
 * before exit 1. Offline and deterministic — no network, no real S3.
 */

import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, MockAgent, type MockPool, setGlobalDispatcher } from 'undici';
import {
  diagnoseFailure,
  enumerateRoot,
  formatLayerVerdict,
  listPrefix,
  ParityTaskError,
  runParityCheck,
  type LayerReport,
  type ParityConfig
} from '../src/parity.ts';
import { S3Store } from '@autocache/waybackify-serve/s3store';
import { createRetryAgent, RETRY_ERROR_CODES } from '../src/retry.ts';

const ORIGIN = 'https://parity.mock.test';
const BUCKET = 'wayback-captures';
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const CONFIG: ParityConfig = { root: '/unused', endpoint: ORIGIN, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS };
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));

/** Match any request to the bucket, regardless of the ListObjectsV2 query string. */
const ANY_BUCKET_PATH = new RegExp(`^/${BUCKET}`);

/** A ListBucketResult over three cap objects — proof listPrefix parsed a real page. */
const LIST_XML =
  '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
  '<KeyCount>3</KeyCount><IsTruncated>false</IsTruncated>' +
  '<Contents><Key>cap/aa/1</Key></Contents>' +
  '<Contents><Key>cap/bb/2</Key></Contents>' +
  '<Contents><Key>cap/cc/3</Key></Contents>' +
  '</ListBucketResult>';

/** A DNS/socket flap exactly as undici raises it: an Error carrying a retryable code. */
function networkError(code = 'ECONNRESET'): Error {
  return Object.assign(new Error(`${code} simulated flap`), { code });
}

/** A ListBucketResult over exactly `keys` — used to make a layer PASS deterministically. */
function listXml(keys: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
    `<KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>` +
    keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('') +
    '</ListBucketResult>'
  );
}

let mockAgent: MockAgent;
let pool: MockPool;
const realDispatcher = getGlobalDispatcher();

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  pool = mockAgent.get(ORIGIN);
  // The SAME createRetryAgent the command installs, over the mock, with 1–5ms
  // backoff so the retries are instant. Restored in afterEach so no mock leaks.
  setGlobalDispatcher(createRetryAgent(mockAgent, { minTimeout: 1, maxTimeout: 5 }));
});

afterEach(async () => {
  setGlobalDispatcher(realDispatcher);
  await mockAgent.close();
});

describe('dispatcher retry — a resolver hiccup must not kill the run', () => {
  it('retries a transient network flap on a list page and the layer goes GREEN', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).replyWithError(networkError()).times(2);
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(200, LIST_XML);

    const keys = await listPrefix(CONFIG, 'cap/');
    assert.deepEqual(keys, ['cap/aa/1', 'cap/bb/2', 'cap/cc/3']); // two flaps, then the real page
    mockAgent.assertNoPendingInterceptors();
  });

  it('DOES retry a 5xx and then succeeds (server-side transient)', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(503, 'busy').times(2);
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(200, LIST_XML);

    const keys = await listPrefix(CONFIG, 'cap/');
    assert.equal(keys.length, 3);
    mockAgent.assertNoPendingInterceptors();
  });

  it('does NOT retry a 4xx (403 is a real auth fault) — surfaced as-is, not retried', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(403, 'forbidden');
    // A retry would consume THIS success — it must stay pending, proving one attempt.
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(200, LIST_XML);

    await assert.rejects(listPrefix(CONFIG, 'cap/'), /403/);
    assert.equal(mockAgent.pendingInterceptors().length, 1);
  });

  it('a body-integrity break (UND_ERR_RES_CONTENT_LENGTH_MISMATCH, #499) is NOT dispatcher-retried — Layer 3 owns that heal', async () => {
    // The code surfaces MID-BODY, after the dispatcher handed the response off,
    // so a RetryAgent entry could never replay the real shape — it would only
    // MULTIPLY attempts with Layer 3's per-object re-fetch (the one seam that
    // can re-issue the GET; see parity.test.ts). Guard against re-adding it.
    assert.ok(!(RETRY_ERROR_CODES as readonly string[]).includes('UND_ERR_RES_CONTENT_LENGTH_MISMATCH'));

    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).replyWithError(networkError('UND_ERR_RES_CONTENT_LENGTH_MISMATCH'));
    // A dispatcher retry would consume THIS success — it must stay pending, proving one attempt.
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(200, LIST_XML);

    await assert.rejects(listPrefix(CONFIG, 'cap/'));
    assert.equal(mockAgent.pendingInterceptors().length, 1);
  });

  it('an object read (Layers 2–4 path) self-heals: HEAD flaps twice, then answers', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'HEAD' }).replyWithError(networkError('ETIMEDOUT')).times(2);
    pool
      .intercept({ path: ANY_BUCKET_PATH, method: 'HEAD' })
      .reply(200, '', { headers: { 'x-amz-meta-status': 'body', 'Content-Type': 'text/plain', 'Content-Length': '5' } });

    const meta = await new S3Store(CONFIG).head('20140403040000/http://example.com/');
    assert.deepEqual(meta, { contentType: 'text/plain', status: 'body', size: 5 });
    mockAgent.assertNoPendingInterceptors();
  });

  it('a transport that ALWAYS fails is retried to the cap, then rejects — exactly 1 + maxRetries attempts', async () => {
    // maxRetries defaults to 3 → 4 attempts. Register exactly 4 flaps plus a
    // success SENTINEL: reaching it would resolve the call, so a still-pending
    // sentinel after a rejection proves the retries stopped at exactly 4.
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).replyWithError(networkError()).times(4);
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(200, LIST_XML);

    await assert.rejects(listPrefix(CONFIG, 'cap/'));
    assert.equal(mockAgent.pendingInterceptors().length, 1); // the sentinel was never reached
  });

  it('runParityCheck rejects when the read never recovers (the command prints one line, exit 1)', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).replyWithError(networkError()).persist();
    // Layer 1's list read exhausts its retries and never recovers — the whole run
    // rejects, which the `bucket verify` handler catches into a single clean error line.
    await assert.rejects(runParityCheck({ ...CONFIG, root: FIXTURE_ROOT, layers: [1] }));
  });
});

describe('failure diagnosis — an exhausted retry reads as a diagnosis, not a shrug', () => {
  it('tags a list-page failure with its prefix + page and renders the HTTP-status line', async () => {
    // A throttle that outlives the retries: 503 forever, with a Retry-After hint.
    pool
      .intercept({ path: ANY_BUCKET_PATH, method: 'GET' })
      .reply(503, 'busy', { headers: { 'retry-after': '2' } })
      .persist();

    const error = await listPrefix(CONFIG, 'cap/').catch(e => e as unknown);
    assert.ok(error instanceof ParityTaskError);
    assert.equal((error as ParityTaskError).context, 'layer 1 (count parity) · list cap/ page 1');

    // The line the command prints (minus its `bucket verify:` prefix): excavated
    // HTTP status, attempt count, Retry-After, and a concrete lower-concurrency remedy.
    const line = diagnoseFailure(error, 16);
    assert.equal(
      line,
      'layer 1 (count parity) · list cap/ page 1: HTTP 503 after 4 attempts (Retry-After: 2)' +
        ' — persistent throttling at --concurrency 16? try --concurrency 8'
    );
  });

  it('tags a body-verification read (Layer 3) with its layer + object key', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).reply(503, 'busy').persist();

    // Drive the real Layer-3 runner; concurrency 1 makes the first failing object
    // deterministic. The GET never recovers, so mapPool tags it with layer + key.
    // (Tiny bodyRetry backoff: the exhausted-503 shape is TERMINAL and never
    // body-retried, but keep the test instant even if that policy drifts.)
    const error = await runParityCheck({
      ...CONFIG,
      root: FIXTURE_ROOT,
      layers: [3],
      concurrency: 1,
      bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
    }).catch(e => e as unknown);
    assert.ok(error instanceof ParityTaskError);
    assert.match((error as ParityTaskError).context, /^layer 3 \(body verification\) · cap\/[0-9a-f]{2}\//);
    // No Retry-After header this time — the shape drops that clause but keeps the hint.
    assert.match(
      diagnoseFailure(error, 16),
      /^layer 3 \(body verification\) · cap\/.+: HTTP 503 after 4 attempts — persistent throttling at --concurrency 16\? try --concurrency 8$/
    );
  });

  it('a deepest network errno surfaces (no HTTP shape, no throttle hint)', async () => {
    pool.intercept({ path: ANY_BUCKET_PATH, method: 'GET' }).replyWithError(networkError('ECONNREFUSED')).persist();

    const error = await listPrefix(CONFIG, 'cap/').catch(e => e as unknown);
    // An exhausted DNS/connect flap: the errno is the signal, not an HTTP status.
    assert.equal(diagnoseFailure(error, 16), 'layer 1 (count parity) · list cap/ page 1: ECONNREFUSED');
  });

  it('surfaces COMPLETED layer verdicts when a later layer gives out mid-run', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    // Layer 1 lists cap/ and meta/ EXACTLY (so it PASSES), then Layer 3's object
    // GETs 503 forever (so the run dies there) — proving the completed layer's
    // verdict survives the failure.
    pool.intercept({ path: /prefix=cap/, method: 'GET' }).reply(200, listXml(entries.map(e => e.capKey))).persist();
    pool.intercept({ path: /prefix=meta/, method: 'GET' }).reply(200, listXml(entries.map(e => e.metaKey))).persist();
    pool.intercept({ path: new RegExp(`^/${BUCKET}/cap/`), method: 'GET' }).reply(503, 'busy').persist();

    const error = (await runParityCheck({
      ...CONFIG,
      root: FIXTURE_ROOT,
      layers: [1, 3],
      concurrency: 1,
      bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
    }).catch(e => e)) as ParityTaskError & { completedLayers?: LayerReport[] };

    // Layer 1 finished and PASSED before Layer 3's reads gave out.
    const completed = error.completedLayers ?? [];
    assert.deepEqual(completed.map(l => l.layer), [1]);
    assert.equal(completed[0].pass, true);
    assert.match(formatLayerVerdict(completed[0]), /^ {2}layer 1 — count parity \(per prefix\): PASS · /);

    // …and the surviving diagnosis names Layer 3 as where the network gave out.
    assert.match(diagnoseFailure(error, 16), /^layer 3 \(body verification\) · cap\/.+: HTTP 503 after 4 attempts/);
  });
});
