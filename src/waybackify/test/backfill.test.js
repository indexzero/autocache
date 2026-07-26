// node --test — the backfill engine's decision logic, driven through injected
// deps (no network, no real cacheCapture). The end-to-end pass over a real
// corpus sample lives in backfill.e2e.test.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfill, selectWorklist, classifyFailure } from '../backfill.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
const item = (key, state) => ({ key, state, waybackUrl: `https://web.archive.org/web/${key}` });

describe('selectWorklist — closure-aware, key-sorted', () => {
  it('includes unfetched AND cached, excludes interstitial/error, sorts by key', () => {
    const worklists = {
      unfetched: [item('3/u'), item('1/u')],
      cached: [item('2/c')],
      interstitial: [item('4/i')],
      error: [item('5/e')]
    };
    assert.deepEqual(selectWorklist(worklists), [
      'https://web.archive.org/web/1/u',
      'https://web.archive.org/web/2/c',
      'https://web.archive.org/web/3/u'
    ]);
  });

  it('tolerates missing buckets and item without waybackUrl', () => {
    assert.deepEqual(selectWorklist({}), []);
    assert.deepEqual(selectWorklist({ cached: [{ key: '1/x' }] }), []);
  });
});

describe('classifyFailure — defer-vs-abort fork', () => {
  it('404 → gone; non-200 → transient; connect errors → connfail', () => {
    assert.equal(classifyFailure(new Error('replay returned HTTP 404 — capture missing')), 'gone');
    assert.equal(classifyFailure(new Error('replay returned HTTP 498 (transient archive.org trouble? retry)')), 'transient');
    assert.equal(classifyFailure(new Error("ConnectError('tcp connect error', ConnectionRefused)")), 'connfail');
    assert.equal(classifyFailure(new Error('connect ECONNREFUSED 1.2.3.4:443')), 'connfail');
  });
  it('reads err.cause and {error} records; unknown → transient', () => {
    const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' };
    assert.equal(classifyFailure(e), 'connfail');
    assert.equal(classifyFailure({ error: 'read ECONNRESET' }), 'connfail');
    assert.equal(classifyFailure(new Error('weird')), 'transient');
  });
});

// A fake cacheCapture whose outcome is chosen per-url by a script map.
// value: {fetched,skipped,failures} object → returned; Error → thrown.
function fakeCacheCapture(script) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const v = script[url];
    if (v instanceof Error) throw v;
    return { key: url, root: '', entries: [], fetched: 0, skipped: 0, failures: [], ...(v ?? {}) };
  };
  fn.calls = calls;
  return fn;
}

// Build the deps for a run whose worklist is exactly `urls` (unfetched).
function depsFor(urls, cacheCapture, extra = {}) {
  const against = async () => ({
    unfetched: urls.map((u, i) => ({ key: `${String(i).padStart(3, '0')}/${u}`, waybackUrl: u })),
    cached: [], interstitial: [], error: []
  });
  let againstCalls = 0;
  const wrapped = async (...a) => { againstCalls++; return against(...a); };
  wrapped.count = () => againstCalls;
  return { deps: { discover: () => [], against: wrapped, cacheCapture, sleep: async () => {}, wayback: {} }, against: wrapped, ...extra };
}

describe('backfill — durable worklist + outcomes', () => {
  it('--dry-run builds+persists the worklist and fetches nothing', async () => {
    const root = tmpRoot();
    const cc = fakeCacheCapture({});
    const { deps } = depsFor(['u://a', 'u://b'], cc);
    const r = await backfill({ ledgerDir: 'x', root, dryRun: true, deps });
    assert.equal(r.dryRun, true);
    assert.equal(r.pending, 2);
    assert.equal(cc.calls.length, 0, 'no fetches on dry-run');
    assert.ok(fs.existsSync(path.join(root, '.refetch', 'worklist.jsonl')));
  });

  it('classifies fetched / cached / deferred / gone and records gone durably', async () => {
    const root = tmpRoot();
    const cc = fakeCacheCapture({
      'u://fetch': { fetched: 3 },                                  // real fetch
      'u://done': { skipped: 5 },                                   // fully closed
      'u://soft': new Error('replay returned HTTP 498 (transient archive.org trouble? retry)'),
      'u://gone': new Error('replay returned HTTP 404 — capture missing')
    });
    const { deps } = depsFor(['u://fetch', 'u://done', 'u://soft', 'u://gone'], cc);
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps });
    assert.deepEqual(r.stats, { attempted: 3, fetched: 1, cached: 1, deferred: 1, gone: 1 });
    const gone = fs.readFileSync(path.join(root, '.refetch', 'gone.jsonl'), 'utf8');
    assert.match(gone, /u:\/\/gone/);
    assert.doesNotMatch(gone, /u:\/\/soft/, 'transient is deferred, NOT gone');
  });

  it('aborts after N consecutive connection failures', async () => {
    const root = tmpRoot();
    const conn = new Error("ConnectError('tcp connect error', ConnectionRefused)");
    const cc = fakeCacheCapture({ 'u://1': conn, 'u://2': conn, 'u://3': conn, 'u://4': conn });
    const { deps } = depsFor(['u://1', 'u://2', 'u://3', 'u://4'], cc);
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, abortAfter: 2, deps });
    assert.equal(r.aborted, true);
    assert.equal(cc.calls.length, 2, 'stops at the abort threshold, not the whole list');
  });

  it('a real reply between failures resets the abort streak', async () => {
    const root = tmpRoot();
    const conn = new Error('connect ECONNREFUSED');
    const cc = fakeCacheCapture({ 'u://1': conn, 'u://2': { fetched: 1 }, 'u://3': conn, 'u://4': conn });
    const { deps } = depsFor(['u://1', 'u://2', 'u://3', 'u://4'], cc);
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, abortAfter: 2, deps });
    assert.equal(r.aborted, true);
    assert.equal(cc.calls.length, 4, 'the fetch at #2 reset the streak, so it ran to the end');
  });

  it('--max caps network attempts (cached skips are free)', async () => {
    const root = tmpRoot();
    const cc = fakeCacheCapture({
      'u://c1': { skipped: 1 }, 'u://f1': { fetched: 1 },
      'u://f2': { fetched: 1 }, 'u://f3': { fetched: 1 }
    });
    const { deps } = depsFor(['u://c1', 'u://f1', 'u://f2', 'u://f3'], cc);
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, max: 2, deps });
    assert.equal(r.stats.attempted, 2);
    assert.equal(r.stats.fetched, 2);
  });

  it('reuses the durable worklist on a second run (no re-enumerate)', async () => {
    const root = tmpRoot();
    const cc = fakeCacheCapture({ 'u://a': { skipped: 1 }, 'u://b': { skipped: 1 } });
    const { deps, against } = depsFor(['u://a', 'u://b'], cc);
    await backfill({ ledgerDir: 'x', root, delayMs: 0, deps });
    await backfill({ ledgerDir: 'x', root, delayMs: 0, deps });
    assert.equal(against.count(), 1, 'enumerate ran once; the second run reused the worklist file');
    await backfill({ ledgerDir: 'x', root, delayMs: 0, refresh: true, deps });
    assert.equal(against.count(), 2, '--refresh re-enumerated');
  });

  it('a requisite-only failure defers (doc landed, closure short)', async () => {
    const root = tmpRoot();
    const cc = fakeCacheCapture({ 'u://x': { fetched: 1, failures: [{ key: 'k', error: 'HTTP 498' }] } });
    const { deps } = depsFor(['u://x'], cc);
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps });
    assert.equal(r.stats.deferred, 1);
    assert.equal(r.stats.fetched, 0);
  });
});
