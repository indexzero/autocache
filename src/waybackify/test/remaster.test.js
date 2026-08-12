// Remaster tests — the hermetic-in / remastered-out build.
//
// Two arenas:
//   1. a SYNTHETIC hermetic root, hand-built so each entry names the mechanism
//      it exercises (B1 attr / CSS url() / JS literal, B2 host-relative,
//      srcset, @font-face, an unsatisfiable ref, a binary body, and the three
//      bodiless statuses) — asserts the rewrite + carry-over + build record.
//   2. the COMMITTED 7-entry cache-root fixture (render/wayback/test/fixtures)
//      — asserts determinism (run twice, byte-identical), FsStore-servable
//      integrity, orphan-cap drop, and a bin smoke.
import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureHash } from '../key.js';
import { RULE_VERSION } from '../rewrite.js';
import { BUILD_NAME, ENGINE_VERSION, remaster } from '../remaster.js';

// The `remaster <hermetic> <out>` bin smoke now lives in the CLI's
// `remaster build` command tests — the library ships no bin.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(HERE, 'fixtures/cache-root');

const mkroot = prefix => fsp.mkdtemp(path.join(os.tmpdir(), prefix));
const bytesOf = s => Buffer.from(s, 'latin1');
const sri = bytes => `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;

/** Canonical JSON — the byte form cache.js / remaster.js write. */
function canonicalJSON(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Write one hermetic entry (body + sidecar) into a root, the way cache.js does. */
async function writeEntry(root, { key, status = 'body', contentType = '', flag = null, body = null }) {
  const hash = await captureHash(key);
  const aa = hash.slice(0, 2);
  const sidecar = { contentType, fetchedAt: '2026-07-23T00:00:00.000Z', flag, key, requisites: [], status, v: 1 };
  if (status === 'body') {
    const bytes = bytesOf(body ?? '');
    await fsp.mkdir(path.join(root, 'cap', aa), { recursive: true });
    await fsp.writeFile(path.join(root, 'cap', aa, hash), bytes);
    sidecar.contentHash = sri(bytes);
    sidecar.contentLength = bytes.length;
  }
  await fsp.mkdir(path.join(root, 'meta', aa), { recursive: true });
  await fsp.writeFile(path.join(root, 'meta', aa, `${hash}.json`), canonicalJSON(sidecar));
  return { hash, aa };
}

/** Read a remastered body + its sidecar back by capture key. */
async function readOut(root, key) {
  const hash = await captureHash(key);
  const aa = hash.slice(0, 2);
  const metaRaw = await fsp.readFile(path.join(root, 'meta', aa, `${hash}.json`), 'utf8');
  const sidecar = JSON.parse(metaRaw);
  let body = null;
  try {
    body = await fsp.readFile(path.join(root, 'cap', aa, hash));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { sidecar, body, metaRaw };
}

/** Content hash of a whole tree (relative path + bytes), order-independent. */
async function treeDigest(root) {
  const files = [];
  async function walk(dir, rel) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(abs, r);
      else files.push([r, await fsp.readFile(abs)]);
    }
  }
  await walk(root, '');
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [r, buf] of files) {
    h.update(r);
    h.update(buf);
  }
  return { digest: h.digest('hex'), names: files.map(f => f[0]) };
}

const TS = '20140403040000';
const DOC_KEY = `${TS}/http://example.com/`;
const CSS_KEY = `${TS}/http://example.com/screen.css`;
const JS_KEY = `${TS}/http://example.com/app.js`;
const IMG_KEY = `${TS}/http://example.com/logo.png`;
const FONT_KEY = `${TS}/http://example.com/fonts/x.woff2`;

