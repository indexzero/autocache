// Cache-store tests — offline, mocked fetch + fixtures, zero network.
//
// The three debate edge cases (EC-1 crash atomicity, EC-2 hostile-key
// round-trip, EC-3 duplicate bodies under concurrency) are MANDATORY here —
// they are the acceptance criteria the design debate encoded.
// Live population runs live in cache-live.test.js behind WAYBACK_LIVE=1.
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheCapture, canonicalJSON, commitEntry, entryPaths, readSidecar } from '../cache.js';
import { captureHash } from '../key.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const DOC_HTML = fs.readFileSync(path.join(FIXTURES, 'replay/requisites-page.html'), 'utf8');
const TS = '20111011002337';
const DOC_ORIGINAL = 'http://example.com/post/scaling-isomorphic-javascript-code';
const DOC_URL = `https://web.archive.org/web/${TS}/${DOC_ORIGINAL}`;
const DOC_KEY = `${TS}/${DOC_ORIGINAL}`;

// The fixture's 8 unique requisites (see requisites.test.js) as
// [flaggedFetchUrl, key, body] rows the mock archive serves.
const REQS = [
  ['cs_', 'http://example.com/css/screen.css', 'body { color: teal }'],
  ['cs_', 'http://example.com/css/print.css', '@media print { * { display: none } }'],
  ['js_', 'http://example.com/js/jquery-1.4.2.min.js', 'window.$ = function () {};'],
  ['js_', 'http://ajax.googleapis.com/ajax/libs/jquery/1.4/jquery.min.js', 'window.jQuery = window.$;'],
  ['im_', 'http://example.com/images/diagram.png', '\x89PNG fake-diagram-bytes'],
  ['im_', 'http://static.example.com/avatar.gif?s=48&d=identicon', 'GIF89a fake-avatar'],
  ['oe_', 'http://example.com/media/demo.swf', 'FWS fake-flash'],
  ['im_', 'http://example.com/images/collapsed-scheme.jpg', '\xff\xd8 fake-jpeg']
].map(([flag, original, body]) => ({
  flag,
  original,
  body,
  key: `${TS}/${original}`,
  url: `https://web.archive.org/web/${TS}${flag}/${original}`
}));

/** Tiny canned archive: url → {status, contentType, body} (or a function). */
function mockArchive(overrides = {}) {
  const routes = {
    [DOC_URL]: { status: 200, contentType: 'text/html; charset=utf-8', body: DOC_HTML },
    ...Object.fromEntries(REQS.map(r => [r.url, { status: 200, contentType: 'application/x-fake', body: r.body }])),
    ...overrides
  };
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`mock archive: unrouted ${url}`);
    if (typeof route === 'function') return route(url);
    const bytes = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : (route.body ?? new Uint8Array(0));
    return {
      status: route.status ?? 200,
      headers: { get: h => (h === 'content-type' ? (route.contentType ?? null) : null) },
      arrayBuffer: async () => bytes.slice().buffer
    };
  };
  return { fetchImpl, calls };
}

