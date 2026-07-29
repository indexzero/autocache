/**
 * S3Store contract tests — the remote read path (src/s3store.ts). The store now
 * calls the PLATFORM `fetch` directly (no injectable transport), so the tests
 * intercept at the platform seam by mocking `globalThis.fetch` (node:test's
 * `mock.method`), two ways per what each proves:
 *
 *   - REQUEST CONSTRUCTION (the signed request's shape, the URL, the Fastly
 *     `backend` passthrough) is asserted by reading the [url, init] the store
 *     hands the mocked fetch. The `backend` member is a Fastly-Compute-only
 *     init field that never appears on the wire, so it can ONLY be observed on
 *     the fetch call itself.
 *   - RESPONSE INTERPRETATION (metaOf, the 404 miss, error-vs-miss) and the
 *     shared store-conformance suite mock fetch to answer HEAD/GET with
 *     S3-shaped Response objects. An afterEach restores the real fetch so no
 *     mock leaks between tests.
 *
 * Offline and deterministic — no network, no minio, no S3, no undici. The
 * store's cross-backend parity is proved by the SHARED store-conformance suite
 * (test/store-conformance.ts), plugged in below through its population seam.
 *
 * An optional minio deep-check is deliberately NOT wired: real-target fidelity
 * belongs to the population/parity issue, and minio is a daemon, never a devDep.
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { capturePath } from '@charlie.dev/waybackify/key.js';
import { S3Store } from '../src/s3store.ts';
import type { Capture } from '../src/store.ts';
import { runStoreConformance, type Seed } from './store-conformance.ts';

const ENDPOINT = 'https://acct.r2.example.test';
const BUCKET = 'wayback-captures';
const REGION = 'auto';
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

// Restore the real globalThis.fetch after every test so a mock never leaks into
// a sibling test — node:test's top-level `mock` is not auto-restored.
afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

/** A recorded S3 object: the response headers, and the body (null = bodiless). */
interface Recorded {
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Build an S3-shaped Response. A `Uint8Array` body (never a string) is used so
 * fetch does NOT inject a default `text/plain` Content-Type — the store must
 * see exactly the headers we record (including their ABSENCE, which the
 * normalization tests depend on).
 */
function makeResponse(status: number, headers: Record<string, string>, body: string | null): Response {
  const bytes = body === null || body === '' ? null : new TextEncoder().encode(body);
  return new Response(bytes, { status, headers: new Headers(headers) });
}

/**
 * Mock `globalThis.fetch` to answer the store's path-style object requests from
 * `objects` (keyed by full URL). HEAD carries no body; GET streams the recorded
 * body. An unknown URL is a 404 — the store's one and only miss.
 */
function useBucket(objects: Map<string, Recorded>): void {
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const object = objects.get(url);
    if (object === undefined) return makeResponse(404, {}, '');
    const body = method === 'HEAD' ? null : object.body;
    return makeResponse(200, object.headers, body);
  });
}

/** Mock fetch to answer EVERY object request with `status`/`body`. */
function useStatus(status: number, body = ''): void {
  mock.method(globalThis, 'fetch', async () => makeResponse(status, {}, body));
}

/** The object URL the store will build for a capture key (path-style). */
async function objectUrl(key: string): Promise<string> {
  return `${ENDPOINT}/${BUCKET}/${await capturePath(key)}`;
}

/** Record one entry seed as the emitter would upload it (native metadata). */
async function record(objects: Map<string, Recorded>, seed: Extract<Seed, { kind: 'entry' }>): Promise<void> {
  const headers: Record<string, string> = {
    // Content-Type VERBATIM (including '') — normalization is a read mask.
    'Content-Type': seed.contentType,
    'x-amz-meta-status': seed.status
  };
  if (seed.status === 'body') {
    const bytes = new TextEncoder().encode(seed.body ?? '');
    headers['Content-Length'] = String(bytes.length);
    objects.set(await objectUrl(seed.key), { headers, body: seed.body ?? '' });
  } else {
    // Bodiless status → a zero-byte object carrying only status metadata.
    headers['Content-Length'] = '0';
    objects.set(await objectUrl(seed.key), { headers, body: null });
  }
}

function newStore(): S3Store {
  return new S3Store({ endpoint: ENDPOINT, bucket: BUCKET, region: REGION, credentials: CREDENTIALS });
}

runStoreConformance({
  name: 'S3Store',
  async populate(seeds) {
    const objects = new Map<string, Recorded>();
    for (const seed of seeds) {
      // An orphan is a torn write — no native-metadata store can express one
      // (the emitter only ever uploads a complete object), so it is ABSENT.
      if (seed.kind === 'orphan') continue;
      await record(objects, seed);
    }
    useBucket(objects);
    return newStore();
  }
  // No breakBody: body and metadata are FUSED on the object (one HTTP response),
  // so the disk-level "head() never reads the body" proof can't be expressed —
  // the suite keeps the structural head()-has-no-body check for this store.
});

