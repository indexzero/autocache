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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capturePath } from '@charlie.dev/waybackify/key.js';
import {
  checkBodies,
  checkCounts,
  checkMetadata,
  checkServing,
  enumerateRoot,
  listPrefix,
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