const mkroot = () => fsp.mkdtemp(path.join(os.tmpdir(), 'waybackify-cache-'));
const sriOf = bytes => `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;

describe('cacheCapture — requisites by default', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
  });

  it('stores the document + every flagged requisite with the DAG recorded', async () => {
    const { fetchImpl, calls } = mockArchive();
    const summary = await cacheCapture(DOC_URL, { root, fetch: fetchImpl });

    assert.equal(calls.length, 1 + REQS.length, 'one fetch per entry, none twice');
    assert.equal(summary.fetched, 1 + REQS.length);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.failures, []);

    const doc = await readSidecar(root, DOC_KEY);
    assert.equal(doc.v, 3);
    assert.equal(doc.key, DOC_KEY);
    assert.equal(doc.status, 'body');
    assert.equal(doc.contentType, 'text/html; charset=utf-8');
    assert.equal(doc.flag, null);
    assert.deepEqual([...doc.requisites].sort(), REQS.map(r => r.key).sort());

    for (const r of REQS) {
      const side = await readSidecar(root, r.key);
      assert.equal(side.status, 'body', r.key);
      assert.equal(side.flag, r.flag);
      assert.deepEqual(side.requisites, []);
      // Verbatim bytes: stored body === exactly what the archive returned.
      const { body } = await entryPaths(root, r.key);
      assert.deepEqual(new Uint8Array(await fsp.readFile(body)), new TextEncoder().encode(r.body));
    }
  });

  it('stores VERBATIM document bytes — no toolbar strip, no URL rewriting', async () => {
    const { fetchImpl } = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: fetchImpl });
    const { body } = await entryPaths(root, DOC_KEY);
    const stored = await fsp.readFile(body, 'utf8');
    assert.equal(stored, DOC_HTML);
    assert.ok(stored.includes('BEGIN WAYBACK TOOLBAR INSERT'), 'toolbar must survive store-time');
  });

  it('sidecars are canonical JSON: sorted keys, single line, no CR/LF, byte-reproducible', async () => {
    const { fetchImpl } = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: fetchImpl });
    const { meta } = await entryPaths(root, DOC_KEY);
    const raw = await fsp.readFile(meta, 'utf8');
    assert.doesNotMatch(raw, /[\r\n]/);
    assert.equal(raw, canonicalJSON(JSON.parse(raw)), 'file is its own canonical form');
    assert.deepEqual(Object.keys(JSON.parse(raw)), [...Object.keys(JSON.parse(raw))].sort());
  });

  it('contentHash (SRI sha256-<base64>) verifies against the stored bytes', async () => {
    const { fetchImpl } = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: fetchImpl });
    for (const key of [DOC_KEY, ...REQS.map(r => r.key)]) {
      const side = await readSidecar(root, key);
      const { body } = await entryPaths(root, key);
      const bytes = await fsp.readFile(body);
      assert.match(side.contentHash, /^sha256-[A-Za-z0-9+/]+=*$/);
      assert.equal(side.contentHash, sriOf(bytes), key);
      assert.equal(side.contentLength, bytes.byteLength, key);
    }
  });

  it('layout: cap/<aa>/<hash> + meta/<aa>/<hash>.json, hash = sha256hex(key), aa = hash[0:2]', async () => {
    const { fetchImpl } = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: fetchImpl });
    const hash = crypto.createHash('sha256').update(DOC_KEY, 'utf8').digest('hex');
    assert.ok(fs.existsSync(path.join(root, 'cap', hash.slice(0, 2), hash)));
    assert.ok(fs.existsSync(path.join(root, 'meta', hash.slice(0, 2), `${hash}.json`)));
  });

  it('--no-requisites stores exactly one entry but still records the edges', async () => {
    const { fetchImpl, calls } = mockArchive();
    const summary = await cacheCapture(DOC_URL, { root, fetch: fetchImpl, requisites: false });
    assert.equal(calls.length, 1, 'exactly one fetch');
    assert.equal(summary.entries.length, 1);
    const doc = await readSidecar(root, DOC_KEY);
    assert.equal(doc.requisites.length, REQS.length, 'DAG edges are facts of the page, always recorded');
    for (const r of REQS) assert.equal(await readSidecar(root, r.key), null, 'no child stored');

    // ...and a later default run resumes straight into the recorded frontier.
    const again = mockArchive();
    const s2 = await cacheCapture(DOC_URL, { root, fetch: again.fetchImpl });
    assert.equal(s2.fetched, REQS.length, 'children only');
    assert.equal(again.calls.includes(DOC_URL), false, 'document not re-fetched');
  });
});

describe('cacheCapture — resume semantics', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
  });

  it('double run is a fetch-free no-op (the manual double-run check, pinned)', async () => {
    const first = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: first.fetchImpl });
    const second = mockArchive();
    const summary = await cacheCapture(DOC_URL, { root, fetch: second.fetchImpl });
    assert.equal(second.calls.length, 0, 'second run must not fetch');
    assert.equal(summary.fetched, 0);
    assert.equal(summary.skipped, 1 + REQS.length);
  });

  it('^C mid-fan-out: rerun completes ONLY the missing entries (by fetch-count)', async () => {
    // Interrupt after the document + 3 requisites: the 4th requisite fetch
    // throws (the fetch seam is where ^C lands mid-transfer).
    let served = 0;
    const first = mockArchive();
    const interrupting = async url => {
      if (url !== DOC_URL && ++served > 3) throw new Error('SIGINT (simulated)');
      return first.fetchImpl(url);
    };
    const s1 = await cacheCapture(DOC_URL, { root, fetch: interrupting });
    assert.equal(s1.fetched, 1 + 3);
    assert.equal(s1.failures.length, REQS.length - 3, 'the rest recorded, not committed');

    const second = mockArchive();
    const s2 = await cacheCapture(DOC_URL, { root, fetch: second.fetchImpl });
    assert.equal(second.calls.includes(DOC_URL), false, 'document not re-fetched');
    assert.equal(second.calls.length, REQS.length - 3, 'exactly the missing children');
    assert.equal(s2.fetched, REQS.length - 3);
    assert.deepEqual(s2.failures, []);

    const third = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: third.fetchImpl });
    assert.equal(third.calls.length, 0, 'closure complete → no-op');
  });

  it('a requisite the archive permanently lacks (replay 404) is recorded, not re-hammered', async () => {
    const gone = REQS[0];
    const first = mockArchive({ [gone.url]: { status: 404, contentType: 'text/html' } });
    const s1 = await cacheCapture(DOC_URL, { root, fetch: first.fetchImpl });
    assert.deepEqual(s1.failures, []);
    const side = await readSidecar(root, gone.key);
    assert.equal(side.status, 'error');
    assert.equal(side.contentHash, undefined, 'bodiless: no contentHash');
    const { body } = await entryPaths(root, gone.key);
    assert.ok(!fs.existsSync(body), 'bodiless: no cap/ file');

    const second = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: second.fetchImpl });
    assert.equal(second.calls.length, 0, 'error sidecar is complete — never refetched');
  });

  it('a transiently failing requisite (5xx) is NOT committed and retries next run', async () => {
    const flaky = REQS[1];
    const first = mockArchive({ [flaky.url]: { status: 503, contentType: 'text/html' } });
    const s1 = await cacheCapture(DOC_URL, { root, fetch: first.fetchImpl });
    assert.equal(s1.failures.length, 1);
    assert.equal(await readSidecar(root, flaky.key), null, 'no sidecar for a transient failure');

    const second = mockArchive();
    await cacheCapture(DOC_URL, { root, fetch: second.fetchImpl });
    assert.deepEqual(second.calls, [flaky.url], 'retried exactly the flaky child');
    assert.equal((await readSidecar(root, flaky.key)).status, 'body');
  });

  it('document replay 404/non-200 throws and writes NOTHING', async () => {
    const notFound = mockArchive({ [DOC_URL]: { status: 404 } });
    await assert.rejects(() => cacheCapture(DOC_URL, { root, fetch: notFound.fetchImpl }), /HTTP 404/);
    const flaky = mockArchive({ [DOC_URL]: { status: 503 } });
    await assert.rejects(() => cacheCapture(DOC_URL, { root, fetch: flaky.fetchImpl }), /HTTP 503/);
    assert.equal(await readSidecar(root, DOC_KEY), null);
    assert.ok(!fs.existsSync(path.join(root, 'meta')) || (await fsp.readdir(path.join(root, 'meta'))).length === 0);
  });
});

describe('EC-1: crash atomicity — orphan body is ingest garbage', () => {
  it('SIGKILL between body-rename and sidecar-rename → absent, re-fetched, never "empty"', async () => {
    const root = await mkroot();
    const child = spawnSync(process.execPath, [path.join(FIXTURES, 'crash-after-body-commit.mjs'), root], {
      encoding: 'utf8'
    });
    assert.equal(child.signal, 'SIGKILL', `child must die by its own SIGKILL (stderr: ${child.stderr})`);

    const key = '20140403040000/http://crash.example/post';
    const { body, meta } = await entryPaths(root, key);
    assert.ok(fs.existsSync(body), 'orphan cap/ file exists (crash window was real)');
    assert.ok(!fs.existsSync(meta), 'sidecar was never published');
    assert.equal(await readSidecar(root, key), null, 'the entry reports ABSENT');

    // Resume re-fetches to completion.
    let fetches = 0;
    const summary = await cacheCapture(`https://web.archive.org/web/20140403040000/http://crash.example/post`, {
      root,
      requisites: false,
      fetch: async () => {
        fetches++;
        return {
          status: 200,
          headers: { get: h => (h === 'content-type' ? 'text/html' : null) },
          text: async () => '<html><body>recovered</body></html>'
        };
      }
    });
    assert.equal(fetches, 1, 'resume re-fetched the orphan');
    assert.equal(summary.fetched, 1);
    const side = await readSidecar(root, key);
    assert.equal(side.status, 'body');
    assert.equal(await fsp.readFile(body, 'utf8'), '<html><body>recovered</body></html>');

    // ...and an orphan is never confused with a LEGITIMATE bodiless entry:
    // a real zero-byte capture commits a sidecar with status 'empty'.
    const emptyKey = '2014/http://empty.example/';
    await commitEntry(root, { key: emptyKey, status: 'body', contentType: 'text/plain', body: new Uint8Array(0) });
    const emptySide = await readSidecar(root, emptyKey);
    assert.equal(emptySide.status, 'empty');
    assert.equal(emptySide.contentHash, undefined);
    assert.ok(!fs.existsSync((await entryPaths(root, emptyKey)).body), 'empty entries own no cap/ file');
  });
});

