// Site enumeration — offline. The CDX pages under fixtures/cdx/ are REAL rows
// from the index (jefraskin.com and raskincenter.org, 2002–2007), cut down to
// a handful of URLs that between them carry what an enumeration has to
// survive: a URL with several distinct versions, the same content captured
// many times, `www.` and `:80` spellings of one urlkey, 404 and 301 captures,
// a non-HTML asset, an exact duplicate row, and a result split across two
// pages by a resume key. The archive itself is a mock fetch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitEntry } from '@autocache/waybackify/cache.js';
import { captures, discover } from '@autocache/waybackify/ledger.js';
import { validateSiteConfig } from '../src/config.js';
import { enumerate, selectVersions } from '../src/enumerate.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const page = name => fs.readFileSync(path.join(FIXTURES, 'cdx', name), 'utf8');
const REDIRECTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'redirects.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-site-'));
const jsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const CONFIG = validateSiteConfig({
  window: { from: '2002', to: '2007' },
  cdx: { pauseMs: 0, backoffMs: 1, maxAttempts: 3 },
  sites: [
    { name: 'jefraskin.com', queries: [{ url: 'jefraskin.com', matchType: 'domain' }] },
    { name: 'raskincenter.org', queries: [{ url: 'raskincenter.org', matchType: 'domain' }] }
  ]
});

// The one redirect target the mock index knows: the thumbnail the old site
// 301'd to, captured once on the new host.
const THUMB = 'http://jef.raskincenter.org/forjef/jefweb-compiled/img/thi_cover_thumb.jpg';
const THUMB_PAGE = JSON.stringify([
  ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
  ['org,raskincenter,jef)/forjef/jefweb-compiled/img/thi_cover_thumb.jpg', '20050402010101', THUMB, 'image/jpeg', '200', 'F3TLZBEHR5PEEX5L23FBJ4266LXTZ3HD', '8630']
]);

/** A mock archive: the CDX endpoint and the raw-replay redirect probe. */
function mockArchive({ outages = 0 } = {}) {
  const calls = [];
  let failing = outages;
  const res = (status, text, location) => ({
    status,
    headers: { get: h => (h === 'location' ? location ?? null : null) },
    text: async () => text
  });
  const fetch = async (url, init) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/cdx/search/cdx') {
      // The index answers an outage with an HTML page under a 200.
      if (failing-- > 0) return res(200, '<html><body>Temporarily Offline</body></html>');
      assert.ok(u.searchParams.get('limit'), 'every CDX request carries an explicit limit');
      assert.equal(u.searchParams.get('from'), '20020000000000');
      const q = u.searchParams.get('url');
      const mt = u.searchParams.get('matchType');
      if (q === 'jefraskin.com' && mt === 'domain') {
        return res(200, page(u.searchParams.get('resumeKey') ? 'jefraskin.com_domain.p001.json' : 'jefraskin.com_domain.p000.json'));
      }
      if (q === 'raskincenter.org' && mt === 'domain') return res(200, page('raskincenter.org_domain.p000.json'));
      if (q === THUMB && mt === null) return res(200, THUMB_PAGE);
      return res(200, '[]');
    }
    const m = /^\/web\/(\d{14})id_\/(.+)$/.exec(u.pathname + u.search);
    assert.ok(m, `unrouted ${url}`);
    assert.equal(init?.redirect, 'manual', 'a redirect probe never follows');
    const location = REDIRECTS[`${m[1]}/${m[2]}`];
    return location ? res(301, '', location) : res(404, '');
  };
  return { fetch, calls };
}

const run = (ledger, extra = {}) => enumerate(CONFIG, { ledger, sleep: async () => {}, ...extra });

