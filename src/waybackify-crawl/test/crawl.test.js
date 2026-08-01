import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dynamicEntryError } from '@charlie.dev/waybackify/cache.js';
import { RULE_VERSION } from '@charlie.dev/waybackify/rewrite.js';
import { crawl, CapReachedError } from '../src/crawl.js';
import { compilePolicy } from '../src/policy.js';
import { readJsonl, verifiedKeys } from '../src/ledger.js';

/* ------------------------------------------------------------------ *
 * Fakes — an in-memory store + a scripted probe. Zero disk (except the
 * .crawl/ ledgers, which crawl writes to a real tmp root) and zero
 * network / browser.
 * ------------------------------------------------------------------ */

const K = (n, url) => `${'20200101' + String(100000 + n).slice(-6)}/${url}`; // a valid <14-digit-ts>/<orig> key

function makeStore(seed = {}) {
  const sidecars = new Map();
  for (const [key, v] of Object.entries(seed)) sidecars.set(key, { status: v.status ?? 'body', dynamic: v.dynamic ?? [] });
  return { sidecars };
}

function keyOf(url) {
  return url.replace('https://web.archive.org/web/', '');
}

function makeDeps(store, world, counters) {
  const probe = {
    available: () => true,
    async open() {
      counters.opens++;
    },
    async render(serverUrl, docKey, corpus) {
      counters.renders++;
      const spec = world.docs[docKey] ?? {};
      const dangling = [];
      const nonLocal = [];
      // BFS the reference tree: a node reveals its children only once it is
      // SERVED (in corpus). A missing node leaks and does not expand — modeling
      // one reference-depth of discovery per fetch iteration.
      const queue = [...(spec.refs ?? [])];
      const expanded = new Set();
      while (queue.length) {
        const ref = queue.shift();
        if (ref.key && corpus.has(ref.key)) {
          if (!expanded.has(ref.key)) {
            expanded.add(ref.key);
            for (const c of spec.reveals?.[ref.key] ?? []) queue.push(c);
          }
          continue;
        }
        if (ref.kind === 'foreign') nonLocal.push({ url: `https://web.archive.org/web/${ref.key}`, resourceType: ref.resourceType });
        else dangling.push({ url: `http://local/web/${ref.key}`, resourceType: ref.resourceType });
      }
      // Persistent leaks ignore the corpus (a still-referenced but archive-absent
      // asset, or a fixed third-party escape).
      for (const p of spec.persistent ?? []) {
        if (p.escape) nonLocal.push({ url: p.escape, resourceType: p.resourceType });
        else if (p.kind === 'foreign') nonLocal.push({ url: `https://web.archive.org/web/${p.key}`, resourceType: p.resourceType });
        else dangling.push({ url: `http://local/web/${p.key}`, resourceType: p.resourceType });
      }
      if (spec.chrome) for (const u of spec.chrome) nonLocal.push({ url: u, resourceType: 'script' });
      // `observed` reflects the raw request count. A real render always issues at
      // least the top-level document request; `spec.blackout` simulates a failed
      // navigation (zero observed) for the fail-closed path.
      const observed = spec.blackout ? 0 : 1 + dangling.length + nonLocal.length;
      return { pass: dangling.length === 0 && nonLocal.length === 0, observed, dangling, nonLocal, csp: [], requests: [] };
    },
    async close() {
      counters.closes++;
    }
  };

  const cacheCapture = async (url, { onEntry = () => {} } = {}) => {
    counters.events.push('capture');
    const key = keyOf(url);
    const doc = store.sidecars.get(key);
    let fetched = 0;
    const failures = [];
    if (doc) {
      for (const d of doc.dynamic ?? []) {
        if (store.sidecars.has(d.key)) continue;
        const outcome = world.fetchOutcome?.[d.key] ?? 'body';
        if (outcome === 'fail') {
          failures.push({ key: d.key, error: 'transient' });
          onEntry({ key: d.key, action: 'failed' });
        } else {
          store.sidecars.set(d.key, { status: outcome, dynamic: [] });
          fetched++;
          onEntry({ key: d.key, action: 'fetched' });
        }
      }
    }
    return { key, hash: 'h', root: '', entries: [], fetched, skipped: 0, failures };
  };

  const recordDynamic = async (root, docKey, entries) => {
    counters.events.push('record');
    const doc = store.sidecars.get(docKey);
    if (!doc) throw new Error(`recordDynamic: no sidecar for ${docKey}`);
    const map = new Map((doc.dynamic ?? []).map(e => [e.key, e]));
    for (const e of entries) {
      const why = dynamicEntryError(e);
      if (why) throw new TypeError(`malformed dynamic entry: ${why}`);
      if (!map.has(e.key)) map.set(e.key, e);
    }
    doc.dynamic = [...map.values()];
  };

  return {
    probe,
    cacheCapture,
    recordDynamic,
    readSidecar: async (root, key) => store.sidecars.get(key) ?? null,
    loadCorpus: async () => new Set(store.sidecars.keys()),
    serve: async () => ({ url: 'http://local', close: async () => {} })
  };
}

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wbcrawl-test-'));
}