describe('EC-2: hostile-key round-trip + cross-target token identity', () => {
  it('2000+ chars of # ? | ^ and NFC/NFD unicode never touch a path; key round-trips byte-exact', async () => {
    const root = await mkroot();
    // NFC é (U+00E9) AND NFD e+◌́ (U+0065 U+0301) in one key — a
    // normalization-insensitive filesystem would collide them if they were
    // path components; the hash namespace cannot.
    const hostile = `http://héllo.example/pa|th^caret/café?q=a#frag-${'x'.repeat(2000)}`;
    const url = `https://web.archive.org/web/20140403040000/${hostile}`;
    const key = `20140403040000/${hostile}`;
    assert.ok(key.length > 2000);

    const { fetchImpl } = mockArchive({
      [url]: { status: 200, contentType: 'text/plain', body: 'hostile body' }
    });
    await cacheCapture(url, { root, fetch: fetchImpl, requisites: false });

    // (a) never a path component: every name on disk is the fixed hash form.
    for (const dir of ['cap', 'meta']) {
      for (const aa of await fsp.readdir(path.join(root, dir))) {
        assert.match(aa, /^[0-9a-f]{2}$/);
        for (const f of await fsp.readdir(path.join(root, dir, aa))) {
          assert.match(f, /^[0-9a-f]{64}(\.json)?$/);
        }
      }
    }

    // (b) byte-exact R2 key via sidecar.key — both unicode normal forms and
    // every hostile character survive verbatim.
    const side = await readSidecar(root, key);
    assert.equal(side.key, key);
    assert.ok(side.key.includes('héllo'), 'NFC sequence preserved');
    assert.ok(side.key.includes('café'), 'NFD sequence preserved');
    assert.notEqual(side.key.normalize('NFC'), side.key, 'key is NOT silently normalized');

    // (c) the filename IS the shared identity hash: captureHash === the
    // bucket object key's <hash> === an independent node:crypto digest.
    const { hash, body, meta } = await entryPaths(root, key);
    assert.equal(hash, crypto.createHash('sha256').update(key, 'utf8').digest('hex'));
    assert.equal(path.basename(body), hash);
    assert.equal(path.basename(meta), `${hash}.json`);
    assert.equal(hash, await captureHash(key));
  });
});

