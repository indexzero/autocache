// The wrapper-stub remediation sweep — offline. Each root is built through
// the store's own writer; the stubs are the committed interstitial fixture
// (the archive's viewer page), exactly what `cache fill` leaves behind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyFile, cacheCapture, commitEntry, readSidecar } from '../cache.js';
import { interstitials, remediate } from '../remediate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = fs.readFileSync(path.join(HERE, 'fixtures/interstitial/wrapper-stub.html'));
const REDIRECT = fs.readFileSync(path.join(HERE, 'fixtures/interstitial/redirect-interstitial.html'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-remediate-'));
const key = name => `20030224204757/http://example.org/${name}`;
const raw = name => `https://web.archive.org/web/20030224204757id_/http://example.org/${name}`;
const reply = (status, body = '', contentType = 'image/gif') => ({
  status,
  headers: { get: h => (h === 'content-type' ? contentType : null) },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer
});
const stub = (root, name, extra = {}) =>
  commitEntry(root, { key: key(name), status: 'body', contentType: 'text/html', body: new Uint8Array(STUB), ...extra });
const sweep = (root, routes, extra = {}) => {
  const rows = [];
  const calls = [];
  const promise = remediate(root, {
    delayMs: 0,
    sleep: async () => {},
    fetch: async url => {
      calls.push(url);
      const r = routes[url];
      if (r instanceof Error) throw r;
      if (!r) throw new Error(`unrouted ${url}`);
      return r;
    },
    onEntry: row => rows.push(row),
    ...extra
  });
  return { promise, rows, calls };
};

describe('remediate — refetch wrapper stubs raw', () => {
  it('a stub blocks its capture until the sweep: fill skips it, remediate fixes it', async () => {
    const root = tmp();
    // What `cache fill` does with a GIF asked for through the normal replay.
    const fetched = await cacheCapture('https://web.archive.org/web/20030224204757/http://example.org/logo.gif', {
      root, fetch: async () => reply(200, STUB.toString('utf8'), 'text/html')
    });
    assert.equal(fetched.entries[0].status, 'interstitial');
    // Asking again — even raw — is satisfied by the sidecar that records the refusal.
    const again = await cacheCapture(raw('logo.gif'), { root, fetch: async () => assert.fail('no fetch: the stub sidecar wins') });
    assert.equal(again.entries[0].action, 'skipped');

    const { promise, rows, calls } = sweep(root, { [raw('logo.gif')]: reply(200, 'GIF89a-logo') });
    const result = await promise;
    assert.deepEqual(calls, [raw('logo.gif')]);
    assert.deepEqual(rows, [{ key: key('logo.gif'), url: raw('logo.gif'), outcome: 'fixed', status: 'body', contentType: 'image/gif', bytes: 11 }]);
    assert.deepEqual(result, { interstitials: 1, tally: { fixed: 1 }, throttled: false, dryRun: false });
    const sidecar = await readSidecar(root, key('logo.gif'));
    assert.equal(sidecar.status, 'body');
    assert.equal(sidecar.flag, 'id_', 'the sidecar records that these are the raw bytes');
    assert.equal(sidecar.signature, undefined);
    assert.equal(fs.readFileSync(bodyFile(root, sidecar.contentHash), 'utf8'), 'GIF89a-logo');
  });

  it('classifies every interstitial: fixed, still, unavailable, deferred, repick', async () => {
    const root = tmp();
    await stub(root, 'a.gif');
    await stub(root, 'b.gif');
    await stub(root, 'c.gif');
    await stub(root, 'd.gif');
    // Already fetched raw and still a stub: asking again cannot help.
    await stub(root, 'e.gif', { flag: 'id_' });
    // A redirect interstitial needs a different capture, not other bytes.
    await commitEntry(root, { key: key('f.html'), status: 'body', contentType: 'text/html', body: new Uint8Array(REDIRECT) });
    assert.equal((await interstitials(root)).length, 6);

    const { promise, rows } = sweep(root, {
      [raw('a.gif')]: reply(200, 'GIF89a-a'),
      [raw('b.gif')]: reply(200, STUB.toString('utf8'), 'text/html'),
      [raw('c.gif')]: reply(404),
      [raw('d.gif')]: reply(503)
    });
    const result = await promise;
    assert.deepEqual(rows.map(r => [r.key.split('/').pop(), r.outcome]), [
      ['a.gif', 'fixed'], ['b.gif', 'still'], ['c.gif', 'unavailable'], ['d.gif', 'deferred'], ['e.gif', 'repick'], ['f.html', 'repick']
    ]);
    assert.deepEqual(result.tally, { fixed: 1, still: 1, unavailable: 1, deferred: 1, repick: 2 });
    // `still` rewrote the sidecar with flag id_, so the next sweep leaves it alone.
    assert.equal((await readSidecar(root, key('b.gif'))).flag, 'id_');
    const second = sweep(root, { [raw('c.gif')]: reply(404), [raw('d.gif')]: reply(200, 'GIF89a-d') });
    await second.promise;
    assert.deepEqual(second.calls, [raw('c.gif'), raw('d.gif')], 'a re-run retries only what a raw refetch can still cure');
  });

  it('stops on a throttle instead of spending a request on every stub', async () => {
    const root = tmp();
    for (const n of ['a', 'b', 'c', 'd', 'e']) await stub(root, `${n}.gif`);
    const routes = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(n => [raw(`${n}.gif`), n === 'b' ? new Error('timeout') : reply(429)]));
    const { promise, calls } = sweep(root, routes, { throttleAfter: 3 });
    const result = await promise;
    assert.equal(result.throttled, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(result.tally, { deferred: 3 });
  });

  it('dryRun classifies and fetches nothing; max caps the refetches', async () => {
    const root = tmp();
    await stub(root, 'a.gif');
    await stub(root, 'b.gif');
    const dry = sweep(root, {}, { dryRun: true });
    assert.deepEqual((await dry.promise).tally, { 'would-refetch': 2 });
    assert.equal(dry.calls.length, 0);
    const capped = sweep(root, { [raw('a.gif')]: reply(200, 'GIF89a-a') }, { max: 1 });
    assert.deepEqual((await capped.promise).tally, { fixed: 1 });
    assert.equal(capped.calls.length, 1);
  });

  it('an empty or absent root has nothing to sweep', async () => {
    assert.deepEqual(await remediate(tmp(), { fetch: async () => assert.fail('no fetch') }), { interstitials: 0, tally: {}, throttled: false, dryRun: false });
  });
});

describe('cacheCapture — how a document was asked for, and how fast', () => {
  it('records `id_` on a document fetched raw; a replayed document keeps flag null', async () => {
    const root = tmp();
    const fetch = async () => reply(200, 'GIF89a-x');
    await cacheCapture(raw('x.gif'), { root, fetch });
    await cacheCapture('https://web.archive.org/web/20030224204757/http://example.org/y.txt', { root, fetch: async () => reply(200, 'plain', 'text/plain') });
    assert.equal((await readSidecar(root, key('x.gif'))).flag, 'id_');
    assert.equal((await readSidecar(root, key('y.txt'))).flag, null);
  });

  it('requestDelayMs paces the requisite requests of one capture, not the first', async () => {
    const root = tmp();
    const page = fs.readFileSync(path.join(HERE, 'fixtures/replay/requisites-page.html'), 'utf8');
    const sleeps = [];
    const summary = await cacheCapture('https://web.archive.org/web/20111011002337/http://example.com/post/scaling-isomorphic-javascript-code', {
      root,
      requestDelayMs: 700,
      sleep: async ms => { sleeps.push(ms); },
      fetch: async url => (url.includes('/post/') ? reply(200, page, 'text/html') : reply(200, 'asset', 'application/x-fake'))
    });
    const requisites = summary.entries.length - 1;
    assert.ok(requisites > 1);
    assert.deepEqual(sleeps, Array(requisites - 1).fill(700));
  });
});
