// Dynamic-sidecar (schema v3) tests — offline, tmpdir roots, mocked fetch.
//
// The `dynamic[]` array is the durable half of the crawl fixpoint: a browser
// probe finds a runtime-discovered requisite, `recordDynamic` writes it onto
// the doc's existing sidecar, and the next `cacheCapture` closes over it via
// the `requisites ∪ dynamic` frontier. These tests pin: recordDynamic's
// merge/sort/idempotence + meta-only re-write, the frontier fetch from the
// STORED flag, fsck's union closure + entry-level malformed detection, the
// remaster carry-through, and that a plain (v1/v2) capture never invents a
// `dynamic` field. Zero network — same mock-archive idiom as cache.test.js.
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheCapture, canonicalJSON, commitEntry, dynamicEntryError, entryPaths, readSidecar, recordDynamic } from '../cache.js';
import { fsck, totalFindings, CATEGORIES } from '../fsck.js';
import { remaster } from '../remaster.js';

const TS = '20160312105649';
const DOC_ORIGINAL = 'http://example.com/dynamic-doc';
const DOC_URL = `https://web.archive.org/web/${TS}/${DOC_ORIGINAL}`;
const DOC_KEY = `${TS}/${DOC_ORIGINAL}`;
// A minimal HTML body with NO statically-flagged wayback refs — so the fetch
// frontier is exactly the recorded dynamic children, nothing extracted.
const DOC_HTML = '<!doctype html><html><body><p>hello</p></body></html>';

// A browser-discovered font: never appears in DOC_HTML, so its `oe_` flag is
// only knowable from the recorded dynamic entry.
const FONT_ORIGINAL = 'https://github.githubassets.com/fonts/x.woff';
const FONT_KEY = `${TS}/${FONT_ORIGINAL}`;
const FONT_FLAG = 'oe_';
const FONT_URL = `https://web.archive.org/web/${TS}${FONT_FLAG}/${FONT_ORIGINAL}`;
const FONT_BYTES = 'wOFF fake-font-bytes';

const mkroot = () => fsp.mkdtemp(path.join(os.tmpdir(), 'waybackify-dynamic-'));
const bytesOf = s => new TextEncoder().encode(s);

/** Tiny canned archive: url → {status, contentType, body}. Records calls. */
function mockArchive(routes = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`mock archive: unrouted ${url}`);
    const bytes = typeof route.body === 'string' ? bytesOf(route.body) : (route.body ?? new Uint8Array(0));
    return {
      status: route.status ?? 200,
      headers: { get: h => (h === 'content-type' ? (route.contentType ?? null) : null) },
      arrayBuffer: async () => bytes.slice().buffer
    };
  };
  return { fetchImpl, calls };
}

// Pinned so two independently-built roots produce byte-identical doc sidecars
// (the determinism test compares meta bytes ACROSS roots — `fetchedAt` would
// otherwise diverge with wall-clock).
const FETCHED_AT = '2026-07-29T00:00:00.000Z';

/** Commit the document entry (body, no static requisites) directly. */
async function commitDoc(root) {
  return commitEntry(root, {
    key: DOC_KEY,
    status: 'body',
    contentType: 'text/html; charset=utf-8',
    fetchedAt: FETCHED_AT,
    body: bytesOf(DOC_HTML)
  });
}

/** Raw meta bytes for a key (to prove byte-level idempotence/determinism). */
async function metaBytes(root, key) {
  const { meta } = await entryPaths(root, key);
  return fsp.readFile(meta);
}

const entry = (key, flag = FONT_FLAG, extra = {}) => ({ key, flag, via: 'remaster-verify', ...extra });

