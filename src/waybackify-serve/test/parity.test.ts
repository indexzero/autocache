/**
 * The four-layer root ↔ bucket PARITY gate (src/parity.ts, #292), driven
 * against the committed cache-root fixture PROJECTED to bucket shape
 * (test/s3-fixture.ts — the same projection the serve router's remote-mode test
 * uses) over an offline stub S3 endpoint that answers HEAD/GET and ListObjectsV2.
 *
 * The all-green case proves a faithful projection passes every layer (including
 * the empty-contentType normalization — a `''` sidecar's correct native value
 * IS application/octet-stream, compared post-normalization). Then one INJECTED
 * DEFECT per failure mode, each asserted to be caught by the RIGHT layer:
 *
 *   wrong status metadata → Layer 2      corrupted body      → Layer 3
 *   wrong content-type     → Layer 2      missing object      → Layer 1 (+ 2)
 *   extra object           → Layer 1      serving divergence  → Layer 4
 *
 * Offline and deterministic — no network, no minio, no real S3.
 */

import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { capturePath } from '@autocache/waybackify/key.js';
import { createRetryAgent } from '../src/retry.ts';
import {
  checkBodies,
  checkCounts,
  checkMetadata,
  checkServing,
  enumerateRoot,
  listPrefix,
  ParityTaskError,
  runParityCheck,
  type ParityConfig
} from '../src/parity.ts';
import { projectFixtureToBucket, startS3Stub, type S3Object } from './s3-fixture.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));
const BUCKET = 'wayback-captures';
/** Any non-empty pair — the stub verifies no signature; signing just needs values. */
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

/** Start a stub over `objects`, hand a pointed config to `fn`, always tear down. */
async function withBucket<T>(objects: Map<string, S3Object>, fn: (config: ParityConfig) => Promise<T>, pageSize?: number): Promise<T> {
  const stub = await startS3Stub(objects, BUCKET, pageSize);
  try {
    return await fn({ root: FIXTURE_ROOT, endpoint: stub.url, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS });
  } finally {
    await stub.close();
  }
}

/** A fresh, independently-mutable copy of a projected bucket. */
function clone(objects: Map<string, S3Object>): Map<string, S3Object> {
  const copy = new Map<string, S3Object>();
  for (const [key, object] of objects) copy.set(key, { headers: { ...object.headers }, body: object.body });
  return copy;
}

/** The first `cap/` object with a `body` status — the target for body/meta defects. */
function firstBodyCapKey(objects: Map<string, S3Object>): string {
  for (const [key, object] of objects) {
    if (key.startsWith('cap/') && object.headers['x-amz-meta-status'] === 'body') return key;
  }
  throw new Error('fixture has no bodied cap object');
}

describe('parity — enumerateRoot', () => {
  it('reads one entry per sidecar (the sidecar IS the entry; the orphan cap/ is not one)', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    // 7 sidecars: 4 body + empty + redirect + error. The orphan cap/ file has
    // no sidecar, so it is NOT an entry.
    assert.equal(entries.length, 7);
    assert.equal(entries.filter(e => e.status === 'body').length, 4);
    const statuses = new Set(entries.map(e => e.status));
    assert.deepEqual(statuses, new Set(['body', 'empty', 'redirect', 'error']));
    // Object keys are derived through the shared key module.
    const example = entries.find(e => e.key === '20140403040000/http://example.com/');
    assert.equal(example?.capKey, await capturePath('20140403040000/http://example.com/'));
  });
});

describe('parity — listPrefix (ListObjectsV2)', () => {
  it('enumerates a prefix and paginates through continuation tokens', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    // pageSize 2 forces the truncation/continuation loop over 7 cap objects.
    const capKeys = await withBucket(objects, config => listPrefix(config, 'cap/'), 2);
    assert.equal(capKeys.length, 7);
    assert.equal(capKeys.every(k => k.startsWith('cap/')), true);
  });

  it('strips a configured bucket prefix so keys compare against object keys', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT, 'corpus');
    const stub = await startS3Stub(objects, BUCKET);
    try {
      const config: ParityConfig = { root: FIXTURE_ROOT, endpoint: stub.url, bucket: BUCKET, region: 'auto', prefix: 'corpus', credentials: CREDENTIALS };
      const capKeys = await listPrefix(config, 'cap/');
      assert.equal(capKeys.length, 7);
      // Returned rootless of the `corpus/` bucket prefix.
      assert.equal(capKeys.every(k => k.startsWith('cap/')), true);
    } finally {
      await stub.close();
    }
  });
});