const noPolicy = compilePolicy({ escapes: [] });
function newCounters() {
  return { opens: 0, closes: 0, renders: 0, events: [] };
}

/* ------------------------------------------------------------------ */

test('converges: leaked local children are recorded then fetched, then the render is clean', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const a = K(1, 'https://ex.com/a.css');
  const b = K(2, 'https://ex.com/b.js');
  const store = makeStore({ [doc]: {} });
  const world = { docs: { [doc]: { refs: [{ key: a, kind: 'local', resourceType: 'stylesheet' }, { key: b, kind: 'local', resourceType: 'script' }] } } };
  const counters = newCounters();

  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, counters), policy: noPolicy, delayMs: 0 });

  assert.equal(results[0].status, 'verified');
  assert.equal(results[0].dynamicRecorded, 2);
  // durable: the doc sidecar now carries both dynamic children (well-formed).
  assert.equal(store.sidecars.get(doc).dynamic.length, 2);
  for (const e of store.sidecars.get(doc).dynamic) assert.equal(dynamicEntryError(e), null);
  // both children fetched into the store.
  assert.ok(store.sidecars.has(a) && store.sidecars.has(b));
  // a verified stamp landed.
  const stamps = await readJsonl(path.join(root, '.crawl', 'verified.jsonl'));
  assert.equal(stamps.at(-1).key, doc);
  assert.equal(stamps.at(-1).ruleVersion, RULE_VERSION);
  await fsp.rm(root, { recursive: true, force: true });
});

test('depth: a foreign wayback child revealed only after its parent is fetched still converges', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const css = K(1, 'https://ex.com/a.css');
  const font = K(2, 'https://ex.com/f.woff');
  const store = makeStore({ [doc]: {} });
  const world = {
    docs: {
      [doc]: {
        refs: [{ key: css, kind: 'local', resourceType: 'stylesheet' }],
        // the font is a FOREIGN wayback ref inside the css body — only visible
        // once the css is served (in corpus).
        reveals: { [css]: [{ key: font, kind: 'foreign', resourceType: 'font' }] }
      }
    }
  };
  const counters = newCounters();
  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, counters), policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'verified');
  assert.equal(results[0].iterations, 2); // depth 2 → 2 iterations
  assert.ok(store.sidecars.has(font));
  await fsp.rm(root, { recursive: true, force: true });
});

test('unconverged: a chain deeper than max-iterations is ledgered flaky, not chased', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const chain = [1, 2, 3, 4, 5].map(n => K(n, `https://ex.com/${n}.css`));
  const store = makeStore({ [doc]: {} });
  const reveals = {};
  for (let i = 0; i < chain.length - 1; i++) reveals[chain[i]] = [{ key: chain[i + 1], kind: 'local', resourceType: 'stylesheet' }];
  const world = { docs: { [doc]: { refs: [{ key: chain[0], kind: 'local', resourceType: 'stylesheet' }], reveals } } };
  const counters = newCounters();
  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, counters), policy: noPolicy, maxIterations: 2, delayMs: 0 });
  assert.equal(results[0].status, 'unconverged');
  const flaky = await readJsonl(path.join(root, '.crawl', 'flaky.jsonl'));
  assert.equal(flaky.at(-1).reason, 'unconverged');
  await fsp.rm(root, { recursive: true, force: true });
});