describe('recordDynamic — merge, sort, idempotence', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
    await commitDoc(root);
  });

  it('bumps v to 3, sorts dynamic by key, leaves body/contentHash/contentLength untouched', async () => {
    const before = await readSidecar(root, DOC_KEY);
    const bodyBefore = await fsp.readFile((await entryPaths(root, DOC_KEY)).body);

    const a = `${TS}/http://example.com/z-last.woff`;
    const b = `${TS}/http://example.com/a-first.woff`;
    const written = await recordDynamic(root, DOC_KEY, [entry(a, 'oe_'), entry(b, 'im_')]);

    assert.equal(written.v, 3);
    assert.deepEqual(written.dynamic.map(d => d.key), [b, a], 'sorted by key ascending');
    // body + integrity fields carry over verbatim
    assert.equal(written.status, 'body');
    assert.equal(written.contentHash, before.contentHash);
    assert.equal(written.contentLength, before.contentLength);
    const bodyAfter = await fsp.readFile((await entryPaths(root, DOC_KEY)).body);
    assert.deepEqual(new Uint8Array(bodyAfter), new Uint8Array(bodyBefore), 'body bytes untouched');

    const read = await readSidecar(root, DOC_KEY);
    assert.equal(read.v, 3);
    assert.deepEqual(read.dynamic.map(d => d.key), [b, a]);
  });

  it('is idempotent: recording the same entries twice yields byte-identical meta', async () => {
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY), entry(`${TS}/http://example.com/two.js`, 'js_')]);
    const first = await metaBytes(root, DOC_KEY);
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY), entry(`${TS}/http://example.com/two.js`, 'js_')]);
    const second = await metaBytes(root, DOC_KEY);
    assert.deepEqual(new Uint8Array(second), new Uint8Array(first));
  });

  it('is order-independent: permuted input yields byte-identical meta (determinism)', async () => {
    const e1 = entry(`${TS}/http://example.com/1.css`, 'cs_');
    const e2 = entry(`${TS}/http://example.com/2.js`, 'js_');
    const e3 = entry(`${TS}/http://example.com/3.png`, 'im_');

    await recordDynamic(root, DOC_KEY, [e1, e2, e3]);
    const forward = await metaBytes(root, DOC_KEY);

    const root2 = await mkroot();
    await commitDoc(root2);
    await recordDynamic(root2, DOC_KEY, [e3, e1, e2]);
    const permuted = await metaBytes(root2, DOC_KEY);

    assert.deepEqual(new Uint8Array(permuted), new Uint8Array(forward));
  });

  it('merges onto existing dynamic with EXISTING-WINS dedupe by key', async () => {
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY, 'oe_', { via: 'remaster-verify', firstSeen: '2026-01-01T00:00:00.000Z' })]);
    // A re-probe of the same key with different provenance must NOT overwrite.
    const merged = await recordDynamic(root, DOC_KEY, [
      entry(FONT_KEY, 'im_', { via: 'manual', firstSeen: '2099-12-31T00:00:00.000Z' }),
      entry(`${TS}/http://example.com/new.js`, 'js_')
    ]);
    assert.equal(merged.dynamic.length, 2);
    const font = merged.dynamic.find(d => d.key === FONT_KEY);
    assert.equal(font.flag, 'oe_', 'first-seen entry wins');
    assert.equal(font.via, 'remaster-verify');
    assert.equal(font.firstSeen, '2026-01-01T00:00:00.000Z');
  });

  it('never invents an empty dynamic field (recording [] on a doc with none)', async () => {
    const written = await recordDynamic(root, DOC_KEY, []);
    assert.equal(written.v, 3);
    assert.ok(!('dynamic' in written), 'no dynamic key');
    const raw = await metaBytes(root, DOC_KEY);
    assert.doesNotMatch(raw.toString('utf8'), /"dynamic"/);
  });

  it('throws when the document has no sidecar', async () => {
    await assert.rejects(
      recordDynamic(root, `${TS}/http://example.com/never-captured`, [entry(FONT_KEY)]),
      /no sidecar/
    );
  });

  it('throws TypeError on ANY malformed entry — the same predicate fsck flags', async () => {
    // non-object, missing key, bad separator, bad flag, bad via → all rejected loud.
    await assert.rejects(recordDynamic(root, DOC_KEY, [null]), TypeError);
    await assert.rejects(recordDynamic(root, DOC_KEY, ['not-an-object']), TypeError);
    await assert.rejects(recordDynamic(root, DOC_KEY, [{ flag: 'oe_', via: 'manual' }]), TypeError);
    await assert.rejects(recordDynamic(root, DOC_KEY, [{ key: 'no-separator', flag: 'im_', via: 'manual' }]), TypeError);
    await assert.rejects(recordDynamic(root, DOC_KEY, [{ key: `${TS}/x`, flag: 'BOGUS', via: 'manual' }]), TypeError);
    await assert.rejects(recordDynamic(root, DOC_KEY, [{ key: `${TS}/x`, flag: 'oe_', via: 'har' }]), TypeError);
    // Writer/verifier parity: the writer throws on exactly what the predicate flags.
    assert.equal(dynamicEntryError({ key: `${TS}/x`, flag: 'oe_', via: 'remaster-verify' }), null, 'a well-formed entry passes');
    assert.ok(dynamicEntryError({ key: `${TS}/x`, flag: 'BOGUS', via: 'manual' }), 'a bad flag is flagged');
    assert.ok(dynamicEntryError({ key: `${TS}/x`, flag: 'oe_', via: 'har' }), 'a bad via is flagged');
    assert.ok(dynamicEntryError({ key: `${TS}/x`, flag: 'oe_' }), 'a missing via is flagged');
  });

  it('collapses a byte-identical dup, throws only on a CONFLICTING dup, within one call (M1/N1)', async () => {
    // Benign: a browser fetching one asset twice → identical entries → ONE, no throw.
    const merged = await recordDynamic(root, DOC_KEY, [entry(FONT_KEY, 'oe_'), entry(FONT_KEY, 'oe_')]);
    assert.equal(merged.dynamic.length, 1, 'byte-identical repeat collapses to one');
    assert.equal(merged.dynamic[0].key, FONT_KEY);

    // Conflicting: same key, differing flag → genuine ambiguity → throw.
    const root2 = await mkroot();
    await commitDoc(root2);
    await assert.rejects(
      recordDynamic(root2, DOC_KEY, [entry(FONT_KEY, 'im_'), entry(FONT_KEY, 'oe_')]),
      /conflicting duplicate key/
    );
  });

  it('throws (never launders) a malformed EXISTING dynamic array (M4)', async () => {
    const { meta } = await entryPaths(root, DOC_KEY);
    // Existing dynamic is not an array → throw, do not drop-and-overwrite.
    let sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    sidecar.v = 3;
    sidecar.dynamic = { not: 'an array' };
    await fsp.writeFile(meta, canonicalJSON(sidecar));
    await assert.rejects(recordDynamic(root, DOC_KEY, [entry(FONT_KEY)]), /existing dynamic is not an array/);

    // Existing dynamic array with a malformed member → throw.
    sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    sidecar.dynamic = [{ key: FONT_KEY, flag: 'BOGUS', via: 'manual' }];
    await fsp.writeFile(meta, canonicalJSON(sidecar));
    await assert.rejects(recordDynamic(root, DOC_KEY, [entry(`${TS}/http://example.com/ok.js`, 'js_')]), /existing dynamic has a malformed entry/);
  });
});