/** A synthetic hermetic root exercising every mechanism class. */
async function buildSyntheticRoot() {
  const root = await mkroot('rm-synth-');
  const DOC = [
    '<html><head>',
    '<!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp">chrome</div><!-- END WAYBACK TOOLBAR INSERT -->',
    '<style>@import "https://web.archive.org/web/20140403040000cs_/http://example.com/screen.css";',
    'body{background:url(https://web.archive.org/web/20140403040000im_/http://example.com/logo.png)}</style>',
    '</head><body>',
    // B1 absolute attr (satisfiable) + srcset (one satisfiable, one not):
    '<img src="https://web.archive.org/web/20140403040000im_/http://example.com/logo.png" ',
    'srcset="https://web.archive.org/web/20140403040000im_/http://example.com/logo.png 1x, ',
    'https://web.archive.org/web/20140403040000im_/http://example.com/absent.png 2x">',
    // B2 host-relative (already the target form):
    '<a href="/web/20140403040000/http://example.com/screen.css">css</a>',
    // unsatisfiable absolute → stays foreign:
    '<a href="https://web.archive.org/web/20140403040000/http://example.com/nope">nope</a>',
    // inline JS literal (satisfiable):
    '<script>var u = "https://web.archive.org/web/20140403040000js_/http://example.com/app.js";</script>',
    '</body></html>'
  ].join('');

  await writeEntry(root, { key: DOC_KEY, status: 'body', contentType: 'text/html; charset=utf-8', body: DOC });
  await writeEntry(root, {
    key: CSS_KEY,
    status: 'body',
    contentType: 'text/css',
    flag: 'cs_',
    body: '@font-face{font-family:x;src:url(https://web.archive.org/web/20140403040000cs_/http://example.com/fonts/x.woff2) format("woff2")}'
  });
  await writeEntry(root, {
    key: JS_KEY,
    status: 'body',
    contentType: 'application/javascript',
    flag: 'js_',
    body: 'var img = "https://web.archive.org/web/20140403040000im_/http://example.com/logo.png"; console.log(img);'
  });
  // A binary body with a high byte — must be copied byte-identical.
  await writeEntry(root, { key: IMG_KEY, status: 'body', contentType: 'image/png', flag: 'im_', body: '\x89PNG\r\n\x1a\n binary \xff\xfe bytes' });
  await writeEntry(root, { key: FONT_KEY, status: 'body', contentType: 'font/woff2', flag: 'cs_', body: 'wOF2 fake' });
  // The four bodiless statuses (interstitial is #363: a refused wayback fluff
  // page — bodiless like the rest, so remaster must carry it through untouched).
  await writeEntry(root, { key: `${TS}/http://example.com/empty`, status: 'empty', contentType: '' });
  await writeEntry(root, { key: `${TS}/http://example.com/redirect`, status: 'redirect', contentType: 'text/html' });
  await writeEntry(root, { key: `${TS}/http://example.com/missing.gif`, status: 'error', contentType: '' });
  await writeEntry(root, { key: `${TS}/http://example.com/interstitial`, status: 'interstitial', contentType: 'text/html' });
  return root;
}

describe('remaster — synthetic root (mechanism coverage)', () => {
  let root;
  let out;
  let report;

  before(async () => {
    root = await buildSyntheticRoot();
    out = await mkroot('rm-synth-out-');
    report = await remaster(root, out);
  });

  it('reports every sidecar and counts bodies + rewrites', () => {
    assert.equal(report.sidecars, 9);
    assert.equal(report.bodies, 5);
    // doc (html), css (@font-face) and js literal get rewritten; png + woff2 copy verbatim.
    assert.equal(report.rewritten, 3);
  });

  it('B1 attr + srcset + inline style/script: satisfiable refs localized, unsatisfiable left foreign', async () => {
    const { body } = await readOut(out, DOC_KEY);
    const html = body.toString('latin1');
    assert.ok(!html.includes('WAYBACK TOOLBAR INSERT')); // chrome stripped
    assert.ok(html.includes('src="/web/20140403040000im_/http://example.com/logo.png"'));
    assert.ok(html.includes('/web/20140403040000im_/http://example.com/logo.png 1x')); // srcset candidate 1
    assert.ok(html.includes('https://web.archive.org/web/20140403040000im_/http://example.com/absent.png 2x')); // foreign
    assert.ok(html.includes('href="/web/20140403040000/http://example.com/screen.css"')); // B2 preserved
    // An UNCAPTURED NAVIGATIONAL <a href> is now localized to mirror form (Option C):
    // it must funnel to the mirror's own miss page, never load live archive.org in-frame.
    assert.ok(html.includes('href="/web/20140403040000/http://example.com/nope"'));
    assert.ok(!html.includes('https://web.archive.org/web/20140403040000/http://example.com/nope'));
    assert.ok(html.includes('"/web/20140403040000js_/http://example.com/app.js"')); // inline JS literal
    assert.ok(html.includes('@import "/web/20140403040000cs_/http://example.com/screen.css"')); // inline <style>
    assert.ok(html.includes('url(/web/20140403040000im_/http://example.com/logo.png)')); // inline <style> url()
  });

  it('CSS @font-face src url() is localized', async () => {
    const { body } = await readOut(out, CSS_KEY);
    assert.ok(body.toString('latin1').includes('url(/web/20140403040000cs_/http://example.com/fonts/x.woff2) format("woff2")'));
  });

  it('a rewritten body carries an UPDATED sidecar (contentHash + contentLength match the new bytes)', async () => {
    const { sidecar, body } = await readOut(out, DOC_KEY);
    assert.equal(sidecar.contentLength, body.length);
    assert.equal(sidecar.contentHash, sri(body));
  });

  it('a binary body is copied byte-identical, sidecar unchanged', async () => {
    const inHash = await captureHash(IMG_KEY);
    const inAa = inHash.slice(0, 2);
    const inBytes = await fsp.readFile(path.join(root, 'cap', inAa, inHash));
    const { body, metaRaw } = await readOut(out, IMG_KEY);
    assert.deepEqual(body, inBytes); // byte-for-byte
    const origMeta = await fsp.readFile(path.join(root, 'meta', inAa, `${inHash}.json`), 'utf8');
    assert.equal(metaRaw, origMeta); // sidecar byte-identical
  });

  it('bodiless entries carry through with no body and an unchanged sidecar', async () => {
    for (const key of [`${TS}/http://example.com/empty`, `${TS}/http://example.com/redirect`, `${TS}/http://example.com/missing.gif`, `${TS}/http://example.com/interstitial`]) {
      const hash = await captureHash(key);
      const aa = hash.slice(0, 2);
      const { body, metaRaw } = await readOut(out, key);
      assert.equal(body, null); // no cap/ body written
      const origMeta = await fsp.readFile(path.join(root, 'meta', aa, `${hash}.json`), 'utf8');
      assert.equal(metaRaw, origMeta);
    }
  });

  it('writes a build record at the root, outside cap/ and meta/', async () => {
    const build = JSON.parse(await fsp.readFile(path.join(out, BUILD_NAME), 'utf8'));
    assert.equal(build.v, 1);
    assert.equal(build.ruleVersion, RULE_VERSION);
    assert.equal(build.engineVersion, ENGINE_VERSION);
    assert.equal(build.entries.length, 9);
    // entries sorted by key
    const keys = build.entries.map(e => e.key);
    assert.deepEqual(keys, [...keys].sort());
    // a rewritten entry records differing input/output hashes; a bodiless one has nulls.
    const doc = build.entries.find(e => e.key === DOC_KEY);
    assert.equal(doc.rewritten, true);
    assert.notEqual(doc.inputHash, doc.outputHash);
    const empty = build.entries.find(e => e.key.endsWith('/empty'));
    assert.equal(empty.inputHash, null);
    assert.equal(empty.outputHash, null);
  });
});

