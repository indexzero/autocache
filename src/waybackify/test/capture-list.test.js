// The capture list — the ledger's second file kind (`captures.jsonl`). A
// manifest holds one capture per URL; a capture list holds every capture it
// is given, so a ledger can carry several versions of one URL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { selectWorklist } from '../backfill.js';
import { commitEntry } from '../cache.js';
import { against, captures, discover, flatten, readCaptureList } from '../ledger.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-captures-'));
const wb = (ts, flag = '') => `https://web.archive.org/web/${ts}${flag}/http://example.org/a`;
const write = (dir, file, rows) => {
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
};
const manifest = entries => JSON.stringify({ version: 2, entries });

describe('readCaptureList', () => {
  it('reads rows, keeps the producer\'s own fields, skips blank lines', () => {
    const dir = tmp();
    write(dir, 'captures.jsonl', [{ wayback: wb('20020101000000'), rank: 0, digest: 'D', mimetype: 'text/html' }, '', { wayback: wb('20030101000000', 'id_') }]);
    const rows = readCaptureList(path.join(dir, 'captures.jsonl'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].digest, 'D');
  });

  it('fails loud with the file and line of a bad row', () => {
    const dir = tmp();
    const file = path.join(dir, 'captures.jsonl');
    const bad = (rows, re) => { write(dir, 'captures.jsonl', rows); assert.throws(() => readCaptureList(file), re); };
    bad([{ wayback: wb('20020101000000') }, '{nope'], /captures\.jsonl:2: invalid capture list — not JSON/);
    bad([{ wayback: 'http://example.org/a' }], /captures\.jsonl:1: .*unparseable wayback URL/);
    bad([{ wayback: wb('20020101000000'), rank: -1 }], /rank must be a non-negative integer/);
    bad(['[]'], /row must be an object/);
  });
});

describe('ledger — manifests and capture lists together', () => {
  it('discover finds both; a capture list carries no rewrite program', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'post'));
    fs.writeFileSync(path.join(dir, 'post', 'wayback.json'), manifest({ 'http://example.org/a': { wayback: wb('20020101000000'), timestamp: '20020101000000' } }));
    write(dir, 'site/captures.jsonl', [{ wayback: wb('20030101000000') }]);
    const found = discover(dir);
    assert.deepEqual(found.map(d => [d.file, d.captures?.length]), [['post/wayback.json', undefined], ['site/captures.jsonl', 1]]);
    assert.deepEqual(Object.keys(flatten(found).entries), ['http://example.org/a'], 'flatten is the manifest union only');
  });

  it('captures() keeps every version of a URL, with the files that name it and the lowest rank', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'post'));
    fs.writeFileSync(path.join(dir, 'post', 'wayback.json'), manifest({ 'http://example.org/a': { wayback: wb('20030101000000'), timestamp: '20030101000000' } }));
    write(dir, 'site/captures.jsonl', [
      { wayback: wb('20020101000000'), rank: 0 },
      { wayback: wb('20030101000000'), rank: 1 },
      { wayback: wb('20040101000000', 'id_'), rank: 2 }
    ]);
    const items = captures(discover(dir));
    assert.deepEqual(items.map(i => [i.key, i.rank, i.files]), [
      ['20020101000000/http://example.org/a', 0, ['site/captures.jsonl']],
      // Named by a manifest (rank 0) and by the list (rank 1): the lower rank wins.
      ['20030101000000/http://example.org/a', 0, ['post/wayback.json', 'site/captures.jsonl']],
      ['20040101000000/http://example.org/a', 2, ['site/captures.jsonl']]
    ]);
    assert.equal(items[2].waybackUrl, wb('20040101000000', 'id_'), 'the replay flag rides on the URL; the key ignores it');
  });

  it('against() classifies capture-list rows and carries rank and signature', async () => {
    const dir = tmp();
    const root = tmp();
    write(dir, 'site/captures.jsonl', [{ wayback: wb('20020101000000'), rank: 1 }, { wayback: wb('20030101000000'), rank: 0 }, { wayback: wb('20040101000000'), rank: 0 }]);
    await commitEntry(root, { key: '20030101000000/http://example.org/a', status: 'body', contentType: 'text/plain', body: new TextEncoder().encode('hi') });
    await commitEntry(root, {
      key: '20040101000000/http://example.org/a', status: 'body', contentType: 'text/html',
      body: new TextEncoder().encode('<title>Wayback Machine</title><iframe id="playback" src="x"></iframe>')
    });
    const worklists = await against(discover(dir), root);
    assert.deepEqual(worklists.unfetched.map(i => [i.timestamp, i.rank]), [['20020101000000', 1]]);
    assert.deepEqual(worklists.cached.map(i => i.timestamp), ['20030101000000']);
    assert.deepEqual(worklists.interstitial.map(i => [i.timestamp, i.signature]), [['20040101000000', 'wrapper-stub']]);
  });

  it('the worklist puts every page before any content, whatever the rank', () => {
    const page = (key, rank) => ({ key, rank, waybackUrl: `https://web.archive.org/web/${key}` });
    const raw = (ts, rest, rank) => ({ key: `${ts}/${rest}`, rank, waybackUrl: `https://web.archive.org/web/${ts}id_/${rest}` });
    assert.deepEqual(
      selectWorklist({ unfetched: [raw('1', 'a.gif', 0), page('9/z', 3), raw('2', 'b.pdf', 0), page('1/a', 0)] }),
      [
        'https://web.archive.org/web/1/a',
        'https://web.archive.org/web/9/z',
        'https://web.archive.org/web/1id_/a.gif',
        'https://web.archive.org/web/2id_/b.pdf'
      ],
      'a rank-3 page still precedes a rank-0 raw capture'
    );
  });

  it('the worklist orders by rank before key: one capture of everything comes first', () => {
    const item = (key, rank) => ({ key, rank, waybackUrl: `https://web.archive.org/web/${key}` });
    assert.deepEqual(
      selectWorklist({ unfetched: [item('1/b', 1), item('3/a', 0)], cached: [item('2/a', 1), item('1/a', 0)] }),
      ['https://web.archive.org/web/1/a', 'https://web.archive.org/web/3/a', 'https://web.archive.org/web/1/b', 'https://web.archive.org/web/2/a']
    );
  });
});
