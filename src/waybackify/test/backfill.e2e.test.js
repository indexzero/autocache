// node --test — END-TO-END: drive backfill over a small, representative sample
// of REAL captures from our corpus, through the REAL cacheCapture (real replay
// parsing, real requisite extraction, real on-disk key scheme + sidecars). Only
// the network bytes are faked (an injected `fetch`), so the test is
// deterministic and offline while exercising the whole population path —
// document + its im_/cs_/js_ requisites — to full asset closure.
//
// An opt-in LIVE variant (WAYBACKIFY_LIVE=1) runs the same 10 links against the
// real archive.org (needs the firefox impit fingerprint that lives on main).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfill } from '../backfill.js';
import { readSidecar } from '../cache.js';
import { captureKey } from '../key.js';
import { parseWaybackUrl } from '../index.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-e2e-'));
const wb = (ts, orig) => `https://web.archive.org/web/${ts}/${orig}`;

// 10 representative captures pulled from a real backfill worklist — spread
// across the domains + eras a blog archive actually links to. Two carry page
// requisites (so closure fans out); one is archived-missing (404 → gone); one
// is a transient hiccup (498 → deferred); the rest are plain pages.
const SAMPLE = [
  { ts: '20120108015801', orig: 'http://blog.nodejitsu.com:80/micro-templates-are-dead', kind: 'reqs',
    reqs: ['cs_/http://blog.nodejitsu.com/css/site.css', 'im_/http://blog.nodejitsu.com/img/logo.png'] },
  { ts: '20081013100657', orig: 'http://github.com/radiant/radiant-import-export-extension/tree', kind: 'reqs',
    reqs: ['im_/http://github.com/images/icon.png'] },
  { ts: '20081221181905', orig: 'http://msdn.microsoft.com:80/en-us/library/ms747254.aspx', kind: 'plain' },
  { ts: '20081103034914', orig: 'http://www.lab49.com:80/', kind: 'plain' },
  { ts: '20100316031329', orig: 'http://www.businessinsider.com:80/20-reasons-why-the-us-economy-is-dying-and-is-simply-not-going-to-recover-2010-2', kind: 'plain' },
  { ts: '20101219093627', orig: 'http://nodeknockout.com/teams/the-nyc-nodejitsu-ninjas', kind: 'plain' },
  { ts: '20080925083519', orig: 'http://quotedprintable.com:80/pages/scribbish', kind: 'plain' },
  { ts: '20050510075220', orig: 'http://www.aa.com:80/', kind: 'plain' },
  { ts: '20100727142652', orig: 'http://github.com:80/isaacs', kind: 'transient' }, // 498 → deferred
  { ts: '20091025094700', orig: 'http://codebetter.com:80/blogs/patricksmacchia/archive/2009/10/21/x.aspx', kind: 'gone' } // 404 → gone
];

const url = c => wb(c.ts, c.orig);
const docHtml = c =>
  c.kind === 'reqs'
    ? `<html><head>${c.reqs.filter(r => r.startsWith('cs_')).map(r => `<link rel="stylesheet" href="/web/${c.ts}${r}">`).join('')}</head>` +
      `<body>${c.reqs.filter(r => !r.startsWith('cs_')).map(r => `<img src="/web/${c.ts}${r}">`).join('')}</body></html>`
    : `<html><body><p>${c.orig}</p></body></html>`;