describe('remaster — determinism (hard requirement)', () => {
  it('same hermetic tree → byte-identical remastered tree + build record, twice', async () => {
    const a = await mkroot('rm-det-a-');
    const b = await mkroot('rm-det-b-');
    await remaster(FIXTURE_ROOT, a);
    await remaster(FIXTURE_ROOT, b);
    const da = await treeDigest(a);
    const db = await treeDigest(b);
    assert.equal(da.digest, db.digest);
    assert.deepEqual(da.names, db.names);
  });
});

describe('remaster — committed 7-entry fixture', () => {
  let out;
  let report;
  before(async () => {
    out = await mkroot('rm-fix-');
    report = await remaster(FIXTURE_ROOT, out);
  });

  it('carries all 7 sidecars, 4 bodies; drops the orphan cap/ (no sidecar)', async () => {
    assert.equal(report.sidecars, 7);
    assert.equal(report.bodies, 4);
    const names = (await treeDigest(out)).names;
    const caps = names.filter(n => n.startsWith('cap/'));
    assert.equal(caps.length, 4);
    // the fixture's orphan body (key .../orphan, hash d325db35…) has no sidecar → never carried.
    assert.ok(!caps.some(n => n.includes('d325db35')));
  });

  it('every bodied entry is FsStore-servable: sidecar contentLength + contentHash match the bytes', async () => {
    const metaDir = path.join(out, 'meta');
    for (const aa of await fsp.readdir(metaDir)) {
      for (const file of await fsp.readdir(path.join(metaDir, aa))) {
        const sidecar = JSON.parse(await fsp.readFile(path.join(metaDir, aa, file), 'utf8'));
        if (sidecar.status !== 'body') continue;
        const hash = file.slice(0, -'.json'.length);
        const body = await fsp.readFile(path.join(out, 'cap', aa, hash));
        assert.equal(sidecar.contentLength, body.length, `${sidecar.key} length`);
        assert.equal(sidecar.contentHash, sri(body), `${sidecar.key} hash`);
      }
    }
  });

  it('strips the toolbar from the real google.com capture and localizes its google.jpg requisite', async () => {
    const { body } = await readOut(out, '19981202230410/http://www.google.com/');
    const html = body.toString('latin1');
    assert.ok(!html.includes('WAYBACK TOOLBAR INSERT'));
    assert.ok(!html.includes('web-static.archive.org'));
    assert.ok(html.includes('Search the web using Google!')); // page survived
    assert.ok(html.includes('/web/19981202230410im_/http://www.google.com/google.jpg')); // requisite in corpus
  });
});