describe('EC-3: duplicate bodies under concurrency', () => {
  it('distinct keys with identical bytes store + read independently; concurrent writers race safely', async () => {
    const root = await mkroot();
    const bytes = new TextEncoder().encode('<html>the interstitial every dead domain shares</html>');
    const keys = ['2011/http://a.example/404', '2012/http://b.example/404', '2013/http://c.example/404'];

    // Three concurrent writers, two of them racing the same content, plus a
    // same-key double-writer — no locks, last-writer-wins on identical bytes.
    await Promise.all([
      commitEntry(root, { key: keys[0], status: 'body', contentType: 'text/html', body: bytes }),
      commitEntry(root, { key: keys[1], status: 'body', contentType: 'text/html', body: bytes }),
      commitEntry(root, { key: keys[2], status: 'body', contentType: 'text/html', body: bytes }),
      commitEntry(root, { key: keys[2], status: 'body', contentType: 'text/html', body: bytes })
    ]);

    const sides = await Promise.all(keys.map(k => readSidecar(root, k)));
    const hashes = new Set(sides.map(s => s.contentHash));
    assert.equal(hashes.size, 1, 'same bytes → same contentHash (the future-GC group key)');
    for (const [i, k] of keys.entries()) {
      assert.equal(sides[i].key, k, 'sidecars never merge');
      const { body } = await entryPaths(root, k);
      assert.deepEqual(new Uint8Array(await fsp.readFile(body)), bytes, 'each entry serves independently');
    }
    const inodes = new Set(await Promise.all(keys.map(async k => (await fsp.stat((await entryPaths(root, k)).body)).ino)));
    assert.equal(inodes.size, 3, 'no write-time dedupe: three independent bodies (GC hardlinking is out of scope)');
    assert.equal((await fsp.readdir(path.join(root, 'tmp'))).length, 0, 'no temp litter after the races');
  });
});