describe('parity — all four layers, faithful projection', () => {
  it('passes every layer (including empty-contentType normalization)', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const report = await withBucket(objects, config => runParityCheck({ ...config }));

    assert.equal(report.entries, 7);
    assert.equal(report.pass, true);
    for (const layer of report.layers) assert.equal(layer.pass, true, `layer ${layer.layer}`);

    const layer1 = report.layers.find(l => l.layer === 1)!;
    assert.deepEqual(layer1.counts, { entries: 7, cap: 7, meta: 7 });
  });

  it('the empty/error `""` content-type entries pass the metadata sweep (read-mask normalization)', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const emptyish = entries.filter(e => e.contentType === '');
    assert.ok(emptyish.length >= 2); // empty + error
    const report = await withBucket(objects, config => checkMetadata(config, entries, config));
    assert.equal(report.pass, true);
  });
});

describe('parity — injected defects, each caught by the right layer', () => {
  it('LAYER 1 catches an EXTRA bucket object (no local sidecar iterates it)', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    objects.set('cap/zz/zzextraobject', { headers: { 'x-amz-meta-status': 'body', 'Content-Length': '2' }, body: Buffer.from('hi') });
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkCounts(config, entries));
    assert.equal(report.pass, false);
    assert.ok(report.mismatches.some(m => m.field === 'cap-extra' && m.key === 'cap/zz/zzextraobject'));
  });

  it('LAYER 1 catches a MISSING object (present in root, absent in bucket)', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    const gone = firstBodyCapKey(objects);
    objects.delete(gone);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkCounts(config, entries));
    assert.equal(report.pass, false);
    assert.ok(report.mismatches.some(m => m.field === 'cap-missing' && m.key === gone));
  });

  it('LAYER 2 also catches the missing object (HEAD → 404 presence failure)', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    const gone = firstBodyCapKey(objects);
    objects.delete(gone);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkMetadata(config, entries, config));
    assert.equal(report.pass, false);
    assert.ok(report.mismatches.some(m => m.field === 'presence' && m.key === gone));
  });

  it('LAYER 2 catches WRONG status metadata', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    const target = firstBodyCapKey(objects);
    objects.set(target, { ...objects.get(target)!, headers: { ...objects.get(target)!.headers, 'x-amz-meta-status': 'error' } });
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkMetadata(config, entries, config));
    assert.equal(report.pass, false);
    assert.ok(report.mismatches.some(m => m.field === 'status' && m.key === target && m.expected === 'body'));
  });

  it('LAYER 2 catches a WRONG content-type', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    const target = firstBodyCapKey(objects);
    objects.set(target, { ...objects.get(target)!, headers: { ...objects.get(target)!.headers, 'Content-Type': 'application/wrong' } });
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkMetadata(config, entries, config));
    assert.equal(report.pass, false);
    assert.ok(report.mismatches.some(m => m.field === 'contentType' && m.key === target && m.actual === 'application/wrong'));
  });

  it('LAYER 3 catches a CORRUPTED body (sha256 diverges from the sidecar SRI)', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    const target = firstBodyCapKey(objects);
    const original = objects.get(target)!;
    // Same byte length (Content-Length unchanged, so Layer 2 stays green) but
    // different bytes — only the body hash can catch this.
    objects.set(target, { headers: original.headers, body: Buffer.alloc(original.body.length, 0x00) });
    const entries = await enumerateRoot(FIXTURE_ROOT);

    const [meta, bodies] = await withBucket(objects, async config => [
      await checkMetadata(config, entries, config),
      await checkBodies(config, entries, config)
    ]);
    assert.equal(meta.pass, true); // metadata untouched
    assert.equal(bodies.pass, false);
    assert.ok(bodies.mismatches.some(m => m.field === 'contentHash' && m.key === target));
  });

  it('LAYER 4 catches a serving divergence (a corrupted sampled body serves different bytes)', async () => {
    const objects = clone(await projectFixtureToBucket(FIXTURE_ROOT));
    // Corrupt the example.com document body — a `body`/text-html entry that
    // Layer 4 samples — so the bucket serves different bytes than the root.
    const docKey = await capturePath('20140403040000/http://example.com/');
    const original = objects.get(docKey)!;
    const corrupted = Buffer.from(original.body.toString('utf8').replace('Example Domain', 'Tampered Domain'));
    objects.set(docKey, { headers: { ...original.headers, 'Content-Length': String(corrupted.length) }, body: corrupted });

    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkServing(config, entries, { ...config, sample: 5 }));
    assert.equal(report.pass, false);
    assert.ok(report.mismatches.some(m => m.field === 'body' && m.key === '20140403040000/http://example.com/'));
  });

  it('LAYER 4 passes on a faithful projection (root and bucket serve identically)', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const report = await withBucket(objects, config => checkServing(config, entries, { ...config, sample: 5 }));
    assert.equal(report.pass, true);
    // body(4) + empty(1) + redirect(1) + error(1) sampled, plus the miss→302.
    assert.equal(report.checked, 8);
  });
});