test('flaky no-progress: a leak whose fetch keeps failing adds zero new keys and stops', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const bad = K(1, 'https://ex.com/gone.css');
  const store = makeStore({ [doc]: {} });
  const world = {
    docs: { [doc]: { refs: [{ key: bad, kind: 'local', resourceType: 'stylesheet' }] } },
    fetchOutcome: { [bad]: 'fail' } // transient failure → never gets a sidecar
  };
  const counters = newCounters();
  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, counters), policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'flaky');
  const flaky = await readJsonl(path.join(root, '.crawl', 'flaky.jsonl'));
  assert.equal(flaky.at(-1).reason, 'no-progress');
  assert.deepEqual(flaky.at(-1).residualMissing, [bad]);
  await fsp.rm(root, { recursive: true, force: true });
});

test('terminal-sidecar exclusion: a persistent leak to an archive-absent (error) key verifies, never loops', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const gone = K(1, 'https://ex.com/gone.png');
  // gone already has a TERMINAL error sidecar (archive lacks it).
  const store = makeStore({ [doc]: {}, [gone]: { status: 'error' } });
  const world = { docs: { [doc]: { persistent: [{ key: gone, kind: 'local', resourceType: 'image' }] } } };
  const counters = newCounters();
  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, counters), policy: noPolicy, maxIterations: 4, delayMs: 0 });
  assert.equal(results[0].status, 'verified'); // excluded from the worklist, not chased
  assert.equal(results[0].iterations, 0);
  assert.equal(counters.renders, 1); // did NOT loop
  await fsp.rm(root, { recursive: true, force: true });
});

test('record-before-fetch: every refetch is preceded by a recordDynamic (crash-resume ordering)', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const a = K(1, 'https://ex.com/a.css');
  const store = makeStore({ [doc]: {} });
  const world = { docs: { [doc]: { refs: [{ key: a, kind: 'local', resourceType: 'stylesheet' }] } } };
  const counters = newCounters();
  await crawl([doc], { root, deps: makeDeps(store, world, counters), policy: noPolicy, delayMs: 0 });
  // events: initial capture, then for the one worklist iteration: record, capture.
  assert.deepEqual(counters.events, ['capture', 'record', 'capture']);
  // no 'capture' after a worklist is emitted without a preceding 'record'.
  for (let i = 1; i < counters.events.length; i++) {
    if (counters.events[i] === 'capture' && i > 0) {
      // the initial capture is index 0; any later capture must follow a record.
      assert.equal(counters.events[i - 1], 'record');
    }
  }
  await fsp.rm(root, { recursive: true, force: true });
});

test('verified fast-path: a stamped doc is skipped (no probe) unless --force', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const a = K(1, 'https://ex.com/a.css');
  const store = makeStore({ [doc]: {} });
  const world = { docs: { [doc]: { refs: [{ key: a, kind: 'local', resourceType: 'stylesheet' }] } } };

  // Pre-seed a valid verified stamp.
  await fsp.mkdir(path.join(root, '.crawl'), { recursive: true });
  await fsp.writeFile(path.join(root, '.crawl', 'verified.jsonl'), JSON.stringify({ key: doc, ruleVersion: RULE_VERSION }) + '\n');

  const c1 = newCounters();
  const r1 = await crawl([doc], { root, deps: makeDeps(store, world, c1), policy: noPolicy, delayMs: 0 });
  assert.equal(r1.results[0].status, 'verified-cached');
  assert.equal(c1.renders, 0); // no probe

  const c2 = newCounters();
  const r2 = await crawl([doc], { root, deps: makeDeps(store, world, c2), policy: noPolicy, delayMs: 0, force: true });
  assert.equal(r2.results[0].status, 'verified');
  assert.ok(c2.renders >= 1); // --force re-probes
  await fsp.rm(root, { recursive: true, force: true });
});

