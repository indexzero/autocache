// node --test — the backfill engine's decision logic, driven through injected
// deps (no network, no real cacheCapture). The end-to-end pass over a real
// corpus sample lives in backfill.e2e.test.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfill, selectWorklist, classifyFailure } from '../backfill.js';
import { githubRepo, probeGithub } from '../github.js';

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

  it('timeouts count as connfail (impit ConnectTimeout / "request timeout")', () => {
    assert.equal(classifyFailure(new Error("ConnectTimeout('request timeout')")), 'connfail');
    assert.equal(classifyFailure(new Error('request timeout')), 'connfail');
    assert.equal(classifyFailure(new Error('read ETIMEDOUT')), 'connfail');
  });

  it('a 404 is terminal but an incidental longer number is NOT gone', () => {
    assert.equal(classifyFailure(new Error('replay returned HTTP 404 — capture missing')), 'gone');
    // regression: /HTTP 404\b/ must not fire on "HTTP 4040" and exile a live capture
    assert.equal(classifyFailure(new Error('upstream said HTTP 4040 weirdness')), 'transient');
    assert.equal(classifyFailure(new Error('HTTP 4041')), 'transient');
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

describe('backfill: a GitHub deep-link 404 probes the repo root first', () => {
  const ORIG = 'https://github.com/old-owner/old-repo/commit/0123456789abcdef0123456789abcdef01234567';
  const GH = `https://web.archive.org/web/20160312105649/${ORIG}`;
  const TO = 'https://github.com/new-owner/new-repo/commit/0123456789abcdef0123456789abcdef01234567';
  const missing = () => new Error('replay returned HTTP 404 — capture missing');
  const probeWith = reply => {
    const calls = [];
    const probe = async url => {
      calls.push(url);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    probe.calls = calls;
    return probe;
  };

  it('a renamed repo is a rewrite candidate, never a gone verdict', async () => {
    const root = tmpRoot();
    const probe = probeWith({ renamed: true, from: ORIG, to: TO });
    const { deps } = depsFor([GH], fakeCacheCapture({ [GH]: missing() }));
    const events = [];
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe }, onProgress: ev => events.push(ev) });
    assert.deepEqual(probe.calls, [ORIG], 'the probe receives the original URL, not the replay URL');
    assert.equal(r.stats.gone, 0);
    assert.equal(fs.existsSync(path.join(root, '.refetch', 'gone.jsonl')), false, 'nothing is terminal');
    assert.deepEqual(r.renames, [{ waybackUrl: GH, from: ORIG, to: TO }]);
    const ledger = fs.readFileSync(path.join(root, '.refetch', 'renamed.jsonl'), 'utf8');
    assert.deepEqual(JSON.parse(ledger), { waybackUrl: GH, from: ORIG, to: TO });
    assert.ok(events.some(ev => ev.type === 'rename' && ev.to === TO), 'the rename is surfaced as a progress event');
    assert.ok(events.some(ev => ev.type === 'entry' && ev.outcome === 'renamed'));
  });

  it('a recorded rename is not probed again on the next run', async () => {
    const root = tmpRoot();
    const probe = probeWith({ renamed: true, from: ORIG, to: TO });
    const cc = fakeCacheCapture({ [GH]: missing() });
    const { deps } = depsFor([GH], cc);
    await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
    assert.equal(r.pending, 0);
    assert.equal(cc.calls.length, 1);
    assert.equal(probe.calls.length, 1);
  });

  it('only a 404 that survives the root probe is recorded as gone', async () => {
    const root = tmpRoot();
    const probe = probeWith({ renamed: false });
    const { deps } = depsFor([GH], fakeCacheCapture({ [GH]: missing() }));
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
    assert.equal(r.stats.gone, 1);
    assert.match(fs.readFileSync(path.join(root, '.refetch', 'gone.jsonl'), 'utf8'), /old-owner/);
    assert.deepEqual(r.renames, []);
  });

  it('a probe that cannot answer defers the capture', async () => {
    const root = tmpRoot();
    const probe = probeWith(new Error('github probe: root returned HTTP 503'));
    const { deps } = depsFor([GH], fakeCacheCapture({ [GH]: missing() }));
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
    assert.equal(r.stats.deferred, 1);
    assert.equal(r.stats.gone, 0);
    assert.equal(fs.existsSync(path.join(root, '.refetch', 'gone.jsonl')), false);
  });
});