describe('cacheCapture — the requisites ∪ dynamic frontier', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
    await commitDoc(root);
  });

  it('fetches a recorded dynamic child via the STORED-flag URL, then resumes (skips it)', async () => {
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY, FONT_FLAG)]);

    const first = mockArchive({ [FONT_URL]: { status: 200, contentType: 'font/woff', body: FONT_BYTES } });
    const summary = await cacheCapture(DOC_URL, { root, fetch: first.fetchImpl });

    // Doc already committed → skipped; the dynamic font is fetched from FONT_URL.
    assert.deepEqual(first.calls, [FONT_URL], 'exactly the stored-flag URL, once');
    assert.equal(summary.fetched, 1);
    assert.deepEqual(summary.failures, []);

    const child = await readSidecar(root, FONT_KEY);
    assert.equal(child.status, 'body');
    assert.equal(child.flag, FONT_FLAG);
    const childBody = await fsp.readFile((await entryPaths(root, FONT_KEY)).body);
    assert.deepEqual(new Uint8Array(childBody), bytesOf(FONT_BYTES));

    // Second run: child sidecar exists → zero fetches (resume/idempotence).
    const second = mockArchive({});
    const resume = await cacheCapture(DOC_URL, { root, fetch: second.fetchImpl });
    assert.deepEqual(second.calls, [], 'nothing re-fetched');
    assert.equal(resume.fetched, 0);
    assert.equal(resume.skipped, 2, 'doc + dynamic child both skipped');
  });

  it('prefers the STORED dynamic flag over a re-extracted requisite flag (M3)', async () => {
    // A key present in BOTH requisites (extracted im_) and dynamic (stored oe_):
    // the dynamic flag is authoritative and must win — fetched via the oe_ URL.
    const SHARED_ORIGINAL = 'http://example.com/shared-asset';
    const SHARED_KEY = `${TS}/${SHARED_ORIGINAL}`;
    const IM_URL = `https://web.archive.org/web/${TS}im_/${SHARED_ORIGINAL}`;
    const OE_URL = `https://web.archive.org/web/${TS}oe_/${SHARED_ORIGINAL}`;

    // Rebuild the doc so its body carries the im_ ref AND its sidecar lists the
    // requisite — so byKey re-extraction yields im_ for SHARED_KEY.
    const body = `<!doctype html><img src="/web/${TS}im_/${SHARED_ORIGINAL}">`;
    await commitEntry(root, {
      key: DOC_KEY,
      status: 'body',
      contentType: 'text/html',
      fetchedAt: FETCHED_AT,
      requisites: [SHARED_KEY],
      body: bytesOf(body)
    });
    await recordDynamic(root, DOC_KEY, [entry(SHARED_KEY, 'oe_')]);

    const { fetchImpl, calls } = mockArchive({ [OE_URL]: { status: 200, contentType: 'font/woff', body: 'oe bytes' } });
    const summary = await cacheCapture(DOC_URL, { root, fetch: fetchImpl });

    assert.deepEqual(calls, [OE_URL], 'fetched via the stored oe_ URL, NOT the extracted im_ URL');
    assert.ok(!calls.includes(IM_URL), 'the re-extracted im_ URL is never used');
    assert.equal(summary.fetched, 1);
    const child = await readSidecar(root, SHARED_KEY);
    assert.equal(child.flag, 'oe_', 'child committed with the stored dynamic flag');
  });

  it('skips a malformed dynamic entry defensively (never crashes the fan-out)', async () => {
    // Bad flag → cacheCapture must skip it, not fabricate a URL.
    const { meta } = await entryPaths(root, DOC_KEY);
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    sidecar.v = 3;
    sidecar.dynamic = [{ key: FONT_KEY, flag: 'BOGUS', via: 'manual' }];
    await fsp.writeFile(meta, canonicalJSON(sidecar));

    const { fetchImpl, calls } = mockArchive({});
    const summary = await cacheCapture(DOC_URL, { root, fetch: fetchImpl });
    assert.deepEqual(calls, [], 'malformed dynamic entry never fetched');
    assert.equal(summary.fetched, 0);
    assert.deepEqual(summary.failures, []);
  });
});