describe('enumerate — CDX index → capture list', () => {
  it('pages with the resume key, saves every raw page verbatim, and counts what it saw', async () => {
    const ledger = tmp();
    const archive = mockArchive();
    const result = await run(ledger, { fetch: archive.fetch });

    for (const name of ['jefraskin.com_domain.p000.json', 'jefraskin.com_domain.p001.json']) {
      assert.equal(fs.readFileSync(path.join(ledger, 'jefraskin.com', 'cdx', name), 'utf8'), page(name), `${name} saved byte-for-byte`);
    }
    // 31 real rows + the one duplicated row.
    assert.equal(result.sites['jefraskin.com'].rows, 32);
    assert.equal(result.sites['jefraskin.com'].okUrls, 3);
    assert.equal(result.sites['jefraskin.com'].versions, 4);
    assert.equal(result.sites['jefraskin.com'].maxVersionsPerUrl, 2);
    assert.deepEqual(result.sites['jefraskin.com'].redirects, { rows: 7, resolved: 7, intoSites: 7 });
    assert.equal(result.offline, false);
  });

  it('one version per distinct digest of a URL, at its earliest capture, ranked oldest first', async () => {
    const ledger = tmp();
    await run(ledger, { fetch: mockArchive().fetch });
    const rows = jsonl(path.join(ledger, 'jefraskin.com', 'captures.jsonl'));
    assert.deepEqual(rows.map(r => [r.rank, r.wayback]), [
      // A JPEG captured three times with one digest → one version, fetched raw.
      [0, 'https://web.archive.org/web/20020225170740id_/http://jefraskin.com:80/forjef/jefweb-compiled/img/thi_cover_thumb.jpg'],
      // A GIF under both `jefraskin.com` and `www.jefraskin.com`: one urlkey, one version.
      [0, 'https://web.archive.org/web/20020717195144id_/http://jefraskin.com:80/forjef2/jefweb-compiled/images/blackdot.gif'],
      // An HTML page with two distinct digests → two versions, normal replay.
      [0, 'https://web.archive.org/web/20020211011843/http://www.jefraskin.com:80/forjef2/jefweb-compiled/pictures/'],
      [1, 'https://web.archive.org/web/20030224204757/http://www.jefraskin.com:80/forjef2/jefweb-compiled/pictures/']
    ]);
    // The row carries the index's facts — the manifest had no place for them.
    assert.deepEqual(rows[0], {
      wayback: rows[0].wayback, rank: 0, site: 'jefraskin.com',
      original: 'http://jefraskin.com:80/forjef/jefweb-compiled/img/thi_cover_thumb.jpg',
      timestamp: '20020225170740', mimetype: 'image/jpeg', digest: 'F3TLZBEHR5PEEX5L23FBJ4266LXTZ3HD',
      length: '8612', urlkey: 'com,jefraskin)/forjef/jefweb-compiled/img/thi_cover_thumb.jpg'
    });
  });

  it('the ledger it writes is one `cache fill` reads: every version of a URL survives', async () => {
    const ledger = tmp();
    await run(ledger, { fetch: mockArchive().fetch });
    const discovered = discover(ledger);
    assert.deepEqual(discovered.map(d => d.file), ['jefraskin.com/captures.jsonl', 'raskincenter.org/captures.jsonl']);
    const items = captures(discovered);
    assert.equal(items.length, 6);
    const pictures = items.filter(i => i.originalUrl.endsWith('/pictures/'));
    assert.deepEqual(pictures.map(i => [i.timestamp, i.rank]), [['20020211011843', 0], ['20030224204757', 1]]);
  });

  it('the inventory gives every CDX row a disposition', async () => {
    const ledger = tmp();
    await run(ledger, { fetch: mockArchive().fetch });
    const summary = JSON.parse(fs.readFileSync(path.join(ledger, 'jefraskin.com', 'summary.json'), 'utf8'));
    assert.deepEqual(summary.disposition, { 'duplicate-row': 1, 'non-ok': 22, 'same-content': 5, version: 4 });
    assert.deepEqual(summary.byStatus, { 200: 9, 301: 7, 404: 16 });
    assert.deepEqual(summary.versionsByMimetype, { 'image/gif': 1, 'image/jpeg': 1, 'text/html': 2 });
    const inventory = jsonl(path.join(ledger, 'jefraskin.com', 'inventory.jsonl'));
    assert.equal(inventory.length, 32);
    const redirect = inventory.find(r => r.timestamp === '20050302233821');
    assert.deepEqual(redirect.redirect, { status: 301, target: THUMB, site: 'raskincenter.org' });
  });

  it('probes each distinct redirect once and queries an in-scope target no capture covers', async () => {
    const ledger = tmp();
    const archive = mockArchive();
    const result = await run(ledger, { fetch: archive.fetch });
    // 7 redirect rows, 5 distinct (urlkey, digest) pairs → 5 probes.
    assert.equal(archive.calls.filter(u => u.includes('id_/')).length, 5);
    assert.equal(jsonl(path.join(ledger, 'jefraskin.com', 'redirects.jsonl')).length, 5);
    // The thumbnail's new home had a capture: it joins the OTHER site's list.
    const target = jsonl(path.join(ledger, 'raskincenter.org', 'captures.jsonl')).find(r => r.original === THUMB);
    assert.equal(target.wayback, `https://web.archive.org/web/20050402010101id_/${THUMB}`);
    assert.equal(result.sites['raskincenter.org'].versions, 2);
    assert.ok(fs.existsSync(path.join(ledger, 'raskincenter.org', 'cdx', 'target_http_jef.raskincenter.org_forjef_jefweb-compiled_img_thi_cover_thumb.jpg.p000.json')));
  });

  it('redirects: false resolves nothing', async () => {
    const ledger = tmp();
    const archive = mockArchive();
    const result = await run(ledger, { fetch: archive.fetch, redirects: false });
    assert.equal(archive.calls.filter(u => u.includes('id_/')).length, 0);
    assert.equal(result.sites['raskincenter.org'].versions, 1);
  });

  it('a rerun writes nothing, and an offline rebuild is byte-identical', async () => {
    const ledger = tmp();
    await run(ledger, { fetch: mockArchive().fetch });
    const snapshot = () => Object.fromEntries(
      fs.readdirSync(ledger, { recursive: true })
        .filter(f => fs.statSync(path.join(ledger, f)).isFile())
        .sort()
        .map(f => [f, `${fs.statSync(path.join(ledger, f)).mtimeMs} ${fs.readFileSync(path.join(ledger, f), 'utf8')}`])
    );
    const before = snapshot();
    await run(ledger, { fetch: mockArchive().fetch });
    assert.deepEqual(snapshot(), before, 'a rerun over unchanged CDX data leaves every file (and mtime) alone');

    for (const f of ['captures.jsonl', 'inventory.jsonl', 'summary.json']) fs.rmSync(path.join(ledger, 'jefraskin.com', f));
    const offline = await run(ledger, { offline: true, fetch: async () => assert.fail('offline touches no network') });
    assert.equal(offline.offline, true);
    const strip = s => Object.fromEntries(Object.entries(s).map(([f, v]) => [f, v.slice(v.indexOf(' ') + 1)]));
    assert.deepEqual(strip(snapshot()), strip(before));
  });

  it('offline with a missing saved page fails loud, naming the file', async () => {
    await assert.rejects(run(tmp(), { offline: true }), /offline, and the saved CDX page is missing: .*jefraskin\.com_domain\.p000\.json/);
  });

  it('an index outage (HTML under a 200) is retried, never read as "no captures"', async () => {
    const ledger = tmp();
    const archive = mockArchive({ outages: 2 });
    const result = await run(ledger, { fetch: archive.fetch });
    assert.equal(result.sites['jefraskin.com'].versions, 4);
    await assert.rejects(run(tmp(), { fetch: mockArchive({ outages: 99 }).fetch }), /HTML body — the index is offline.* after 3 attempts/);
  });

  it('a host rule marks its HTML raw; sites narrows the run', async () => {
    const ledger = tmp();
    const config = { ...CONFIG, rules: [{ host: 'jefraskin.com', html: 'raw' }] };
    await enumerate(config, { ledger, sites: ['jefraskin.com'], fetch: mockArchive().fetch, sleep: async () => {} });
    const rows = jsonl(path.join(ledger, 'jefraskin.com', 'captures.jsonl'));
    assert.ok(rows.every(r => r.wayback.includes('id_/')), 'www.jefraskin.com is under the jefraskin.com rule');
    assert.ok(!fs.existsSync(path.join(ledger, 'raskincenter.org')));
    await assert.rejects(enumerate(CONFIG, { ledger, sites: ['nope'] }), /no site named nope/);
  });

  it('repickFrom skips a capture the cache root proved bad and takes the next of the same content', async () => {
    const ledger = tmp();
    const root = tmp();
    // The root holds the GIF's first capture as an error, and fill recorded
    // the page's second version as gone.
    await commitEntry(root, { key: '20020717195144/http://jefraskin.com:80/forjef2/jefweb-compiled/images/blackdot.gif', status: 'error', contentType: '' });
    fs.mkdirSync(path.join(root, '.refetch'));
    fs.writeFileSync(path.join(root, '.refetch', 'gone.jsonl'),
      `${JSON.stringify({ waybackUrl: 'https://web.archive.org/web/20030224204757/http://www.jefraskin.com:80/forjef2/jefweb-compiled/pictures/' })}\n`);
    await run(ledger, { fetch: mockArchive().fetch, repickFrom: root });
    const rows = jsonl(path.join(ledger, 'jefraskin.com', 'captures.jsonl')).map(r => r.wayback);
    assert.ok(rows.includes('https://web.archive.org/web/20021220130549id_/http://jefraskin.com:80/forjef2/jefweb-compiled/images/blackdot.gif'));
    assert.ok(rows.includes('https://web.archive.org/web/20041216090845/http://www.jefraskin.com:80/forjef2/jefweb-compiled/pictures/'));
    const inventory = jsonl(path.join(ledger, 'jefraskin.com', 'inventory.jsonl'));
    assert.deepEqual(inventory.filter(r => r.disposition === 'repicked-away').map(r => r.bad).sort(), ['error', 'gone']);
  });
});

