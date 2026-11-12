// node --test — the parts of the backfill engine a multi-day mirror leans on:
// the worklist's ledger stamp, the throttle stop and its cursor, the request
// and requisite knobs, and the converge loop. Injected deps throughout (no
// network, no real cacheCapture), as in backfill.test.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfill, converge, ledgerFingerprint } from '../backfill.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-converge-'));
const wb = n => `https://web.archive.org/web/2002010100000${n}/http://example.org/${n}`;
const THROTTLE = new Error('cacheCapture: replay returned HTTP 429 (transient archive.org trouble? retry)');

/** A ledger of one capture list, as discover() returns it. */
const ledger = urls => [{ file: 'site/captures.jsonl', manifest: { entries: {} }, captures: urls.map(wayback => ({ wayback })) }];

/** Deps over a mutable ledger: `against` marks everything unfetched. */
function depsFor(state, cacheCapture) {
  let againstCalls = 0;
  return {
    deps: {
      discover: () => state.ledger,
      against: async discovered => {
        againstCalls++;
        const urls = discovered.flatMap(d => d.captures.map(c => c.wayback));
        return { unfetched: urls.map(u => ({ key: u, waybackUrl: u })), cached: [], interstitial: [], error: [] };
      },
      cacheCapture,
      sleep: async () => {},
      wayback: {}
    },
    againstCalls: () => againstCalls
  };
}

/** A scripted cacheCapture: url → Error (thrown) | summary fields; default = fetched. */
function scripted(script = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push(url);
    fn.options = options;
    const v = typeof script === 'function' ? script(url, calls.length) : script[url];
    if (v instanceof Error) throw v;
    return { key: url, entries: [], fetched: 1, skipped: 0, failures: [], ...(v ?? {}) };
  };
  fn.calls = calls;
  return fn;
}

describe('backfill — the worklist is bound to the ledger that built it', () => {
  it('rebuilds when the ledger changes, and says why', async () => {
    const root = tmpRoot();
    const state = { ledger: ledger([wb(1), wb(2)]) };
    const { deps, againstCalls } = depsFor(state, scripted());
    const first = await backfill({ ledgerDir: 'l', root, delayMs: 0, deps });
    assert.deepEqual([first.worklist.built, first.worklist.reason, first.worklist.count], [true, 'absent', 2]);

    const same = await backfill({ ledgerDir: 'l', root, delayMs: 0, deps });
    assert.deepEqual([same.worklist.built, same.worklist.reason], [false, null]);
    assert.equal(againstCalls(), 1, 'an unchanged ledger reuses the worklist');

    // The enumerator added a capture. No --refresh: the new one must not be skipped.
    state.ledger = ledger([wb(1), wb(2), wb(3)]);
    const changed = await backfill({ ledgerDir: 'l', root, delayMs: 0, deps });
    assert.deepEqual([changed.worklist.built, changed.worklist.reason, changed.worklist.count], [true, 'ledger-changed', 3]);
  });

  it('rebuilds a worklist that carries no stamp (it cannot say which ledger it answers)', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.refetch'));
    fs.writeFileSync(path.join(root, '.refetch', 'worklist.jsonl'), `${JSON.stringify({ waybackUrl: wb(9) })}\n`);
    const cc = scripted();
    const { deps } = depsFor({ ledger: ledger([wb(1)]) }, cc);
    const r = await backfill({ ledgerDir: 'l', root, delayMs: 0, deps });
    assert.equal(r.worklist.reason, 'unstamped');
    assert.deepEqual(cc.calls, [wb(1)]);
    const stamp = JSON.parse(fs.readFileSync(path.join(root, '.refetch', 'worklist.ledger.json'), 'utf8'));
    assert.equal(stamp.fingerprint, ledgerFingerprint(ledger([wb(1)])));
  });

  it('the fingerprint sees a changed rank and a changed replay flag', () => {
    const base = ledgerFingerprint(ledger([wb(1)]));
    assert.equal(ledgerFingerprint(ledger([wb(1)])), base);
    assert.notEqual(ledgerFingerprint([{ file: 'f', manifest: { entries: {} }, captures: [{ wayback: wb(1), rank: 1 }] }]), base);
    assert.notEqual(ledgerFingerprint(ledger([wb(1).replace('/http', 'id_/http')])), base);
  });
});