describe('v3 round-trip through remaster', () => {
  it('remaster accepts v3 and carries dynamic[] through verbatim', async () => {
    const root = await mkroot();
    await commitDoc(root);
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY, FONT_FLAG, { firstSeen: '2026-07-29T00:00:00.000Z' })]);
    const src = await readSidecar(root, DOC_KEY);
    assert.equal(src.v, 3);

    const out = await mkroot();
    await remaster(root, out);

    const carried = await readSidecar(out, DOC_KEY);
    assert.equal(carried.v, 3, 'remaster accepted + preserved v3');
    assert.deepEqual(carried.dynamic, src.dynamic, 'dynamic carried through verbatim');
  });
});

describe('fsck — dynamic closure + malformed', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
    await commitDoc(root);
  });

  const clean = report => {
    for (const { key } of CATEGORIES) {
      assert.equal(report.findings[key].length, 0, `unexpected ${key}: ${JSON.stringify(report.findings[key])}`);
    }
  };

  it('a recorded-but-unfetched dynamic child is one incompleteClosure finding (dynamic: true)', async () => {
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY, FONT_FLAG)]);
    const report = await fsck(root);
    assert.equal(report.findings.incompleteClosure.length, 1);
    const finding = report.findings.incompleteClosure[0];
    assert.equal(finding.child, FONT_KEY);
    assert.equal(finding.dynamic, true);
    // Everything else clean.
    assert.equal(totalFindings(report), 1);
  });

  it('a well-formed, fetched dynamic child verifies clean', async () => {
    await recordDynamic(root, DOC_KEY, [entry(FONT_KEY, FONT_FLAG)]);
    await commitEntry(root, { key: FONT_KEY, status: 'body', contentType: 'font/woff', flag: FONT_FLAG, body: bytesOf(FONT_BYTES) });
    const report = await fsck(root);
    clean(report);
  });

  const patchDynamic = async dynamic => {
    const { meta } = await entryPaths(root, DOC_KEY);
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    sidecar.v = 3;
    sidecar.dynamic = dynamic;
    await fsp.writeFile(meta, canonicalJSON(sidecar));
  };

  it('dynamic that is not an array → one malformed finding', async () => {
    await patchDynamic({ nope: true });
    const report = await fsck(root);
    assert.equal(report.findings.malformed.length, 1);
    assert.match(report.findings.malformed[0].error, /dynamic is not an array/);
    assert.equal(report.findings.incompleteClosure.length, 0, 'a non-array dynamic feeds no closure check');
  });

  it('entry-level malformations → malformed findings (bad flag, bad key, non-object)', async () => {
    await patchDynamic([
      { key: FONT_KEY, flag: 'oe_', via: 'remaster-verify' }, // well-formed → NOT flagged
      { key: `${TS}/http://example.com/bad.js`, flag: 'ZZ', via: 'manual' }, // bad flag
      { key: 'no-separator', flag: 'im_', via: 'manual' }, // bad key
      'not-an-object' // non-object
    ]);
    const report = await fsck(root);
    assert.equal(report.findings.malformed.length, 3, 'three bad entries, the well-formed one is not flagged');
    for (const f of report.findings.malformed) assert.match(f.error, /malformed dynamic entry:/);
    // Only the well-formed (and unfetched) entry feeds closure.
    assert.equal(report.findings.incompleteClosure.length, 1);
    assert.equal(report.findings.incompleteClosure[0].child, FONT_KEY);
  });

  it('a bad `via` entry → one malformed finding (M2 via-enum, writer/verifier parity)', async () => {
    await patchDynamic([{ key: FONT_KEY, flag: 'oe_', via: 'har' }]);
    const report = await fsck(root);
    assert.equal(report.findings.malformed.length, 1);
    assert.match(report.findings.malformed[0].error, /via .*not in \{remaster-verify,manual\}/);
    // A malformed entry feeds no closure check.
    assert.equal(report.findings.incompleteClosure.length, 0);
  });

  const patchSidecar = async patch => {
    const { meta } = await entryPaths(root, DOC_KEY);
    const sidecar = { ...JSON.parse(await fsp.readFile(meta, 'utf8')), v: 3, ...patch };
    await fsp.writeFile(meta, canonicalJSON(sidecar));
  };

  it('a key in BOTH requisites and dynamic yields ONE finding, attributed to the requisite (M5)', async () => {
    await patchSidecar({
      requisites: [FONT_KEY],
      dynamic: [{ key: FONT_KEY, flag: 'im_', via: 'remaster-verify' }]
    });
    const report = await fsck(root);
    assert.equal(report.findings.incompleteClosure.length, 1, 'deduped: not one-per-source');
    const finding = report.findings.incompleteClosure[0];
    assert.equal(finding.child, FONT_KEY);
    assert.ok(!finding.dynamic, 'a key also in requisites is attributed to the requisite (no dynamic flag)');
  });

  it('a duplicated dynamic key yields ONE finding (M5)', async () => {
    const K = `${TS}/http://example.com/dup.woff`;
    await patchSidecar({
      dynamic: [
        { key: K, flag: 'oe_', via: 'remaster-verify' },
        { key: K, flag: 'oe_', via: 'manual' }
      ]
    });
    const report = await fsck(root);
    assert.equal(report.findings.incompleteClosure.length, 1, 'a repeated dynamic key is one finding');
    assert.equal(report.findings.incompleteClosure[0].child, K);
    assert.equal(report.findings.incompleteClosure[0].dynamic, true);
  });
});

