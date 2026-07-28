// `waybackify cache remaster` handler — thin-wrapper wiring test. The build
// engine (spv/waybackify/remaster.js) is covered by its own suite; here we
// prove the handler maps the two positional roots → remaster(), prints the
// summary (--json for the raw record), and lets a build throw become exit 1.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { cacheRemasterHandler } from '../src/commands/cache-remaster.js';

const reportOf = () => ({
  hermeticRoot: path.resolve('/h'),
  remasteredRoot: path.resolve('/o'),
  sidecars: 7,
  bodies: 4,
  rewritten: 2,
  buildPath: path.resolve('/o', 'remaster.build.json'),
  build: { ruleVersion: 3, engineVersion: 1, v: 1, entries: [] }
});

function handlerFor(report) {
  const calls = [];
  const out = [];
  const handler = cacheRemasterHandler({
    remaster: async (h, r) => { calls.push({ h, r }); return report; },
    log: l => out.push(l)
  });
  return { handler, calls, out };
}

test('maps the two positional roots → remaster(), resolved to absolute', async () => {
  const { handler, calls } = handlerFor(reportOf());
  assert.equal(await run(['cache', 'remaster', '/h', '/o'], { handlers: { cacheRemaster: handler }, error: () => {} }), EXIT.OK);
  assert.equal(calls[0].h, path.resolve('/h'));
  assert.equal(calls[0].r, path.resolve('/o'));
});

test('prints a human summary line by default', async () => {
  const { handler, out } = handlerFor(reportOf());
  await run(['cache', 'remaster', '/h', '/o'], { handlers: { cacheRemaster: handler }, error: () => {} });
  assert.ok(out.some(l => l.includes('7 sidecars')));
  assert.ok(out.some(l => l.includes('remaster.build.json')));
});

test('--json emits the raw run record', async () => {
  const report = reportOf();
  const { handler, out } = handlerFor(report);
  await run(['cache', 'remaster', '/h', '/o', '--json'], { handlers: { cacheRemaster: handler }, error: () => {} });
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), report);
});

test('a build throw → domain exit 1', async () => {
  const handler = cacheRemasterHandler({
    remaster: async () => { throw new Error('remaster: unsupported sidecar version 99'); },
    log: () => {}
  });
  assert.equal(await run(['cache', 'remaster', '/h', '/o'], { handlers: { cacheRemaster: handler }, error: () => {} }), EXIT.DOMAIN);
});