describe('parity — LAYER 3 re-fetches a THROWN body READ, and ONLY the body read (#499, #500)', () => {
  // The re-fetch under test is PHASE-SCOPED (an ownership boundary, see
  // src/parity.ts verifyBody): the dispatcher (./retry.ts) owns every failure
  // BEFORE the response handoff, so a store.get throw must PROPAGATE; Layer 3
  // owns only a throw from consuming the handed-off body, the one failure the
  // dispatcher can never replay. The REAL mid-stream shape (which MockAgent
  // cannot fabricate — it buffers whole bodies) comes from a raw-socket stub;
  // the pre-handoff and impossible-state shapes come from a MockAgent under the
  // production RetryAgent and a hand-rolled dispatcher respectively.
  const ORIGIN = 'https://parity.mock.test';
  const MOCK_CONFIG: ParityConfig = { root: FIXTURE_ROOT, endpoint: ORIGIN, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS };

  /** A transport error exactly as undici raises it: an Error carrying `code`. */
  function codedError(code: string, message = `${code} simulated`): Error {
    return Object.assign(new Error(message), { code });
  }

  /** Run `fn` with a plain MockAgent installed globally, always restoring. */
  async function withMockAgent<T>(fn: (pool: ReturnType<MockAgent['get']>, agent: MockAgent) => Promise<T>): Promise<T> {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const real = getGlobalDispatcher();
    setGlobalDispatcher(mockAgent);
    try {
      return await fn(mockAgent.get(ORIGIN), mockAgent);
    } finally {
      setGlobalDispatcher(real);
      await mockAgent.close();
    }
  }

  it('PHASE GUARD (#500): a PRE-HANDOFF failure that outlives the dispatcher FAILS the layer — store.get is never app-retried into a PASS', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const target = entries.filter(e => e.status === 'body')[0]; // deterministic — entries are sorted

    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const real = getGlobalDispatcher();
    // The SAME retrying dispatcher `bucket verify` installs (./retry.ts), with
    // tiny backoff — pre-handoff replays are ITS job, and this test exhausts it.
    setGlobalDispatcher(createRetryAgent(mockAgent, { minTimeout: 1, maxTimeout: 5 }));
    try {
      const pool = mockAgent.get(ORIGIN);
      // Every dispatch of the target dies BEFORE headers: ECONNRESET is in the
      // dispatcher's RETRY_ERROR_CODES, so the RetryAgent replays it to its cap
      // (1 + maxRetries(3) = 4 attempts) and the fetch itself rejects —
      // store.get throws a dispatcher-already-exhausted error whose code is
      // ALSO in the Layer 3 body allowlist. The phase cut, not the code, must
      // decide: pre-handoff → propagate.
      pool.intercept({ path: `/${BUCKET}/${target.capKey}`, method: 'GET' }).replyWithError(codedError('ECONNRESET')).times(4);
      // The would-be heal: the REAL object bytes. If Layer 3 app-retried the
      // store.get failure, dispatch #5 would consume this and verify green — a
      // genuinely unreachable object healed into a false PASS, exactly the
      // #500 bug. It must stay PENDING.
      const object = objects.get(target.capKey)!;
      pool.intercept({ path: `/${BUCKET}/${target.capKey}`, method: 'GET' }).reply(200, object.body, { headers: object.headers });

      const error = await checkBodies(MOCK_CONFIG, entries, {
        ...MOCK_CONFIG,
        concurrency: 1,
        bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
      }).catch(e => e as unknown);

      assert.ok(error instanceof ParityTaskError);
      assert.equal((error as ParityTaskError).context, `layer 3 (body verification) · ${target.capKey}`);
      assert.equal(mockAgent.pendingInterceptors().length, 1); // the heal was never consumed
    } finally {
      setGlobalDispatcher(real);
      await mockAgent.close();
    }
  });

  it('an ERR_ASSERTION thrown from the body read is NOT retried — it fails CLOSED (#500)', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const target = entries.filter(e => e.status === 'body')[0]; // deterministic — entries are sorted

    // A hand-rolled dispatcher that hands the 200 + headers off cleanly (the
    // fetch RESOLVES, so the failure lands unambiguously POST-handoff, inside
    // the body read) and then errors the body stream with ERR_ASSERTION —
    // undici reaching a state it declared impossible. There is no nameable
    // recovery for that, so the allowlist excludes it and the read must fail
    // closed. MockAgent cannot stage a mid-body error (it buffers whole
    // bodies), hence the raw dispatcher-handler protocol.
    const gets = new Map<string, number>();
    const assertionDispatcher = {
      dispatch(opts: { path: string; method: string }, handler: {
        onConnect?: (abort: () => void) => void;
        onHeaders: (status: number, rawHeaders: Buffer[], resume: () => void, statusText: string) => boolean;
        onData: (chunk: Buffer) => boolean;
        onComplete: (trailers: string[]) => void;
        onError: (error: Error) => void;
      }): boolean {
        const key = decodeURIComponent(new URL(opts.path, ORIGIN).pathname.slice(`/${BUCKET}/`.length));
        gets.set(key, (gets.get(key) ?? 0) + 1);
        handler.onConnect?.(() => {});
        const object = objects.get(key);
        if (object === undefined) {
          handler.onError(new Error(`unexpected key ${key}`));
          return true;
        }
        const rawHeaders = Object.entries(object.headers).flatMap(([name, value]) => [Buffer.from(name), Buffer.from(String(value))]);
        handler.onHeaders(200, rawHeaders, () => {}, 'OK');
        if (key === target.capKey && gets.get(key) === 1) {
          // Handoff complete, some bytes delivered… then the impossible state.
          // Deferred a tick, like the real thing: the fetch must fully resolve
          // and wire its response stream BEFORE the body errors, or the error
          // lands mid-construction and the shape under test never forms.
          setTimeout(() => {
            handler.onData(object.body.subarray(0, Math.floor(object.body.length / 2)));
            handler.onError(codedError('ERR_ASSERTION', 'undici internal assertion: unreachable state'));
          }, 1);
          return true;
        }
        // Any LATER GET of the target would serve it faithfully and heal it —
        // reaching here is exactly the retry Fix B forbids.
        handler.onData(object.body);
        handler.onComplete([]);
        return true;
      },
      close: () => Promise.resolve(),
      destroy: () => Promise.resolve()
    };

    const real = getGlobalDispatcher();
    setGlobalDispatcher(assertionDispatcher as unknown as Dispatcher);
    try {
      const error = await checkBodies(MOCK_CONFIG, entries, {
        ...MOCK_CONFIG,
        concurrency: 1,
        bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
      }).catch(e => e as unknown);

      assert.ok(error instanceof ParityTaskError);
      assert.equal((error as ParityTaskError).context, `layer 3 (body verification) · ${target.capKey}`);
      // FAILS CLOSED: exactly ONE GET — the would-be heal was never requested.
      assert.equal(gets.get(target.capKey), 1);
    } finally {
      setGlobalDispatcher(real);
    }
  });

  it('a body that breaks mid-stream EVERY time exhausts after exactly `attempts` GETs, then rejects with layer + key context', async () => {
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const target = entries.filter(e => e.status === 'body')[0]; // deterministic — entries are sorted

    // Break exactly `attempts` times: a 4th GET would be served FAITHFULLY and
    // heal the object, so gets === 3 after the rejection proves the re-fetch
    // stopped at the cap and rethrew — persistent failure is never masked.
    const stub = await startBreakableStub(objects, target.capKey, 3);
    try {
      const config: ParityConfig = { root: FIXTURE_ROOT, endpoint: stub.url, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS };
      const error = await checkBodies(config, entries, {
        ...config,
        concurrency: 1,
        bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
      }).catch(e => e as unknown);

      assert.ok(error instanceof ParityTaskError);
      assert.equal((error as ParityTaskError).context, `layer 3 (body verification) · ${target.capKey}`);
      assert.equal(stub.gets.get(target.capKey), 3); // exactly `attempts`, the heal never reached
    } finally {
      await stub.close();
    }
  });

  it('a TERMINAL error (403) is rethrown on the first attempt — never retried into a false PASS', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const target = entries.filter(e => e.status === 'body')[0];

    await withMockAgent(async (pool, mockAgent) => {
      // S3Store.get THROWS on a 403 (a fault must never masquerade as a miss).
      // The retry loop must rethrow it untouched: only the transient
      // body-transport class is re-fetched, and healing a flapping auth fault
      // into a green layer is exactly what a verification gate must not do.
      pool.intercept({ path: `/${BUCKET}/${target.capKey}`, method: 'GET' }).reply(403, 'forbidden');
      // A retry would consume THIS heal — it must stay pending, proving the 403
      // was rethrown immediately, not retried into a pass.
      pool.intercept({ path: `/${BUCKET}/${target.capKey}`, method: 'GET' }).reply(200, 'would-have-healed');

      const error = await checkBodies(MOCK_CONFIG, entries, {
        ...MOCK_CONFIG,
        concurrency: 1,
        bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
      }).catch(e => e as unknown);

      assert.ok(error instanceof ParityTaskError);
      assert.equal((error as ParityTaskError).context, `layer 3 (body verification) · ${target.capKey}`);
      assert.match(String((error as ParityTaskError).cause), /403/);
      assert.equal(mockAgent.pendingInterceptors().length, 1); // the would-be heal was never consumed
    });
  });

  it('a REAL mid-stream break (200 handed off, body shorter than Content-Length) heals on re-fetch', async () => {
    // The genuine #499 shape, which MockAgent cannot fabricate (it never
    // enforces framing): the response is a 200 whose headers arrive intact —
    // the dispatcher has fully handed the body off to sriOf — and the stream
    // then dies short of its declared Content-Length, so undici raises
    // UND_ERR_RES_CONTENT_LENGTH_MISMATCH mid-read. A raw-socket stub is the
    // only way to produce that framing on purpose.
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    const target = bodied[0]; // deterministic — entries are sorted

    const stub = await startBreakableStub(objects, target.capKey, 1);
    try {
      const config: ParityConfig = { root: FIXTURE_ROOT, endpoint: stub.url, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS };
      const report = await checkBodies(config, entries, {
        ...config,
        concurrency: 1,
        bodyRetry: { attempts: 3, minTimeout: 1, maxTimeout: 1 }
      });
      assert.equal(report.pass, true);
      assert.equal(report.mismatches.length, 0);
      assert.equal(report.checked, bodied.length);
      // The broken object was fetched EXACTLY twice (the break + the heal)…
      assert.equal(stub.gets.get(target.capKey), 2);
      // …and no other object paid a re-fetch.
      for (const entry of bodied) {
        if (entry.capKey !== target.capKey) assert.equal(stub.gets.get(entry.capKey), 1, entry.capKey);
      }
    } finally {
      await stub.close();
    }
  });
});