describe('backfill: a GitHub original with an explicit default port is probed', () => {
  for (const orig of [
    'http://github.com:80/example/legacy-settings/tree/master',
    'http://github.com:80/example/legacy-templates/tree/master'
  ]) {
    it(`probes the root of ${orig}`, async () => {
      const root = tmpRoot();
      const replay = `https://web.archive.org/web/20081024183240/${orig}`;
      const { owner, repo } = githubRepo(orig);
      const fetched = [];
      const fetch = async url => {
        fetched.push(url);
        if (url === `https://github.com/${owner}/${repo}`) {
          return { status: 301, ok: false, headers: new Headers({ location: `https://github.com/new/${repo}` }) };
        }
        return { status: 200, ok: true, headers: new Headers() };
      };
      const probe = url => probeGithub(url, { fetch, sleep: async () => {} });
      const { deps } = depsFor([replay], fakeCacheCapture({ [replay]: new Error('replay returned HTTP 404 — capture missing') }));
      const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
      assert.deepEqual(fetched, [`https://github.com/${owner}/${repo}`, `https://github.com/new/${repo}/tree/master`]);
      assert.equal(r.stats.gone, 0);
      assert.deepEqual(r.renames, [{ waybackUrl: replay, from: orig, to: `https://github.com/new/${repo}/tree/master` }]);
    });
  }
});

describe('backfill: an inconclusive GitHub reply keeps the capture eligible', () => {
  const ORIG = 'https://github.com/old-owner/old-repo/issues/1';
  const GH = `https://web.archive.org/web/20160312105649/${ORIG}`;
  const ROOT = 'https://github.com/old-owner/old-repo';
  const GRAFT = 'https://github.com/new-owner/new-repo/issues/1';
  const LOGIN = 'https://elsewhere.example/login';
  const reply = (status, location) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(location ? { location } : {}) });
  const cases = [
    ['denied at the root', { [ROOT]: reply(403) }],
    ['timed out at the root', { [ROOT]: reply(408) }],
    ['denied at the graft', { [ROOT]: reply(301, 'https://github.com/new-owner/new-repo'), [GRAFT]: reply(403) }],
    ['timed out at the graft', { [ROOT]: reply(301, 'https://github.com/new-owner/new-repo'), [GRAFT]: reply(408) }],
    ['redirected off GitHub at the graft, other host answers 200', { [ROOT]: reply(301, 'https://github.com/new-owner/new-repo'), [GRAFT]: reply(302, LOGIN), [LOGIN]: reply(200) }],
    ['redirected off GitHub at the graft, other host answers 404', { [ROOT]: reply(301, 'https://github.com/new-owner/new-repo'), [GRAFT]: reply(302, LOGIN), [LOGIN]: reply(404) }]
  ];
  for (const [name, script] of cases) {
    it(`${name}: deferred, not gone, and probed again on the next run`, async () => {
      const root = tmpRoot();
      const fetched = [];
      const fetch = async url => {
        fetched.push(url);
        return script[url];
      };
      const probe = url => probeGithub(url, { fetch, sleep: async () => {} });
      const { deps } = depsFor([GH], fakeCacheCapture({ [GH]: new Error('replay returned HTTP 404 — capture missing') }));
      const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
      assert.equal(r.stats.deferred, 1);
      assert.equal(r.stats.gone, 0);
      assert.deepEqual(r.renames, []);
      assert.equal(fs.existsSync(path.join(root, '.refetch', 'gone.jsonl')), false);
      assert.equal(fs.existsSync(path.join(root, '.refetch', 'renamed.jsonl')), false);
      assert.ok(!fetched.includes(LOGIN), 'the probe never leaves github.com');
      const before = fetched.length;
      const again = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: { ...deps, probe } });
      assert.equal(again.pending, 1, 'the capture stays eligible for retry');
      assert.ok(fetched.length > before, 'the next run probes again');
    });
  }
});