/** A Response-like the cacheCapture fetch seam accepts (status/headers/bytes). */
function resp(status, contentType, body = '') {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: { get: n => (n.toLowerCase() === 'content-type' ? contentType : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async text() { return body; }
  };
}

/** Fake archive.org: canned replies keyed by the requested replay URL. */
function fakeArchive() {
  const byDoc = new Map(SAMPLE.map(c => [url(c), c]));
  return async requestUrl => {
    // A requisite fetch carries a replay flag (im_/cs_/js_/oe_) → asset bytes.
    if (/\/web\/\d+(?:im_|cs_|js_|oe_)\//.test(requestUrl)) {
      const ct = /cs_\//.test(requestUrl) ? 'text/css' : 'image/png';
      return resp(200, ct, `ASSET ${requestUrl}`);
    }
    const doc = byDoc.get(requestUrl);
    if (!doc) return resp(404, 'text/html', 'unknown');
    if (doc.kind === 'gone') return resp(404, 'text/html', 'not found');
    if (doc.kind === 'transient') return resp(498, 'text/html', 'slow down');
    return resp(200, 'text/html; charset=utf-8', docHtml(doc));
  };
}

// Inject the 10 as an unfetched worklist + the fake archive; the ENGINE still
// imports and runs the real cacheCapture (only deps.fetch is faked).
function e2eDeps(fetch) {
  return {
    discover: () => [],
    against: async () => ({
      unfetched: SAMPLE.map((c, i) => ({ key: `${String(i).padStart(2, '0')}/${c.orig}`, waybackUrl: url(c) })),
      cached: [], interstitial: [], error: []
    }),
    sleep: async () => {},
    wayback: {},
    fetch
  };
}

async function closureOf(root, c) {
  const { timestamp, original } = parseWaybackUrl(url(c));
  const doc = await readSidecar(root, captureKey(timestamp, original));
  if (!doc) return { doc: false, missing: null };
  let missing = 0;
  for (const rk of doc.requisites ?? []) if (!(await readSidecar(root, rk))) missing++;
  return { doc: true, requisites: (doc.requisites ?? []).length, missing };
}

describe('backfill e2e — real captures → full asset closure (faked bytes)', () => {
  it('fetches every reachable page AND its requisites; defers transient; records 404 gone', async () => {
    const root = tmpRoot();
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps: e2eDeps(fakeArchive()) });

    assert.deepEqual(r.stats, { attempted: 10, fetched: 8, cached: 0, deferred: 1, gone: 1 });

    // The 8 reachable pages are fully closed — doc + every requisite on disk.
    for (const c of SAMPLE.filter(c => c.kind === 'reqs' || c.kind === 'plain')) {
      const cl = await closureOf(root, c);
      assert.equal(cl.doc, true, `doc cached: ${c.orig}`);
      assert.equal(cl.missing, 0, `no missing assets: ${c.orig}`);
      if (c.kind === 'reqs') assert.equal(cl.requisites, c.reqs.length, `all requisites recorded: ${c.orig}`);
    }

    // The 404 is recorded gone and never stored; the 498 is deferred (pending).
    const gone = SAMPLE.find(c => c.kind === 'gone');
    const transient = SAMPLE.find(c => c.kind === 'transient');
    assert.equal((await closureOf(root, gone)).doc, false, '404 not stored');
    assert.match(fs.readFileSync(path.join(root, '.refetch', 'gone.jsonl'), 'utf8'), /codebetter/);
    assert.equal((await closureOf(root, transient)).doc, false, '498 deferred, not stored');
  });

  it('resume: a second run skips the closed pages for free and only retries the deferred', async () => {
    const root = tmpRoot();
    const deps = e2eDeps(fakeArchive());
    await backfill({ ledgerDir: 'x', root, delayMs: 0, deps });
    const r2 = await backfill({ ledgerDir: 'x', root, delayMs: 0, deps });

    // 8 closed pages → free cached skips; the 404 is now filtered out via
    // gone.jsonl; only the 498 costs a network attempt.
    assert.equal(r2.stats.cached, 8, 'closed pages skipped without refetch');
    assert.equal(r2.stats.attempted, 1, 'only the deferred capture is retried');
    assert.equal(r2.stats.deferred, 1);
    assert.equal(r2.stats.fetched, 0, 'nothing re-fetched');
  });
});

// Opt-in: the same 10 links against the real archive.org. Skipped by default
// (network + flaky); needs the firefox impit fingerprint (on main).
describe('backfill e2e — LIVE archive.org', { skip: !process.env.WAYBACKIFY_LIVE }, () => {
  it('closes the reachable sample for real', async () => {
    const root = tmpRoot();
    const reachable = SAMPLE.filter(c => c.kind === 'plain' || c.kind === 'reqs');
    const deps = {
      discover: () => [],
      against: async () => ({
        unfetched: reachable.map((c, i) => ({ key: `${i}/${c.orig}`, waybackUrl: url(c) })),
        cached: [], interstitial: [], error: []
      })
    };
    const r = await backfill({ ledgerDir: 'x', root, delayMs: 500, abortAfter: 3, deps });
    assert.equal(r.aborted, false, 'archive.org reachable (firefox fingerprint)');
    assert.ok(r.stats.fetched >= 1, 'at least one real page closed');
  });
});