/** What {@link startBreakableStub} hands back: endpoint + per-key GET counts. */
interface BreakableStub {
  url: string;
  /** Object key → GET count, for exact fetched-N-times assertions. */
  gets: Map<string, number>;
  close: () => Promise<void>;
}

/**
 * A raw-socket S3 GET stub whose first `breakTimes` GETs of `breakKey` answer a
 * 200 with the object's REAL Content-Length but only half the bytes, then FIN —
 * the exact torn-stream framing that makes undici's parser raise
 * UND_ERR_RES_CONTENT_LENGTH_MISMATCH while the body is being read (#499).
 * `Connection: close` on every response keeps it one-request-per-connection
 * (and is what routes undici's EOF handling through the parser-finish path
 * that yields the mismatch error rather than a bare socket error). Every other
 * GET answers the recorded object faithfully. Layer 3 only ever GETs, so GET is
 * all this stub speaks.
 */
function startBreakableStub(objects: Map<string, S3Object>, breakKey: string, breakTimes: number): Promise<BreakableStub> {
  const gets = new Map<string, number>();
  let remainingBreaks = breakTimes;

  const server = net.createServer(socket => {
    let buffered = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return; // one request per connection (every response closes)
      buffered += chunk.toString('latin1');
      if (!buffered.includes('\r\n\r\n')) return; // request headers still arriving
      handled = true;

      const [requestLine] = buffered.split('\r\n', 1);
      const rawPath = requestLine.split(' ')[1] ?? '/';
      const key = decodeURIComponent(new URL(rawPath, 'http://stub').pathname.slice(`/${BUCKET}/`.length));
      gets.set(key, (gets.get(key) ?? 0) + 1);

      const object = objects.get(key);
      if (object === undefined) {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }

      const head =
        'HTTP/1.1 200 OK\r\n' +
        Object.entries(object.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('') +
        'Connection: close\r\n\r\n';

      if (key === breakKey && remainingBreaks > 0) {
        remainingBreaks -= 1;
        // Full Content-Length declared, half the bytes delivered, then a clean
        // FIN a beat later — headers land first (the fetch resolves), the read
        // then throws the mid-stream mismatch.
        socket.write(head);
        socket.write(object.body.subarray(0, Math.floor(object.body.length / 2)));
        setTimeout(() => socket.end(), 5);
        return;
      }
      socket.write(head);
      socket.end(object.body);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        gets,
        close: () => new Promise<void>(done => server.close(() => done()))
      });
    });
  });
}