test('allowed escape is reported, non-failing; an UNMATCHED escape is flaky', async () => {
  const root = await tmpRoot();
  const docA = K(0, 'https://ex.com/a');
  const docB = K(3, 'https://ex.com/b');
  const store = makeStore({ [docA]: {}, [docB]: {} });
  const world = {
    docs: {
      [docA]: { persistent: [{ escape: 'https://www.google-analytics.com/ga.js', resourceType: 'script' }] },
      [docB]: { persistent: [{ escape: 'https://tracker.evil.com/beacon.gif', resourceType: 'image' }] }
    }
  };
  const policy = compilePolicy({ escapes: [{ host: 'google-analytics.com', reason: 'analytics' }] });

  const rA = await crawl([docA], { root, deps: makeDeps(store, world, newCounters()), policy, delayMs: 0 });
  assert.equal(rA.results[0].status, 'verified');
  assert.equal(rA.results[0].allowedEscapes, 1);

  const rB = await crawl([docB], { root, deps: makeDeps(store, world, newCounters()), policy, delayMs: 0 });
  assert.equal(rB.results[0].status, 'flaky');
  const flaky = await readJsonl(path.join(root, '.crawl', 'flaky.jsonl'));
  assert.equal(flaky.at(-1).reason, 'unmatched-escapes');
  await fsp.rm(root, { recursive: true, force: true });
});

test('F1 disappearing failed key: a recorded-but-unfetched child blocks verification even when the browser stops requesting it', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const bad = K(1, 'https://ex.com/beacon.gif');
  const store = makeStore({ [doc]: {} });
  const deps = makeDeps(store, { docs: { [doc]: {} }, fetchOutcome: { [bad]: 'fail' } }, newCounters());
  let renders = 0;
  deps.probe = {
    available: () => true,
    async open() {},
    async close() {},
    async render() {
      renders++;
      // render 1 leaks `bad` (recorded, then its fetch fails); render 2 the
      // browser no longer asks for it (nondeterministic JS) — but `bad` is still
      // a recorded-but-unfetched child, so the doc is NOT complete.
      if (renders === 1) return { pass: false, observed: 2, dangling: [{ url: `http://l/web/${bad}`, resourceType: 'image' }], nonLocal: [], csp: [], requests: [] };
      return { pass: true, observed: 1, dangling: [], nonLocal: [], csp: [], requests: [] };
    }
  };
  const { results } = await crawl([doc], { root, deps, policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'flaky'); // NOT verified
  const flaky = await readJsonl(path.join(root, '.crawl', 'flaky.jsonl'));
  assert.equal(flaky.at(-1).reason, 'no-progress');
  assert.deepEqual(flaky.at(-1).residualMissing, [bad]);
  await fsp.rm(root, { recursive: true, force: true });
});