describe('pinning — v1/v2 never grow a dynamic field', () => {
  /** Write a canonical bodiless sidecar at version `v` (no dynamic). */
  async function writeBodiless(root, key, v) {
    const sidecar = { contentType: 'text/html', fetchedAt: '2026-07-23T00:00:00.000Z', flag: null, key, requisites: [], status: 'redirect', v };
    const { hash, meta } = await entryPaths(root, key);
    await fsp.mkdir(path.dirname(meta), { recursive: true });
    await fsp.writeFile(meta, canonicalJSON(sidecar));
    return { hash, meta };
  }

  it('commitEntry without dynamic writes NO dynamic key', async () => {
    const root = await mkroot();
    const written = await commitDoc(root);
    assert.ok(!('dynamic' in written));
    const raw = await metaBytes(root, DOC_KEY);
    assert.doesNotMatch(raw.toString('utf8'), /"dynamic"/);
  });

  it('a v1 and a v2 sidecar (no dynamic) read without inventing dynamic + round-trip byte-identically', async () => {
    const root = await mkroot();
    const K1 = `${TS}/http://example.com/legacy-v1`;
    const K2 = `${TS}/http://example.com/legacy-v2`;
    await writeBodiless(root, K1, 1);
    await writeBodiless(root, K2, 2);

    for (const k of [K1, K2]) {
      const s = await readSidecar(root, k);
      assert.ok(!('dynamic' in s), `${k} read without a dynamic field`);
    }

    const beforeV1 = await metaBytes(root, K1);
    const beforeV2 = await metaBytes(root, K2);

    const out = await mkroot();
    await remaster(root, out);

    assert.deepEqual(new Uint8Array(await metaBytes(out, K1)), new Uint8Array(beforeV1), 'v1 byte-identical');
    assert.deepEqual(new Uint8Array(await metaBytes(out, K2)), new Uint8Array(beforeV2), 'v2 byte-identical');
    assert.doesNotMatch((await metaBytes(out, K1)).toString('utf8'), /"dynamic"/);
    assert.doesNotMatch((await metaBytes(out, K2)).toString('utf8'), /"dynamic"/);
  });
});
