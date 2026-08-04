/**
 * Edge logging (design §9): the serving path emits notable events through an
 * injected `EdgeLogger` (warn-only, node-free). A MISS / bodiless capture warns;
 * the HIT happy path stays silent. The runtime entry supplies the observable
 * `console`-shim by default, or the no-op when silenced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, edgeConsoleLogger, type EdgeLogger } from '../src/app.ts';
import { createCloudflareHandler } from '../src/cloudflare.ts';
import { captureKey } from '../src/path.ts';
import { MemoryStore, type R2BucketLike } from '../src/store.ts';

const TS = '20140403040000';
const ORIGINAL = 'http://sudomakethought.com/post/123';

/** A logger that records every warn(obj, msg). */
function captureLogger(): EdgeLogger & { calls: Array<{ obj?: object; msg?: string }> } {
  const calls: Array<{ obj?: object; msg?: string }> = [];
  return { calls, warn(obj?: object, msg?: string) { calls.push({ obj, msg }); } };
}

describe('edge logging — the injected EdgeLogger', () => {
  it('a MISS warns {evt:"miss", key}; a HIT stays silent', async () => {
    const store = new MemoryStore();
    store.put(captureKey(TS, ORIGINAL), '<h1>hi</h1>', 'text/html');
    const log = captureLogger();
    const app = createApp(store, { logger: log });

    await app.request(`/${TS}/${ORIGINAL}`); // HIT
    assert.equal(log.calls.length, 0, 'the HIT happy path emits nothing (hot path stays silent)');

    await app.request(`/${TS}/http://sudomakethought.com/nope`); // MISS
    assert.equal(log.calls.length, 1);
    assert.deepEqual(log.calls[0].obj, { evt: 'miss', key: captureKey(TS, 'http://sudomakethought.com/nope') });
  });

  it('with no logger injected the app is silent (no-op fallback) and still serves', async () => {
    const store = new MemoryStore();
    const app = createApp(store); // no logger
    const res = await app.request(`/${TS}/http://x/none`);
    assert.equal(res.status, 404); // a miss, answered — and no throw from a missing logger
  });
});

describe('edge entries — console-shim by default, no-op when silenced', () => {
  /** A fake R2 bucket that always misses (get/head → null). */
  const emptyBucket: R2BucketLike = {
    async get() { return null; },
    async head() { return null; }
  } as unknown as R2BucketLike;

  it('createCloudflareHandler defaults to the observable console-shim', async () => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (line?: unknown) => { seen.push(String(line)); };
    try {
      const handler = createCloudflareHandler();
      await handler.fetch(new Request('https://x/20140403040000/http://x/none'), { WAYBACK_CAPTURES: emptyBucket });
    } finally {
      console.warn = orig;
    }
    assert.equal(seen.length, 1, 'a miss streams one console.warn line by default');
    assert.match(seen[0], /"evt":"miss"/);
  });

  it('WAYBACK_LOG_SILENT truthy injects the no-op (no console output)', async () => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (line?: unknown) => { seen.push(String(line)); };
    try {
      const handler = createCloudflareHandler();
      await handler.fetch(new Request('https://x/20140403040000/http://x/none'), { WAYBACK_CAPTURES: emptyBucket, WAYBACK_LOG_SILENT: '1' });
    } finally {
      console.warn = orig;
    }
    assert.equal(seen.length, 0, 'the silence var opts into the no-op');
  });

  it('edgeConsoleLogger emits a single JSON-tailed line per warn', () => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (line?: unknown) => { seen.push(String(line)); };
    try {
      edgeConsoleLogger().warn({ evt: 'miss', key: 'k' }, 'corpus miss');
    } finally {
      console.warn = orig;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'corpus miss {"evt":"miss","key":"k"}');
  });
});