test('F1b recorded tracking beacon (unfetchable, no sidecar) is filtered from the frontier → doc VERIFIES; a recorded content key still blocks', async () => {
  const doc = K(0, 'https://ex.com/');
  // A prior run recorded a GA `__utm.gif` pixel whose per-render-random query
  // means no capture exists → it never gets a sidecar (unfetchable by
  // construction). A recorded CONTENT css with no sidecar is the control.
  const beacon = '20080925091045/http://www.google-analytics.com/__utm.gif?utmn=1734829201&utmhid=482910473';
  const content = '20080925091045/https://ex.com/missing.css';

  // Beacon-only sidecar: the render is now CLEAN (browser stopped asking). With
  // the seed-filter the beacon leaves recordedKeys → not unresolved → VERIFIES.
  const rootB = await tmpRoot();
  const storeB = makeStore({ [doc]: { dynamic: [{ key: beacon, flag: 'im_', via: 'remaster-verify' }] } });
  const worldB = { docs: { [doc]: {} }, fetchOutcome: { [beacon]: 'fail' } }; // never archivable → no sidecar
  const rB = await crawl([doc], { root: rootB, deps: makeDeps(storeB, worldB, newCounters()), policy: noPolicy, delayMs: 0 });
  assert.equal(rB.results[0].status, 'verified'); // reverting the seed-filter makes this 'flaky' (no-progress on the beacon)
  await fsp.rm(rootB, { recursive: true, force: true });

  // Control: a recorded CONTENT key with no sidecar is NOT a beacon, so it stays
  // in recordedKeys → unresolved → still correctly blocks (flaky, no-progress).
  const rootC = await tmpRoot();
  const storeC = makeStore({ [doc]: { dynamic: [{ key: content, flag: 'cs_', via: 'remaster-verify' }] } });
  const worldC = { docs: { [doc]: {} }, fetchOutcome: { [content]: 'fail' } };
  const rC = await crawl([doc], { root: rootC, deps: makeDeps(storeC, worldC, newCounters()), policy: noPolicy, delayMs: 0 });
  assert.equal(rC.results[0].status, 'flaky');
  const flakyC = await readJsonl(path.join(rootC, '.crawl', 'flaky.jsonl'));
  assert.equal(flakyC.at(-1).reason, 'no-progress');
  assert.deepEqual(flakyC.at(-1).residualMissing, [content]);
  await fsp.rm(rootC, { recursive: true, force: true });
});

test('F2 no-evidence render (zero observed requests) fails closed as probe-error, never verified', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const store = makeStore({ [doc]: {} });
  const world = { docs: { [doc]: { blackout: true } } };
  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, newCounters()), policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'probe-error');
  await fsp.rm(root, { recursive: true, force: true });
});

test('F3 a lone non-/web archive.org chrome request fails closed (unexpected-archive-request), never verified', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const store = makeStore({ [doc]: {} });
  const world = { docs: { [doc]: { chrome: ['https://web.archive.org/_static/js/bundle.js'] } } };
  const { results } = await crawl([doc], { root, deps: makeDeps(store, world, newCounters()), policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'flaky');
  const flaky = await readJsonl(path.join(root, '.crawl', 'flaky.jsonl'));
  assert.equal(flaky.at(-1).reason, 'unexpected-archive-request');
  await fsp.rm(root, { recursive: true, force: true });
});

test('F4 a CSP-violation residual blocks verification (csp-residual flaky); flipping csp to [] verifies', async () => {
  const doc = K(0, 'https://ex.com/');
  // A page whose archived <meta CSP> refused a foreign Wayback asset: the browser
  // never issued the request, so the request log is empty (dangling/nonLocal []),
  // and the ONLY evidence is a CSP violation string. csp MUST be the deciding
  // factor — non-empty blocks verification, empty verifies.
  const probeWithCsp = csp => ({
    available: () => true,
    async open() {},
    async close() {},
    async render() {
      return { pass: csp.length === 0, observed: 1, dangling: [], nonLocal: [], csp, requests: [{ url: 'http://local/web/' + doc, origin: 'local', corpus: 'hit' }] };
    }
  });

  // 1) csp non-empty → NOT verified, ledgered flaky with reason csp-residual.
  const root1 = await tmpRoot();
  const store1 = makeStore({ [doc]: {} });
  const deps1 = makeDeps(store1, { docs: { [doc]: {} } }, newCounters());
  deps1.probe = probeWithCsp(["Refused to load 'https://web.archive.org/web/x.css' because it violates the Content Security Policy"]);
  const r1 = await crawl([doc], { root: root1, deps: deps1, policy: noPolicy, delayMs: 0 });
  assert.equal(r1.results[0].status, 'flaky'); // reverting the csp fix makes this 'verified' → test fails
  const flaky = await readJsonl(path.join(root1, '.crawl', 'flaky.jsonl'));
  assert.equal(flaky.at(-1).reason, 'csp-residual');
  assert.equal((await verifiedKeys(root1, RULE_VERSION)).has(doc), false);
  await fsp.rm(root1, { recursive: true, force: true });

  // 2) all else equal but csp === [] → DOES verify (proves csp is the deciding factor).
  const root2 = await tmpRoot();
  const store2 = makeStore({ [doc]: {} });
  const deps2 = makeDeps(store2, { docs: { [doc]: {} } }, newCounters());
  deps2.probe = probeWithCsp([]);
  const r2 = await crawl([doc], { root: root2, deps: deps2, policy: noPolicy, delayMs: 0 });
  assert.equal(r2.results[0].status, 'verified');
  await fsp.rm(root2, { recursive: true, force: true });
});

