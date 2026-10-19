/**
 * Resumable verification. The engine emits a checkpoint snapshot as it
 * works. A later run that receives that snapshot as `resume` skips the layers
 * that passed and the Layer 3 bodies that already verified. A snapshot for a
 * different root entry set or a different bucket target is void, and the run
 * reads every requested layer in full.
 *
 * Offline: the stub S3 endpoint from s3-fixture.ts records every request, so
 * each test counts exactly which reads a resumed run made.
 */

import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateRoot,
  type Entry,
  ParityTaskError,
  runParityCheck,
  type ParityConfig,
  type ParityLogger
} from '../src/parity.ts';
import { rootSignature, type VerifyCheckpoint } from '../src/verify-checkpoint.ts';
import { projectFixtureToBucket, startS3Stub, type S3Object, type S3Stub, type StubOverride } from './s3-fixture.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));
const BUCKET = 'wayback-captures';
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

/**
 * One stub for the whole test, so that every run sees one endpoint, as two runs
 * of one operator do. `throttle` names a `cap/` key whose GET answers 429.
 * `fresh()` clears the request log between runs.
 */
interface Bucket {
  config: ParityConfig;
  stub: S3Stub;
  objects: Map<string, S3Object>;
  throttle: string | undefined;
  fresh(): void;
}

async function withBucket<T>(fn: (bucket: Bucket) => Promise<T>): Promise<T> {
  const objects = await projectFixtureToBucket(FIXTURE_ROOT);
  const bucket = { throttle: undefined } as Bucket;
  const override: StubOverride = r => (r.method === 'GET' && r.key === bucket.throttle ? 429 : undefined);
  const stub = await startS3Stub(objects, BUCKET, undefined, override);
  Object.assign(bucket, {
    config: { root: FIXTURE_ROOT, endpoint: stub.url, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS },
    stub,
    objects,
    fresh: () => { stub.requests.length = 0; }
  });
  try {
    return await fn(bucket);
  } finally {
    await stub.close();
  }
}

/** A logger that records each warning object. */
function recordingLogger(): ParityLogger & { warnings: object[] } {
  const warnings: object[] = [];
  return { warnings, info() {}, warn(obj) { warnings.push(obj ?? {}); }, error() {} };
}

/** The object keys that a stub answered for one HTTP method. */
function keysFor(stub: S3Stub, method: string): string[] {
  return stub.requests.filter(r => r.method === method && r.key !== null).map(r => r.key as string);
}

/** The count of ListObjectsV2 requests that a stub answered. */
function listCount(stub: S3Stub): number {
  return stub.requests.filter(r => r.key === null).length;
}

/** Run layers 1 to 3 with one bodied object throttled, and return the last checkpoint. */
async function throttledCheckpoint(bucket: Bucket, throttledKey: string): Promise<VerifyCheckpoint> {
  const saved: VerifyCheckpoint[] = [];
  bucket.throttle = throttledKey;
  const error = await runParityCheck({
    ...bucket.config,
    layers: [1, 2, 3],
    concurrency: 1,
    checkpointEvery: 1,
    onCheckpoint: checkpoint => { saved.push(checkpoint); }
  }).catch(e => e as unknown);
  bucket.throttle = undefined;
  bucket.fresh();
  assert.ok(error instanceof ParityTaskError, 'the throttled read ends the run');
  assert.ok(saved.length > 0, 'the run emitted a checkpoint');
  return saved[saved.length - 1];
}

describe('parity resume — checkpoint emission', () => {
  it('a throttled Layer 3 leaves a checkpoint with the passed layers and the bodies verified so far', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    await withBucket(async bucket => {
      const checkpoint = await throttledCheckpoint(bucket, bodied[2].capKey);
      assert.equal(checkpoint.signature, rootSignature(entries));
      assert.deepEqual(checkpoint.target, { endpoint: bucket.config.endpoint, bucket: BUCKET, prefix: '' });
      assert.deepEqual(checkpoint.passed.map(l => l.layer), [1, 2]);
      assert.ok(checkpoint.passed.every(l => l.pass));
      assert.deepEqual(checkpoint.bodies.verified, bodied.slice(0, 2).map(e => e.capKey));
    });
  });

  it('a failed layer is never recorded as passed, and a mismatched body is never recorded as verified', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    const corrupt = bodied[1].capKey;
    await withBucket(async bucket => {
      const original = bucket.objects.get(corrupt) as S3Object;
      bucket.objects.set(corrupt, { headers: original.headers, body: Buffer.alloc(original.body.length, 0x41) });
      const saved: VerifyCheckpoint[] = [];
      const report = await runParityCheck({ ...bucket.config, layers: [1, 2, 3], onCheckpoint: c => { saved.push(c); } });
      assert.equal(report.pass, false);
      const last = saved[saved.length - 1];
      assert.deepEqual(last.passed.map(l => l.layer), [1, 2]);
      assert.deepEqual([...last.bodies.verified].sort(), bodied.filter(e => e.capKey !== corrupt).map(e => e.capKey).sort());

      // The resume, after a repair of the object, reads only the mismatched body.
      bucket.objects.set(corrupt, original);
      bucket.fresh();
      const resumed = await runParityCheck({ ...bucket.config, layers: [1, 2, 3], resume: last });
      assert.equal(resumed.pass, true);
      assert.deepEqual(keysFor(bucket.stub, 'GET'), [corrupt]);
    });
  });
});