describe('commitEntry — write-time contract enforcement', () => {
  it('rejects CR/LF-bearing and oversized contentType before writing anything', async () => {
    const root = await mkroot();
    await assert.rejects(
      () => commitEntry(root, { key: '2014/http://x/', status: 'body', contentType: 'text/html\r\nX: 1', body: new Uint8Array([1]) }),
      /CR\/LF/
    );
    await assert.rejects(
      () => commitEntry(root, { key: '2014/http://x/', status: 'body', contentType: 'y'.repeat(1001), body: new Uint8Array([1]) }),
      /1000/
    );
    assert.equal(await readSidecar(root, '2014/http://x/'), null);
  });

  it("status 'body' without bytes is a programmer error", async () => {
    const root = await mkroot();
    await assert.rejects(() => commitEntry(root, { key: '2014/http://x/', status: 'body', contentType: 'text/plain' }), /requires body/);
  });

  it('canonicalJSON sorts nested keys deterministically', () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }), '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('readSidecar rejects a sidecar claiming a different key or unknown version (rot ≠ absence)', async () => {
    const root = await mkroot();
    const key = '2014/http://x.example/';
    await commitEntry(root, { key, status: 'body', contentType: 'text/plain', body: new Uint8Array([1]) });
    const { meta } = await entryPaths(root, key);

    const good = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...good, key: '2014/http://tampered.example/' }));
    await assert.rejects(() => readSidecar(root, key), /different key/);

    await fsp.writeFile(meta, JSON.stringify({ ...good, v: 99 }));
    await assert.rejects(() => readSidecar(root, key), /unsupported sidecar version/);
  });

  it('reads a legacy v1 sidecar unchanged (v2 is a backward-compatible superset)', async () => {
    const root = await mkroot();
    const key = '2014/http://legacy.example/';
    await commitEntry(root, { key, status: 'body', contentType: 'text/plain', body: new Uint8Array([1]) });
    const { meta } = await entryPaths(root, key);
    const v2 = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...v2, v: 1 })); // pretend it was written by the v1 writer
    const side = await readSidecar(root, key);
    assert.equal(side.v, 1, 'a v1 root — the whole existing corpus — still reads');
    assert.equal(side.status, 'body');
  });
});