describe('S3Store', () => {
  const KEY = '20140403040000/http://example.com/';

  describe('the signed request (mocking the platform fetch)', () => {
    type FetchInit = { method: string; headers: Record<string, string>; backend?: string };
    /** Mock globalThis.fetch, canning a 200, and hand back the mock for call inspection. */
    function spyFetch(): ReturnType<typeof mock.method> {
      return mock.method(globalThis, 'fetch', async () =>
        new Response(null, { status: 200, headers: { 'x-amz-meta-status': 'body', 'Content-Length': '2' } }));
    }

    it('HEAD/GET sign an UNSIGNED-PAYLOAD SigV4 request at the hash object URL', async () => {
      const spy = spyFetch();
      await newStore().head(KEY);

      const [url, init] = spy.mock.calls[0].arguments as [string, FetchInit];
      assert.equal(url, await objectUrl(KEY)); // path-style, hash path, no damage
      assert.equal(init.method, 'HEAD');
      assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request,/);
      assert.equal(init.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
      assert.match(init.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
      // The signed Host is the endpoint authority, never a caller value.
      assert.equal(init.headers.host, 'acct.r2.example.test');
    });

    it('merges fetchOptions (Fastly `backend`) into the init handed to the platform fetch', async () => {
      const spy = spyFetch();
      const store = new S3Store({
        endpoint: ENDPOINT, bucket: BUCKET, region: REGION, credentials: CREDENTIALS,
        fetchOptions: { backend: 'object-storage' }
      });
      await store.get(KEY);

      const [, init] = spy.mock.calls[0].arguments as [string, FetchInit];
      assert.equal(init.backend, 'object-storage'); // rides through untyped, invisible on the wire
      assert.equal(init.method, 'GET'); // signed members not clobbered by the merge
      assert.ok(init.headers.authorization.includes('AWS4-HMAC-SHA256'));
    });

    it('applies a key prefix inside the bucket', async () => {
      const spy = spyFetch();
      const store = new S3Store({ endpoint: ENDPOINT, bucket: BUCKET, region: REGION, credentials: CREDENTIALS, prefix: 'corpus/' });
      await store.head(KEY);
      const [url] = spy.mock.calls[0].arguments as [string];
      assert.equal(url, `${ENDPOINT}/${BUCKET}/corpus/${await capturePath(KEY)}`);
    });
  });

  describe('error vs miss — only 404 is a miss', () => {
    it('404 is the one and only miss (head + get → null)', async () => {
      useBucket(new Map());
      const store = newStore();
      assert.equal(await store.head(KEY), null);
      assert.equal(await store.get(KEY), null);
    });

    for (const status of [403, 500, 503]) {
      it(`${status} THROWS — a fault must never masquerade as a miss`, async () => {
        useStatus(status, 'denied');
        const store = newStore();
        await assert.rejects(store.head(KEY), /S3Store/);
        await assert.rejects(store.get(KEY), /S3Store/);
      });
    }
  });

  describe('reads', () => {
    async function bodiedStore(): Promise<S3Store> {
      const objects = new Map<string, Recorded>();
      await record(objects, { kind: 'entry', key: KEY, status: 'body', contentType: 'text/html; charset=utf-8', body: '<html>x</html>' });
      useBucket(objects);
      return newStore();
    }

    it('head() answers metadata from response headers; get() adds the exact bytes', async () => {
      const store = await bodiedStore();
      assert.deepEqual(await store.head(KEY), { contentType: 'text/html; charset=utf-8', status: 'body', size: 14 });
      const capture = await store.get(KEY);
      assert.equal(await new Response((capture as Capture).body).text(), '<html>x</html>');
    });

    it('an absent Content-Type header normalizes to application/octet-stream', async () => {
      const objects = new Map<string, Recorded>();
      objects.set(await objectUrl(KEY), { headers: { 'x-amz-meta-status': 'body', 'Content-Length': '2' }, body: 'ok' });
      useBucket(objects);
      assert.equal((await newStore().head(KEY))?.contentType, 'application/octet-stream');
    });

    it('an absent x-amz-meta-status defaults to body (R2/KV back-compat)', async () => {
      const objects = new Map<string, Recorded>();
      objects.set(await objectUrl(KEY), { headers: { 'Content-Type': 'text/plain', 'Content-Length': '2' }, body: 'ok' });
      useBucket(objects);
      const meta = await newStore().head(KEY);
      assert.equal(meta?.status, 'body');
      assert.equal(meta?.size, 2);
    });
  });
});