describe('parity resume — skipping passed work', () => {
  it('a resume skips passed layers 1 and 2 and re-reads only the unverified Layer 3 bodies', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    await withBucket(async bucket => {
      const checkpoint = await throttledCheckpoint(bucket, bodied[2].capKey);
      const report = await runParityCheck({ ...bucket.config, layers: [1, 2, 3], concurrency: 4, resume: checkpoint });
      assert.equal(report.pass, true);
      assert.equal(report.verdict, 'PASS');
      assert.deepEqual(report.layers.map(l => [l.layer, l.fromCheckpoint === true]), [[1, true], [2, true], [3, false]]);
      const layer3 = report.layers[2];
      assert.equal(layer3.checked, bodied.length);
      assert.equal(layer3.resumed, 2);

      assert.equal(listCount(bucket.stub), 0, 'Layer 1 made no list request');
      assert.deepEqual(keysFor(bucket.stub, 'HEAD'), [], 'Layer 2 made no HEAD request');
      assert.deepEqual(keysFor(bucket.stub, 'GET').sort(), bodied.slice(2).map(e => e.capKey).sort());
    });
  });

  it('a resume of a fully passed checkpoint makes no bucket read at all', async () => {
    await withBucket(async bucket => {
      const saved: VerifyCheckpoint[] = [];
      await runParityCheck({ ...bucket.config, onCheckpoint: c => { saved.push(c); } });
      const checkpoint = saved[saved.length - 1];
      assert.deepEqual(checkpoint.passed.map(l => l.layer), [1, 2, 3, 4]);

      bucket.fresh();
      const report = await runParityCheck({ ...bucket.config, resume: checkpoint });
      assert.equal(report.pass, true);
      assert.ok(report.layers.every(l => l.fromCheckpoint === true));
      assert.equal(bucket.stub.requests.length, 0);
    });
  });

  it('a different --sample voids only the recorded Layer 4 verdict', async () => {
    await withBucket(async bucket => {
      const saved: VerifyCheckpoint[] = [];
      await runParityCheck({ ...bucket.config, sample: 3, onCheckpoint: c => { saved.push(c); } });
      const report = await runParityCheck({ ...bucket.config, sample: 2, resume: saved[saved.length - 1] });
      assert.deepEqual(report.layers.map(l => [l.layer, l.fromCheckpoint === true]), [[1, true], [2, true], [3, true], [4, false]]);
    });
  });
});

describe('parity resume — invalidation', () => {
  it('a checkpoint for a different root entry set is void: every layer runs in full, with a warning', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    const logger = recordingLogger();
    await withBucket(async bucket => {
      const checkpoint = await throttledCheckpoint(bucket, bodied[2].capKey);
      const stale: VerifyCheckpoint = { ...checkpoint, signature: `${checkpoint.signature}-changed` };
      const report = await runParityCheck({ ...bucket.config, layers: [1, 2, 3], resume: stale, logger });
      assert.equal(report.pass, true);
      assert.ok(report.layers.every(l => l.fromCheckpoint !== true));
      assert.equal(report.layers[2].resumed, 0);
      assert.equal(listCount(bucket.stub), 2, 'Layer 1 listed cap/ and meta/');
      assert.equal(keysFor(bucket.stub, 'HEAD').length, entries.length);
      assert.deepEqual(keysFor(bucket.stub, 'GET').sort(), bodied.map(e => e.capKey).sort());
    });
    assert.ok(logger.warnings.some(w => (w as { evt?: string }).evt === 'parity-checkpoint-void'));
  });

  it('a checkpoint for a different bucket target is void (a prefixed tier never borrows the naked tier progress)', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    await withBucket(async bucket => {
      const checkpoint = await throttledCheckpoint(bucket, bodied[2].capKey);
      const otherTier: VerifyCheckpoint = { ...checkpoint, target: { ...checkpoint.target, prefix: 'orig' } };
      const report = await runParityCheck({ ...bucket.config, layers: [1, 2, 3], resume: otherTier, logger: recordingLogger() });
      assert.ok(report.layers.every(l => l.fromCheckpoint !== true));
      assert.equal(listCount(bucket.stub), 2);
      assert.equal(keysFor(bucket.stub, 'GET').length, bodied.length);
    });
  });

  it('the root signature changes when one sidecar field changes', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const base = rootSignature(entries);
    assert.equal(rootSignature(entries.map(e => ({ ...e }))), base);
    // One edit per hashed field. A field that the signature drops lets a
    // resume skip work for a changed entry, which is a false PASS.
    const bodiedIndex = entries.findIndex(e => e.status === 'body');
    const edits: Array<[string, (e: Entry) => Entry]> = [
      ['key', e => ({ ...e, key: `${e.key}x` })],
      ['status', e => ({ ...e, status: e.status === 'body' ? 'empty' : 'body' })],
      ['contentType', e => ({ ...e, contentType: `${e.contentType}x` })],
      ['contentHash', e => ({ ...e, contentHash: `${e.contentHash}x` })],
      ['contentLength', e => ({ ...e, contentLength: (e.contentLength ?? 0) + 1 })]
    ];
    for (const [field, edit] of edits) {
      const edited = entries.map((e, i) => (i === bodiedIndex ? edit(e) : e));
      assert.notEqual(rootSignature(edited), base, field);
    }
    assert.notEqual(rootSignature(entries.slice(1)), base);
  });
});