describe('commitEntry — interstitial refusal (#363)', () => {
  const FIX = path.join(FIXTURES, 'interstitial');
  const WRAPPER = fs.readFileSync(path.join(FIX, 'wrapper-stub.html'), 'utf8');
  const REDIRECT = fs.readFileSync(path.join(FIX, 'redirect-interstitial.html'), 'utf8');
  const bytes = s => new TextEncoder().encode(s);

  it('refuses a wrapper-stub body — commits `interstitial`, bodiless, signature recorded', async () => {
    const root = await mkroot();
    const key = '20140403040000/http://example.com/report.pdf';
    const side = await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytes(WRAPPER) });

    assert.equal(side.status, 'interstitial');
    assert.equal(side.signature, 'wrapper-stub');
    assert.equal(side.contentHash, undefined, 'bodiless: no contentHash');
    assert.equal(side.contentLength, undefined, 'bodiless: no contentLength');
    assert.equal(side.target, undefined, 'wrapper stubs carry no target');
    assert.ok(!fs.existsSync((await entryPaths(root, key)).body), 'interstitial owns no cap/ file');
    assert.equal((await readSidecar(root, key)).status, 'interstitial', 're-reads as interstitial');
  });

  it('refuses a redirect interstitial — records the decoded target URL + timestamp', async () => {
    const root = await mkroot();
    const key = '20140403040000/http://example.com/old';
    const side = await commitEntry(root, { key, status: 'body', contentType: 'text/html; charset=utf-8', body: bytes(REDIRECT) });

    assert.equal(side.status, 'interstitial');
    assert.equal(side.signature, 'redirect-interstitial');
    assert.deepEqual(side.target, { url: 'http://example.com/moved-here', timestamp: '20140403040000' });
    assert.ok(!fs.existsSync((await entryPaths(root, key)).body));
  });

  it('refuses a .pdf/.txt stored as text/html even without body markers (extension mismatch)', async () => {
    const root = await mkroot();
    const key = '20140403040000/http://example.com/notes.txt';
    const side = await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytes('<html><body>not the raw .txt</body></html>') });
    assert.equal(side.status, 'interstitial');
    assert.equal(side.signature, 'extension-mismatch');
  });

  it('refuses a capture whose injected CDX statuscode is an archived 4xx', async () => {
    const root = await mkroot();
    const key = '20140403040000/http://example.com/gone';
    const side = await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytes('<html><body>looks fine but archived as 404</body></html>'), cdxStatus: '404' });
    assert.equal(side.status, 'interstitial');
    assert.equal(side.signature, 'archived-error');
  });

  it('the interstitial sidecar is still canonical JSON (sorted keys, one line)', async () => {
    const root = await mkroot();
    const key = '20140403040000/http://example.com/report.pdf';
    await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytes(WRAPPER) });
    const raw = await fsp.readFile((await entryPaths(root, key)).meta, 'utf8');
    assert.doesNotMatch(raw, /[\r\n]/);
    assert.equal(raw, canonicalJSON(JSON.parse(raw)));
    assert.equal(JSON.parse(raw).v, 3);
  });

  it('a legitimate real page is untouched — no false refusal', async () => {
    const root = await mkroot();
    const key = '2011/http://example.com/post';
    const real = '<!DOCTYPE html><html><head><title>Real Post</title></head><body><h1>Content</h1></body></html>';
    const side = await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytes(real) });
    assert.equal(side.status, 'body');
    assert.ok(fs.existsSync((await entryPaths(root, key)).body));
  });
});
