// `waybackify audit <dir>` handler — the checkpointed corpus audit. The verdict
// engine (waybackify#auditCapture) is faked; the REAL generic ledger discovery
// (waybackify/ledger.js) runs over a tiny on-disk wayback.json fixture, and the
// REAL checkpoint engine (src/audit-engine.js) writes the resumable JSONL. We
// prove: captures are discovered from the ledger (not a corpus-tree walk), the
// checkpoint lands, the summary counts by verdict, and a re-run skips.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { auditHandler } from '../src/commands/audit.js';

/** A minimal ledger: one wayback.json manifest with two archived entries. */
function makeLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-audit-'));
  const manifest = {
    version: 2,
    rewrites: {},
    entries: {
      'http://example.com/a': { wayback: 'https://web.archive.org/web/20140101000000/http://example.com/a', timestamp: '20140101000000' },
      'http://example.com/b': { wayback: 'https://web.archive.org/web/20140101000000/http://example.com/b', timestamp: '20140101000000' }
    },
    exclude: []
  };
  fs.writeFileSync(path.join(dir, 'wayback.json'), JSON.stringify(manifest));
  return dir;
}

/** A stub WaybackMachine (no network — the fake auditCapture ignores it). */
class FakeWaybackMachine {
  constructor() {}
}

/** A fake verdict engine: /a is good, everything else is a wayback404. */
const fakeAuditCapture = async waybackUrl => ({
  verdict: waybackUrl.endsWith('/a') ? 'good' : 'wayback404',
  statuscode: waybackUrl.endsWith('/a') ? 200 : 404,
  reason: 'fake verdict',
  evidence: '',
  url: waybackUrl
});

function handlerFor(env = {}) {
  const out = [];
  const calls = [];
  const handler = auditHandler({
    env,
    auditCapture: async (url, opts) => { calls.push(url); return fakeAuditCapture(url); },
    WaybackMachine: FakeWaybackMachine
  });
  return { handler, out, calls };
}

test('discovers ledger captures, audits, checkpoints, and summarizes', async () => {
  const dir = makeLedger();
  const checkpoint = path.join(dir, 'cp.jsonl');
  const { handler, out, calls } = handlerFor();

  const code = await run(['audit', dir, '--checkpoint', checkpoint, '--delay-ms', '0'], { handlers: { audit: handler }, out: l => out.push(l), error: () => {} });
  assert.equal(code, EXIT.OK);

  // Two unique captures discovered from the ledger (not a corpus-tree walk).
  assert.ok(out.some(l => l.includes('enumerated 2 unique captures')));
  assert.equal(calls.length, 2);

  // The checkpoint holds one JSONL verdict per capture.
  const lines = fs.readFileSync(checkpoint, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(new Set(lines.map(l => l.verdict)), new Set(['good', 'wayback404']));

  // The summary counts by verdict.
  assert.ok(out.some(l => l.includes('good:       1')));
  assert.ok(out.some(l => l.includes('wayback404: 1')));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('prints interstitial signature + redirect target for flagged captures (#431 port)', async () => {
  const dir = makeLedger();
  const checkpoint = path.join(dir, 'cp.jsonl');
  const out = [];
  // /b comes back as a redirect interstitial carrying the fields auditCapture
  // emits for Signal 1.5 (#363/#431): a signature and the decoded destination.
  const handler = auditHandler({
    env: {},
    auditCapture: async url =>
      url.endsWith('/a')
        ? { verdict: 'good', statuscode: 200, reason: 'ok', evidence: '', url }
        : {
            verdict: 'wayback404',
            statuscode: 200,
            reason: 'redirect interstitial',
            evidence: 'archive redirect wrapper',
            signature: 'redirect-interstitial',
            target: { timestamp: '20140101000000', url: 'http://example.com/elsewhere' },
            url
          },
    WaybackMachine: FakeWaybackMachine
  });

  const code = await run(['audit', dir, '--checkpoint', checkpoint, '--delay-ms', '0'], { handlers: { audit: handler }, out: l => out.push(l), error: () => {} });
  assert.equal(code, EXIT.OK);

  // The relocated printer surfaces #431's interstitial fields — ported from the
  // retired render/wayback/bin/audit-corpus.js printer when the bin moved here.
  assert.ok(out.some(l => l.includes('signature: redirect-interstitial')), 'signature line printed');
  assert.ok(
    out.some(l => l.includes('redirects to: 20140101000000/http://example.com/elsewhere')),
    'redirect target line printed'
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a re-run skips checkpointed captures (resumable)', async () => {
  const dir = makeLedger();
  const checkpoint = path.join(dir, 'cp.jsonl');

  const first = handlerFor();
  await run(['audit', dir, '--checkpoint', checkpoint, '--delay-ms', '0'], { handlers: { audit: first.handler }, out: l => first.out.push(l), error: () => {} });
  assert.equal(first.calls.length, 2);

  const second = handlerFor();
  await run(['audit', dir, '--checkpoint', checkpoint, '--delay-ms', '0'], { handlers: { audit: second.handler }, out: l => second.out.push(l), error: () => {} });
  assert.equal(second.calls.length, 0, 'both captures already checkpointed → nothing re-audited');
  assert.ok(second.out.some(l => l.includes('checkpointed: 2')));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses to run under CI (domain failure, exit 1)', async () => {
  const dir = makeLedger();
  const { handler } = handlerFor({ CI: 'true' });
  const code = await run(['audit', dir], { handlers: { audit: handler }, error: () => {} });
  assert.equal(code, EXIT.DOMAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing dir is a domain failure (exit 1)', async () => {
  const { handler } = handlerFor();
  const code = await run(['audit', '/no/such/ledger/dir'], { handlers: { audit: handler }, error: () => {} });
  assert.equal(code, EXIT.DOMAIN);
});

test('missing <dir> argument exits 2', async () => {
  const { handler } = handlerFor();
  assert.equal(await run(['audit'], { handlers: { audit: handler }, error: () => {} }), EXIT.USAGE);
});
