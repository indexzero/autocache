// status — a cache root summarized against its ledger. Offline; the root is
// built through the store's own writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commitEntry } from '../cache.js';
import { status } from '../status.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-status-'));
const wb = (ts, name, flag = '') => `https://web.archive.org/web/${ts}${flag}/http://example.org/${name}`;
const bytes = s => new TextEncoder().encode(s);
const STUB = '<title>Wayback Machine</title><iframe id="playback" src="x"></iframe>';

async function fixture() {
  const ledger = tmp();
  const root = tmp();
  fs.mkdirSync(path.join(ledger, 'site-a'));
  fs.mkdirSync(path.join(ledger, 'site-b'));
  fs.writeFileSync(path.join(ledger, 'site-a', 'captures.jsonl'), [
    { wayback: wb('20020101000000', 'page') },
    { wayback: wb('20030101000000', 'page') },
    { wayback: wb('20020101000000', 'logo.gif') },
    { wayback: wb('20020101000000', 'lost.gif') }
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(ledger, 'site-b', 'wayback.json'), JSON.stringify({
    version: 2,
    entries: {
      'http://example.org/bounce': { wayback: wb('20040101000000', 'bounce'), timestamp: '20040101000000' },
      'http://example.org/dead': { wayback: wb('20040101000000', 'dead'), timestamp: '20040101000000' }
    }
  }));

  await commitEntry(root, { key: '20020101000000/http://example.org/page', status: 'body', contentType: 'text/html', body: bytes('<p>12345</p>'), requisites: ['20020101000000/http://example.org/skin.css'] });
  await commitEntry(root, { key: '20020101000000/http://example.org/skin.css', status: 'body', contentType: 'text/css', flag: 'cs_', body: bytes('p{}') });
  await commitEntry(root, { key: '20020101000000/http://example.org/logo.gif', status: 'body', contentType: 'text/html', body: bytes(STUB) });
  await commitEntry(root, { key: '20040101000000/http://example.org/dead', status: 'error', contentType: '' });
  fs.mkdirSync(path.join(root, '.refetch'));
  fs.writeFileSync(path.join(root, '.refetch', 'gone.jsonl'), `${JSON.stringify({ waybackUrl: wb('20020101000000', 'lost.gif') })}\n{torn`);
  return { ledger, root };
}

describe('status', () => {
  it('counts states overall and per top-level ledger directory, and splits unfetched into gone and pending', async () => {
    const { ledger, root } = await fixture();
    const s = await status(ledger, root);
    assert.equal(s.captures, 6);
    assert.deepEqual(s.states, { cached: 1, unfetched: 3, interstitial: 1, error: 1 });
    assert.deepEqual(s.groups, {
      'site-a': { cached: 1, unfetched: 2, interstitial: 1, error: 0 },
      'site-b': { cached: 0, unfetched: 1, interstitial: 0, error: 1 }
    });
    assert.deepEqual(s.unfetched, { gone: 1, pending: 2 });
    assert.equal(s.complete, false);
  });

  it('names what no further pass will fix, with its remedy', async () => {
    const { ledger, root } = await fixture();
    const s = await status(ledger, root);
    assert.deepEqual(s.attention, [
      { state: 'interstitial', key: '20020101000000/http://example.org/logo.gif', signature: 'wrapper-stub', remedy: 'remediate' },
      { state: 'error', key: '20040101000000/http://example.org/dead', remedy: 'repick' }
    ]);
  });

  it('measures the store: sidecars split into ledger captures and requisites, bytes under cap/', async () => {
    const { ledger, root } = await fixture();
    const s = await status(ledger, root);
    assert.deepEqual(s.store, { sidecars: 4, documents: 3, requisites: 1, bytes: 15 });
  });

  it('is complete when nothing is pending and nothing needs attention; it writes nothing', async () => {
    const ledger = tmp();
    const root = tmp();
    fs.writeFileSync(path.join(ledger, 'captures.jsonl'), `${JSON.stringify({ wayback: wb('20020101000000', 'a') })}\n`);
    await commitEntry(root, { key: '20020101000000/http://example.org/a', status: 'body', contentType: 'text/plain', body: bytes('a') });
    const before = fs.readdirSync(root).sort();
    const s = await status(ledger, root);
    assert.equal(s.complete, true);
    assert.deepEqual(Object.keys(s.groups), ['.'], 'a file at the top of the ledger groups under "."');
    assert.deepEqual(fs.readdirSync(root).sort(), before);
  });
});
