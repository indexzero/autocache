// `waybackify remaster verify` handler — thin front-door wiring test. The
// validator (waybackify-crawl/verify) is covered by its own suite; here we
// prove the handler delegates the parsed surface to runRemasterVerify(), maps
// the verdict to an exit code, and formats/JSONs the report — OFFLINE, via an
// injected fake engine (no crawl load, no browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { remasterVerifyHandler } from '../src/commands/remaster-verify.js';

/** Build a handler over a fake engine, capturing the options it receives. */
function handlerFor(report) {
  const calls = [];
  const out = [];
  const handler = remasterVerifyHandler({
    runRemasterVerify: async options => { calls.push(options); return report; },
    formatReport: () => 'VERIFY-REPORT',
    log: l => out.push(l),
    error: () => {}
  });
  return { handler, calls, out };
}

test('missing --root exits 2', async () => {
  const { handler } = handlerFor({ pass: true });
  assert.equal(await run(['remaster', 'verify'], { handlers: { remasterVerify: handler }, error: () => {} }), EXIT.USAGE);
});

test('delegates the parsed surface to runRemasterVerify() and passes clean (exit 0)', async () => {
  const { handler, calls, out } = handlerFor({ pass: true, layers: [] });
  const code = await run(
    ['remaster', 'verify', '-r', '/root', '--hermetic', '/h', '--tier', 'static,dynamic', '--sample', '2', '--no-determinism'],
    { handlers: { remasterVerify: handler }, error: () => {} }
  );
  assert.equal(code, EXIT.OK);
  assert.ok(out.includes('VERIFY-REPORT'));
  assert.equal(calls[0].root, '/root');
  assert.equal(calls[0].hermetic, '/h');
  assert.deepEqual(calls[0].tiers, ['static', 'dynamic']);
  assert.equal(calls[0].sample, 2);
  assert.equal(calls[0].skipDeterminism, true);
});

test('the default tier is static and determinism is NOT skipped', async () => {
  const { handler, calls } = handlerFor({ pass: true });
  await run(['remaster', 'verify', '-r', '/root'], { handlers: { remasterVerify: handler }, error: () => {} });
  assert.deepEqual(calls[0].tiers, ['static']);
  assert.equal(calls[0].skipDeterminism, false);
});

test('a finding is a domain failure (exit 1)', async () => {
  const { handler } = handlerFor({ pass: false });
  assert.equal(await run(['remaster', 'verify', '-r', '/root'], { handlers: { remasterVerify: handler }, error: () => {} }), EXIT.DOMAIN);
});

test('--json emits the raw report', async () => {
  const report = { pass: true, tool: 'remaster-verify', layers: [] };
  const { handler, out } = handlerFor(report);
  await run(['remaster', 'verify', '-r', '/root', '--json'], { handlers: { remasterVerify: handler }, error: () => {} });
  assert.deepEqual(JSON.parse(out[0]), report);
});

test('an invalid --tier is a usage error (exit 2)', async () => {
  const { handler } = handlerFor({ pass: true });
  assert.equal(await run(['remaster', 'verify', '-r', '/root', '--tier', 'sideways'], { handlers: { remasterVerify: handler }, error: () => {} }), EXIT.USAGE);
});