describe('backfill — a throttle stops the run instead of deferring through it', () => {
  it('stops after throttleAfter consecutive captures that defer with nothing fetched', async () => {
    const root = tmpRoot();
    const urls = [1, 2, 3, 4, 5, 6, 7, 8].map(wb);
    const cc = scripted(Object.fromEntries(urls.map(u => [u, THROTTLE])));
    const { deps } = depsFor({ ledger: ledger(urls) }, cc);
    const events = [];
    const r = await backfill({ ledgerDir: 'l', root, delayMs: 0, throttleAfter: 3, deps, onProgress: ev => events.push(ev) });
    assert.equal(r.aborted, true);
    assert.equal(r.reason, 'throttled');
    assert.equal(cc.calls.length, 3, 'three requests, not eight');
    assert.deepEqual(events.find(e => e.type === 'abort'), { type: 'abort', reason: 'throttled', streak: 3, pending: 5 });
  });

  it('a capture that stores anything resets the streak; requisite-only failures with no bytes count', async () => {
    const root = tmpRoot();
    const urls = [1, 2, 3, 4, 5].map(wb);
    const partial = { fetched: 2, failures: [{ key: 'k', error: 'replay returned HTTP 503' }] };
    const empty = { fetched: 0, failures: [{ key: 'k', error: 'replay returned HTTP 503' }] };
    const cc = scripted({ [wb(1)]: THROTTLE, [wb(2)]: partial, [wb(3)]: empty, [wb(4)]: THROTTLE, [wb(5)]: THROTTLE });
    const { deps } = depsFor({ ledger: ledger(urls) }, cc);
    const r = await backfill({ ledgerDir: 'l', root, delayMs: 0, throttleAfter: 3, deps });
    assert.equal(r.reason, 'throttled');
    assert.equal(cc.calls.length, 5, '#2 stored bytes and reset the streak; #3–#5 are the three that stopped it');
  });

  it('throttleAfter 0 never stops; an outage still reports `unreachable`', async () => {
    const root = tmpRoot();
    const urls = [1, 2, 3, 4].map(wb);
    const all = scripted(Object.fromEntries(urls.map(u => [u, THROTTLE])));
    const r = await backfill({ ledgerDir: 'l', root, delayMs: 0, throttleAfter: 0, deps: depsFor({ ledger: ledger(urls) }, all).deps });
    assert.equal(r.aborted, false);
    assert.equal(r.stats.deferred, 4);

    const down = scripted(Object.fromEntries(urls.map(u => [u, new Error('connect ECONNREFUSED')])));
    const o = await backfill({ ledgerDir: 'l', root: tmpRoot(), delayMs: 0, abortAfter: 2, deps: depsFor({ ledger: ledger(urls) }, down).deps });
    assert.deepEqual([o.aborted, o.reason], [true, 'unreachable']);
  });

  it('the next run starts AFTER the streak that stopped the last one, and wraps around', async () => {
    const root = tmpRoot();
    const urls = [1, 2, 3, 4, 5].map(wb);
    // #1 and #2 always throttle; the rest are fine.
    const script = { [wb(1)]: THROTTLE, [wb(2)]: THROTTLE };
    const state = { ledger: ledger(urls) };
    const first = scripted(script);
    await backfill({ ledgerDir: 'l', root, delayMs: 0, throttleAfter: 2, deps: depsFor(state, first).deps });
    assert.deepEqual(first.calls, [wb(1), wb(2)]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.refetch', 'cursor.json'), 'utf8')), { after: wb(2), reason: 'throttled' });

    const second = scripted(script);
    const r = await backfill({ ledgerDir: 'l', root, delayMs: 0, throttleAfter: 2, deps: depsFor(state, second).deps });
    assert.deepEqual(second.calls, [wb(3), wb(4), wb(5), wb(1), wb(2)], 'two bad captures cannot pin every run to the top of the list');
    assert.equal(r.stats.fetched, 3);
    assert.equal(r.reason, 'throttled', 'the same two stop it again — at the END of the list this time');
  });

  it('a run that walks the whole list clears the cursor', async () => {
    const root = tmpRoot();
    const state = { ledger: ledger([1, 2, 3].map(wb)) };
    await backfill({ ledgerDir: 'l', root, delayMs: 0, throttleAfter: 1, deps: depsFor(state, scripted({ [wb(1)]: THROTTLE })).deps });
    assert.ok(fs.existsSync(path.join(root, '.refetch', 'cursor.json')));
    await backfill({ ledgerDir: 'l', root, delayMs: 0, deps: depsFor(state, scripted()).deps });
    assert.ok(!fs.existsSync(path.join(root, '.refetch', 'cursor.json')));
  });
});

describe('backfill — pagesOnly sends only what a browser would', () => {
  it('attempts the pages, holds the content, and leaves the worklist whole', async () => {
    const root = tmpRoot();
    const raw = n => `https://web.archive.org/web/2002010100000${n}id_/http://example.org/${n}.gif`;
    const state = { ledger: ledger([raw(1), wb(2), raw(3), wb(4)]) };
    const capture = scripted();
    const events = [];
    const first = await backfill({ ledgerDir: 'l', root, delayMs: 0, pagesOnly: true, onProgress: ev => events.push(ev), deps: depsFor(state, capture).deps });
    assert.deepEqual(capture.calls, [wb(2), wb(4)], 'no flagged URL is requested');
    assert.equal(first.worklist.count, 4, 'the worklist still names all four');
    assert.equal(events.find(e => e.type === 'plan').held, 2);

    const all = scripted();
    await backfill({ ledgerDir: 'l', root, delayMs: 0, deps: depsFor(state, all).deps });
    assert.deepEqual(all.calls, [wb(2), wb(4), raw(1), raw(3)], 'a full run walks pages first, then content');
  });
});

describe('backfill — request knobs reach cacheCapture', () => {
  it('requisites: false and requestDelayMs pass through', async () => {
    const cc = scripted();
    const { deps } = depsFor({ ledger: ledger([wb(1)]) }, cc);
    await backfill({ ledgerDir: 'l', root: tmpRoot(), delayMs: 0, requisites: false, requestDelayMs: 250, deps });
    assert.equal(cc.options.requisites, false);
    assert.equal(cc.options.requestDelayMs, 250);
    const dflt = scripted();
    await backfill({ ledgerDir: 'l', root: tmpRoot(), delayMs: 0, deps: depsFor({ ledger: ledger([wb(1)]) }, dflt).deps });
    assert.equal(dflt.options.requisites, true);
    assert.equal(dflt.options.requestDelayMs, 0);
  });
});

describe('converge — passes until nothing fetches or defers', () => {
  const pass = (stats, extra = {}) => ({ worklist: {}, pending: 0, gone: 0, aborted: false, reason: null, dryRun: false, renames: [], stats: { attempted: 0, fetched: 0, deferred: 0, gone: 0, cached: 0, ...stats }, ...extra });
  const loop = (passes, extra = {}) => {
    const sleeps = [];
    const calls = [];
    const events = [];
    const promise = converge({
      ledgerDir: 'l', root: 'r', backoffMs: 100, backoffMaxMs: 350, restMs: 5, ...extra,
      onProgress: ev => events.push(ev),
      deps: { backfill: async opts => { calls.push(opts); return passes[calls.length - 1]; }, sleep: async ms => { sleeps.push(ms); } }
    });
    return { promise, sleeps, calls, events };
  };

  it('runs until a pass has nothing left to attempt', async () => {
    const { promise, sleeps, calls } = loop([pass({ attempted: 3, fetched: 3 }), pass({ attempted: 1, fetched: 1 }), pass({})], { refresh: true });
    const r = await promise;
    assert.deepEqual([r.converged, r.stalled, r.passes], [true, false, 3]);
    assert.deepEqual(r.totals, { attempted: 4, fetched: 4, deferred: 0, gone: 0 });
    assert.deepEqual(sleeps, [5, 5], 'a productive pass rests, it does not back off');
    assert.deepEqual(calls.map(c => c.refresh), [true, false, false], 'only the first pass honors refresh');
  });

  it('a pass that only records gone captures is convergence', async () => {
    const r = await loop([pass({ attempted: 2, gone: 2 })]).promise;
    assert.deepEqual([r.converged, r.passes, r.totals.gone], [true, 1, 2]);
  });

  it('backs off after a stop, doubling to the ceiling, and resets after progress', async () => {
    const stopped = pass({ attempted: 6, deferred: 6 }, { aborted: true, reason: 'throttled' });
    const { promise, sleeps, events } = loop([stopped, stopped, stopped, pass({ attempted: 4, fetched: 4 }), stopped, pass({})]);
    const r = await promise;
    assert.equal(r.converged, true);
    assert.deepEqual(sleeps, [100, 200, 350, 5, 100]);
    assert.deepEqual(events.filter(e => e.type === 'backoff').map(e => e.reason), ['throttled', 'throttled', 'throttled', 'throttled']);
  });

  it('gives up after maxStall passes that fetch nothing: what still defers is not transient', async () => {
    const stuck = pass({ attempted: 2, deferred: 2 });
    const { promise, calls } = loop([stuck, stuck, stuck, stuck], { maxStall: 3 });
    const r = await promise;
    assert.deepEqual([r.converged, r.stalled, r.passes], [false, true, 3]);
    assert.equal(r.totals.deferred, 2, 'deferred is what the last pass left, not a sum');
    assert.equal(calls.length, 3);
  });

  it('a throttle that outlasts maxStall backoffs ends the loop; an outage is waited out', async () => {
    const blocked = pass({ attempted: 6, deferred: 6 }, { aborted: true, reason: 'throttled' });
    const { promise, calls, sleeps } = loop([blocked, blocked, blocked, blocked], { maxStall: 3 });
    const r = await promise;
    assert.deepEqual([r.converged, r.stalled, r.passes], [false, true, 3]);
    assert.equal(calls.length, 3, 'a persistent block is not retried forever');
    assert.deepEqual(sleeps, [100, 200]);

    const down = pass({ attempted: 5, deferred: 5 }, { aborted: true, reason: 'unreachable' });
    const waited = await loop([down, down, down, down, pass({ attempted: 2, fetched: 2 }), pass({})], { maxStall: 3 }).promise;
    assert.deepEqual([waited.converged, waited.stalled, waited.passes], [true, false, 6]);
  });

  it('maxPasses bounds the loop', async () => {
    const r = await loop([pass({ attempted: 1, fetched: 1 }), pass({ attempted: 1, fetched: 1 })], { maxPasses: 2 }).promise;
    assert.deepEqual([r.converged, r.passes], [false, 2]);
  });
});