describe('selectVersions — pure selection', () => {
  const row = (timestamp, digest, extra = {}) => ({
    urlkey: 'org,example)/a', timestamp, original: 'http://example.org/a', mimetype: 'text/html',
    statuscode: '200', digest, length: '1', query: 'q', ...extra
  });
  const window = { from: '20020101000000', to: '20071231235959' };

  it('keeps a row outside the window out of the versions', () => {
    const { captures: list, counts } = selectVersions([row('20010101000000', 'A'), row('20030101000000', 'A')], { site: 's', window });
    assert.deepEqual(list.map(c => c.timestamp), ['20030101000000']);
    assert.equal(counts.disposition['out-of-window'], 1);
  });

  it('when every capture of a digest is bad it keeps the earliest anyway', () => {
    const bad = new Map([['20030101000000/http://example.org/a', 'error'], ['20040101000000/http://example.org/a', 'gone']]);
    const { captures: list } = selectVersions([row('20030101000000', 'A'), row('20040101000000', 'A')], { site: 's', window, bad });
    assert.deepEqual(list.map(c => c.timestamp), ['20030101000000']);
  });

  it('tolerates the index\'s odd mimetypes: `unk` and `warc/revisit` are fetched raw', () => {
    const { captures: list } = selectVersions(
      [row('20030101000000', 'A', { mimetype: 'unk' }), row('20040101000000', 'B', { mimetype: 'warc/revisit' })],
      { site: 's', window }
    );
    assert.deepEqual(list.map(c => c.wayback), [
      'https://web.archive.org/web/20030101000000id_/http://example.org/a',
      'https://web.archive.org/web/20040101000000id_/http://example.org/a'
    ]);
  });
});
