// Ledger tests — discovery of manifests under an arbitrary tree (paths as
// identity, no layout conventions), the flatten union (the seen-file
// bootstrap), and the against() worklist join with a cache root written by
// the library's own committer. Synthetic fixtures only; zero network.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { against, discover, flatten } from '../ledger.js';
import { commitEntry } from '../cache.js';

const WB_A = 'https://web.archive.org/web/20100101000000/http://a.example.com/';
const WB_A_LATER = 'https://web.archive.org/web/20200101000000/http://a.example.com/';
const WB_B = 'https://web.archive.org/web/20140403040000/http://b.example.com/post';
const WB_C = 'https://web.archive.org/web/20200101000000/http://c.example.com/';
const WB_D = 'https://web.archive.org/web/20210101000000/http://d.example.com/';

/** Lay a manifest file down under root, creating directories as needed. */
function put(root, rel, manifest) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
}

/** A synthetic tree: nested manifests, a v1 straggler, decoys to skip. */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  put(root, 'beta/deep/wayback.json', {
    version: 2,
    entries: { 'http://b.example.com/post': { wayback: WB_B, timestamp: '20140403040000' } },
    rewrites: { 'http://moved.example.com/': 'https://newhome.example.com/' }
  });
  put(root, 'alpha/wayback.json', {
    version: 1,
    entries: {
      'http://a.example.com/': { wayback: WB_A, timestamp: '20100101000000' },
      'http://gone.example.com/': { wayback: null, timestamp: null }
    }
  });
  put(root, 'gamma/wayback.json', {
    version: 2,
    // The same live url alpha resolved — to a DIFFERENT capture (near its
    // own source's date). flatten keeps the first in sorted-path order
    // (alpha); against() keeps BOTH captures — they are distinct keys.
    entries: {
      'http://a.example.com/': { wayback: WB_A_LATER, timestamp: '20200101000000' },
      'http://c.example.com/': { wayback: WB_C, timestamp: '20200101000000' },
      'http://d.example.com/': { wayback: WB_D, timestamp: '20210101000000' }
    },
    exclude: ['http://gone.example.com/', 'http://also-live.example.com/']
  });
  // Decoys: hidden dirs and node_modules are never walked; other json
  // files are not manifests.
  put(root, '.hidden/wayback.json', { version: 2, entries: {} });
  put(root, 'node_modules/pkg/wayback.json', { version: 2, entries: {} });
  fs.writeFileSync(path.join(root, 'alpha', 'not-wayback.json'), '{}');
  return root;
}

describe('discover', () => {
  it('finds every wayback.json recursively — relative paths as identity, sorted', () => {
    const root = makeTree();
    const found = discover(root);
    assert.deepEqual(
      found.map(d => d.file),
      ['alpha/wayback.json', 'beta/deep/wayback.json', 'gamma/wayback.json']
    );
    // Read through the manifest reader: the v1 null became exclude.
    assert.deepEqual(found[0].manifest.exclude, ['http://gone.example.com/']);
  });

  it('an empty or missing root is an empty ledger, not an error', () => {
    assert.deepEqual(discover(path.join(os.tmpdir(), 'ledger-definitely-missing')), []);
  });

  it('an invalid manifest anywhere fails loud with its path', () => {
    const root = makeTree();
    put(root, 'zeta/wayback.json', { version: 9, entries: {} });
    assert.throws(() => discover(root), /zeta[\\/]wayback\.json: invalid manifest — unsupported version 9/);
  });
});

describe('flatten', () => {
  it('unions the ledger into one manifest — first verdict wins, exclude set-unions', () => {
    const union = flatten(discover(makeTree()));
    assert.deepEqual(Object.keys(union.entries).sort(), [
      'http://a.example.com/',
      'http://b.example.com/post',
      'http://c.example.com/',
      'http://d.example.com/'
    ]);
    // alpha (first in sorted-path order) beat gamma for the shared url.
    assert.equal(union.entries['http://a.example.com/'].wayback, WB_A);
    assert.deepEqual(union.exclude, ['http://also-live.example.com/', 'http://gone.example.com/']);
    assert.deepEqual(union.rewrites, { 'http://moved.example.com/': 'https://newhome.example.com/' });
  });

  it('flattening nothing is the empty manifest', () => {
    assert.deepEqual(flatten([]), { version: 2, rewrites: {}, entries: {}, exclude: [] });
  });
});

describe('against', () => {
  it('joins the ledger with a cache root via the library sidecar reader', async () => {
    const tree = makeTree();
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cache-'));

    // Write real entries with the library's own committer — no second
    // sidecar dialect can exist in this test by construction.
    await commitEntry(cacheRoot, {
      key: '20100101000000/http://a.example.com/',
      status: 'body',
      contentType: 'text/html',
      body: new TextEncoder().encode('<html>a</html>')
    });
    await commitEntry(cacheRoot, {
      key: '20140403040000/http://b.example.com/post',
      status: 'error',
      contentType: ''
    });
    await commitEntry(cacheRoot, {
      key: '20200101000000/http://c.example.com/',
      status: 'interstitial',
      contentType: 'text/html'
    });
    // Gamma's later a-capture and the d-capture deliberately never written.

    const worklists = await against(discover(tree), cacheRoot);

    assert.deepEqual(
      worklists.cached.map(i => [i.key, i.status, i.files]),
      [['20100101000000/http://a.example.com/', 'body', ['alpha/wayback.json']]]
    );
    assert.deepEqual(
      worklists.error.map(i => [i.key, i.status, i.files]),
      [['20140403040000/http://b.example.com/post', 'error', ['beta/deep/wayback.json']]]
    );
    assert.deepEqual(
      worklists.interstitial.map(i => [i.key, i.status, i.files]),
      [['20200101000000/http://c.example.com/', 'interstitial', ['gamma/wayback.json']]]
    );
    assert.deepEqual(
      worklists.unfetched.map(i => [i.key, i.status]),
      [
        ['20200101000000/http://a.example.com/', null],
        ['20210101000000/http://d.example.com/', null]
      ]
    );
  });
});