describe('parity resume — a failed run', () => {
  /** Run Layer 3 with `throttled` answering 429, and record each sink call against the rejection. */
  async function failedRun(bucket: Bucket, throttled: string, checkpointEvery?: number) {
    bucket.throttle = throttled;
    let rejected = false;
    const calls: { afterReject: boolean; checkpoint: VerifyCheckpoint }[] = [];
    const error = await runParityCheck({
      ...bucket.config,
      layers: [3],
      concurrency: 4,
      checkpointEvery,
      onCheckpoint: checkpoint => { calls.push({ afterReject: rejected, checkpoint }); }
    }).catch((e: unknown) => {
      rejected = true;
      return e;
    });
    // Give a stray worker time to finish, so that a late sink call is visible.
    await new Promise(resolve => setTimeout(resolve, 100));
    return { error, calls };
  }

  it('a failed Layer 3 with concurrent workers saves every body that verified before it rejects', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    await withBucket(async bucket => {
      const { error, calls } = await failedRun(bucket, bodied[0].capKey);
      assert.ok(error instanceof ParityTaskError);
      const served = keysFor(bucket.stub, 'GET').filter(key => key !== bodied[0].capKey);
      assert.ok(served.length > 0, 'other workers had reads in flight when the throttle hit');
      const last = calls.filter(c => !c.afterReject).at(-1);
      assert.ok(last, 'the run saved a checkpoint before it rejected');
      assert.deepEqual([...last.checkpoint.bodies.verified].sort(), [...served].sort());
    });
  });

  it('a 429 mid-run at concurrency 2 starts no new read, drains the read in flight, and saves it before it rejects', async () => {
    // The throttled body answers after 5 ms. The other worker has a body in
    // flight that answers after 50 ms. The pool must not start a third read,
    // must wait for the second, and must save it before the run rejects.
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const served: string[] = [];
    const objects = await projectFixtureToBucket(FIXTURE_ROOT);
    const stub = await startS3Stub(objects, BUCKET, undefined, async r => {
      if (r.method !== 'GET' || r.key === null) return undefined;
      if (r.key === bodied[0].capKey) {
        await delay(5);
        return 429;
      }
      await delay(50);
      served.push(r.key);
      return undefined;
    });
    try {
      let rejected = false;
      const calls: { afterReject: boolean; checkpoint: VerifyCheckpoint }[] = [];
      const config: ParityConfig = { root: FIXTURE_ROOT, endpoint: stub.url, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS };
      const error = await runParityCheck({
        ...config,
        layers: [3],
        concurrency: 2,
        onCheckpoint: checkpoint => { calls.push({ afterReject: rejected, checkpoint }); }
      }).catch((e: unknown) => {
        rejected = true;
        return e;
      });
      const atReject = [...served];
      await delay(200);

      assert.ok(error instanceof ParityTaskError);
      assert.match(String(error), /429/);
      assert.deepEqual(served, [bodied[1].capKey], 'only the read in flight finished, and no new read started');
      assert.deepEqual(atReject, served, 'the read in flight finished before the rejection');
      assert.deepEqual(calls.filter(c => c.afterReject), [], 'nothing writes after the rejection');
      const last = calls.at(-1);
      assert.ok(last);
      assert.deepEqual(last.checkpoint.bodies.verified, served, 'every body that verified is in the saved checkpoint');
    } finally {
      await stub.close();
    }
  });

  it('a failed run never calls onCheckpoint after it rejects', async () => {
    const entries = await enumerateRoot(FIXTURE_ROOT);
    const bodied = entries.filter(e => e.status === 'body');
    await withBucket(async bucket => {
      const { error, calls } = await failedRun(bucket, bodied[0].capKey, 1);
      assert.ok(error instanceof ParityTaskError);
      assert.deepEqual(calls.filter(c => c.afterReject).map(c => c.checkpoint.bodies.verified.length), []);
    });
  });
});