test('F5 a --force re-probe that does not re-verify invalidates the stale stamp (tombstone)', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const bad = K(1, 'https://ex.com/x.css');
  await fsp.mkdir(path.join(root, '.crawl'), { recursive: true });
  await fsp.writeFile(path.join(root, '.crawl', 'verified.jsonl'), JSON.stringify({ key: doc, ruleVersion: RULE_VERSION }) + '\n');
  const store = makeStore({ [doc]: {} });
  const world = { docs: { [doc]: { refs: [{ key: bad, kind: 'local', resourceType: 'stylesheet' }] } }, fetchOutcome: { [bad]: 'fail' } };
  const r = await crawl([doc], { root, deps: makeDeps(store, world, newCounters()), policy: noPolicy, delayMs: 0, force: true });
  assert.equal(r.results[0].status, 'flaky');
  // the stale verified claim is gone (tombstone is the latest row).
  assert.equal((await verifiedKeys(root, RULE_VERSION)).has(doc), false);
  // a subsequent non-force run therefore re-probes rather than trusting the stamp.
  const r2 = await crawl([doc], { root, deps: makeDeps(store, world, newCounters()), policy: noPolicy, delayMs: 0 });
  assert.notEqual(r2.results[0].status, 'verified-cached');
  await fsp.rm(root, { recursive: true, force: true });
});

test('F6 maxIterations must be a finite non-negative integer (Infinity/negative rejected)', async () => {
  const root = await tmpRoot();
  const deps = makeDeps(makeStore(), { docs: {} }, newCounters());
  await assert.rejects(() => crawl(['20200101000000/https://ex.com/'], { root, maxIterations: Infinity, deps }), /non-negative integer/);
  await assert.rejects(() => crawl(['20200101000000/https://ex.com/'], { root, maxIterations: -1, deps }), /non-negative integer/);
  await assert.rejects(() => crawl(['20200101000000/https://ex.com/'], { root, maxRequests: 3.5, deps }), /non-negative integer/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('archive.org cap: a CapReachedError from a capture marks the doc cap-skipped (never verified/error)', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const store = makeStore({ [doc]: {} });
  const deps = makeDeps(store, { docs: { [doc]: {} } }, newCounters());
  // The real counting-fetch throws CapReachedError at the seam once the cap is
  // hit (bounding overshoot to zero — the request is never issued). Simulate
  // that surfacing out of a capture and assert crawl classifies it cleanly.
  deps.cacheCapture = async () => {
    throw new CapReachedError(300, 300);
  };
  const { results } = await crawl([doc], { root, deps, policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'cap-skipped');
  await fsp.rm(root, { recursive: true, force: true });
});

test('static-only: closes recorded dynamic frontier without a probe (no render, warns via caller)', async () => {
  const root = await tmpRoot();
  const doc = K(0, 'https://ex.com/');
  const a = K(1, 'https://ex.com/a.css');
  const store = makeStore({ [doc]: { dynamic: [{ key: a, flag: 'cs_', via: 'remaster-verify' }] } });
  const world = { docs: {} };
  const counters = newCounters();
  const { results } = await crawl([doc], { root, staticOnly: true, deps: makeDeps(store, world, counters), policy: noPolicy, delayMs: 0 });
  assert.equal(results[0].status, 'static');
  assert.equal(counters.renders, 0);
  assert.ok(store.sidecars.has(a)); // the recorded dynamic child was fetched
  await fsp.rm(root, { recursive: true, force: true });
});
