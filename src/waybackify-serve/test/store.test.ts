/**
 * Store adapter tests (#249). The vendor types are structural (see
 * src/store.ts), so these suites drive R2Store with plain fake objects that
 * honor R2's actual shape — httpMetadata content-type + customMetadata status
 * over the hash-keyed layout. (The Fastly remote path is an S3Store, covered
 * by test/s3store.ts against the shared conformance suite + an S3 fetch fake.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capturePath } from '@autocache/waybackify/key.js';
import {
  MemoryStore,
  R2Store,
  type Capture,
  type CaptureStatus,
  type R2BucketLike
} from '../src/store.ts';
import { runStoreConformance } from './store-conformance.ts';

/** UTF-8 byte length — how every store measures a body size. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const KEY = '20140403040000/http://example.com/';

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

describe('R2Store', () => {
  // A fake R2 binding over the hash-keyed layout: the native-metadata bucket
  // the batch sync emitter writes — each object at its cap/<aa>/<hash> key
  // carries its content-type on httpMetadata and its status on
  // customMetadata, a bodiless status being a zero-byte object. Body stream
  // reads are counted so "head() never fetches the body" is an assertion, not
  // a comment.
  function fakeBucket() {
    const objects = new Map<string, { contentType: string; status: CaptureStatus; body: string }>();
    const bodyReads = { count: 0 };
    const objectOf = (o: { contentType: string; status: CaptureStatus; body: string }) => ({
      size: byteLength(o.body),
      httpMetadata: { contentType: o.contentType },
      customMetadata: { status: o.status }
    });
    const bucket: R2BucketLike = {
      async head(key) {
        const o = objects.get(key);
        return o === undefined ? null : objectOf(o);
      },
      async get(key) {
        const o = objects.get(key);
        if (o === undefined) return null;
        return {
          ...objectOf(o),
          get body(): ReadableStream<Uint8Array> {
            bodyReads.count += 1;
            return streamOf(o.body);
          }
        };
      }
    };
    return { objects, bodyReads, bucket };
  }

  // The full read contract — status discriminators, orphan-is-absent,
  // content-type normalization, hostile keys — lives in the shared suite.
  // R2Store's population seam is native-metadata (content-type + status per
  // object; bodiless statuses zero-byte), keyed by the shared hash layout, so
  // a torn write is inexpressible (skip 'orphan' → the required absent). No
  // breakBody: body and metadata are one object.
  runStoreConformance({
    name: 'R2Store',
    async populate(seeds) {
      const { objects, bucket } = fakeBucket();
      for (const seed of seeds) {
        if (seed.kind === 'orphan') continue;
        const body = seed.status === 'body' ? seed.body ?? '' : '';
        objects.set(await capturePath(seed.key), { contentType: seed.contentType, status: seed.status, body });
      }
      return new R2Store(bucket);
    }
  });

  it('reads the cap/<aa>/<hash> object — content-type from httpMetadata, status from customMetadata', async () => {
    const { objects, bucket } = fakeBucket();
    // Populated at the DERIVED hash key, not the verbatim capture key: the
    // store must map the key through capturePath to find it.
    objects.set(await capturePath(KEY), { contentType: 'text/html', status: 'body', body: '<body>x</body>' });
    const store = new R2Store(bucket);
    assert.deepEqual(await store.head(KEY), { contentType: 'text/html', status: 'body', size: 14 });
    const capture = await store.get(KEY);
    assert.equal(capture?.contentType, 'text/html');
    assert.equal(await new Response((capture as Capture).body).text(), '<body>x</body>');
    // A different key hashes elsewhere and misses — no verbatim-key leakage.
    assert.equal(await store.head(`${KEY}other`), null);
  });

  it('head() reads metadata via the binding head() and never fetches the body', async () => {
    const { objects, bucket, bodyReads } = fakeBucket();
    objects.set(await capturePath(KEY), { contentType: 'text/html', status: 'body', body: '<body>x</body>' });
    const store = new R2Store(bucket);
    await store.head(KEY);
    assert.equal(bodyReads.count, 0);
    await store.get(KEY);
    assert.equal(bodyReads.count, 1);
  });
});

describe('MemoryStore', () => {
  // The full Store read contract — status discriminators, orphan-is-absent,
  // content-type normalization, hostile keys — lives in the shared suite.
  // MemoryStore's population seam is put(): native-metadata semantics (a
  // content-type + status per object; bodiless statuses carry no body),
  // exactly what the batch sync emitter will write to a bucket. A torn write
  // is inexpressible here (the emitter never writes a half object), so an
  // 'orphan' seed is simply not populated — which reads back as the required
  // absent. No breakBody: body and metadata are one object.
  runStoreConformance({
    name: 'MemoryStore',
    async populate(seeds) {
      const store = new MemoryStore();
      for (const seed of seeds) {
        if (seed.kind === 'orphan') continue;
        store.put(seed.key, seed.status === 'body' ? seed.body ?? '' : null, seed.contentType, seed.status);
      }
      return store;
    }
  });

  it('put() still round-trips the back-compatible 3-arg body shape', async () => {
    const store = new MemoryStore();
    store.put(KEY, 'hello', 'text/plain');
    assert.deepEqual(await store.head(KEY), { contentType: 'text/plain', status: 'body', size: 5 });
    assert.equal((await store.get(KEY) as { body: string }).body, 'hello');
  });
});
