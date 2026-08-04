// `waybackify bucket verify` handler — thin-wrapper wiring test. The parity
// engine (waybackify-serve/parity) is covered by its own suite; here we prove
// the surface's required flags, the AWS-creds-from-env usage guard, and the
// verdict → exit-code mapping — all OFFLINE (an injected parity module, no
// network, no dispatcher install).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { bucketVerifyHandler } from '../src/commands/bucket-verify.js';

const CREDS = { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' };

/** A no-op logger for tests that never assert on the stderr progress stream. */
const NOOP_LOGGER = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };

/** A fake parity module the handler treats as the engine (skips the dispatcher). */
function fakeParity(report, calls = []) {
  return {
    runParityCheck: async options => { calls.push(options); return report; },
    formatReport: () => 'PARITY-REPORT',
    formatLayerVerdict: () => '',
    diagnoseFailure: () => 'diagnosed',
    DEFAULT_CONCURRENCY: 16
  };
}

// ---- required flags (validate() at parse time; handler never runs) ----------

test('missing --root exits 2', async () => {
  const handler = bucketVerifyHandler({ env: CREDS });
  assert.equal(await run(['bucket', 'verify', '--bucket', 'b', '--endpoint', 'http://x'], { handlers: { bucketVerify: handler }, error: () => {} }), EXIT.USAGE);
});

test('missing --bucket exits 2', async () => {
  const handler = bucketVerifyHandler({ env: CREDS });
  assert.equal(await run(['bucket', 'verify', '-r', '/c', '--endpoint', 'http://x'], { handlers: { bucketVerify: handler }, error: () => {} }), EXIT.USAGE);
});

test('missing --endpoint exits 2', async () => {
  const handler = bucketVerifyHandler({ env: CREDS });
  assert.equal(await run(['bucket', 'verify', '-r', '/c', '--bucket', 'b'], { handlers: { bucketVerify: handler }, error: () => {} }), EXIT.USAGE);
});

// ---- creds-from-env usage guard ---------------------------------------------

test('absent AWS creds are a usage error (exit 2), before any engine load', async () => {
  const calls = [];
  const handler = bucketVerifyHandler({ env: {}, parity: fakeParity({ pass: true }, calls) });
  const code = await run(['bucket', 'verify', '-r', '/c', '--bucket', 'b', '--endpoint', 'http://x'], { handlers: { bucketVerify: handler }, error: () => {} });
  assert.equal(code, EXIT.USAGE);
  assert.equal(calls.length, 0, 'the engine was never called');
});

// ---- verdict → exit code + delegation ---------------------------------------

test('a passing parity report exits 0 and prints the formatted report', async () => {
  const calls = [];
  const out = [];
  const handler = bucketVerifyHandler({ env: CREDS, parity: fakeParity({ pass: true }, calls) });
  const code = await run(
    ['bucket', 'verify', '-r', '/c', '--bucket', 'b', '--endpoint', 'http://x', '--region', 'auto', '--layer', '1,2', '--sample', '5', '--concurrency', '8'],
    { handlers: { bucketVerify: handler }, logger: NOOP_LOGGER, out: l => out.push(l), error: () => {} }
  );
  assert.equal(code, EXIT.OK);
  assert.ok(out.includes('PARITY-REPORT'));
  // The parsed surface reached the engine.
  assert.equal(calls[0].root, '/c');
  assert.equal(calls[0].bucket, 'b');
  assert.equal(calls[0].endpoint, 'http://x');
  assert.deepEqual(calls[0].layers, [1, 2]);
  assert.equal(calls[0].sample, 5);
  assert.equal(calls[0].concurrency, 8);
  assert.deepEqual(calls[0].credentials, { accessKeyId: 'AKID', secretAccessKey: 'secret' });
});

test('a failing parity report is a domain failure (exit 1)', async () => {
  const handler = bucketVerifyHandler({ env: CREDS, parity: fakeParity({ pass: false }) });
  const code = await run(['bucket', 'verify', '-r', '/c', '--bucket', 'b', '--endpoint', 'http://x'], { handlers: { bucketVerify: handler }, logger: NOOP_LOGGER, out: () => {}, error: () => {} });
  assert.equal(code, EXIT.DOMAIN);
});

test('--json emits the raw report', async () => {
  const out = [];
  const handler = bucketVerifyHandler({
    env: CREDS,
    parity: { ...fakeParity({ pass: true, layers: [] }), formatReport: () => 'HUMAN' }
  });
  await run(['bucket', 'verify', '-r', '/c', '--bucket', 'b', '--endpoint', 'http://x', '--json'], { handlers: { bucketVerify: handler }, logger: NOOP_LOGGER, out: l => out.push(l), error: () => {} });
  assert.deepEqual(JSON.parse(out[0]), { pass: true, layers: [] });
});

test('an invalid --layer is a usage error (exit 2)', async () => {
  const handler = bucketVerifyHandler({ env: CREDS, parity: fakeParity({ pass: true }) });
  const code = await run(['bucket', 'verify', '-r', '/c', '--bucket', 'b', '--endpoint', 'http://x', '--layer', '9'], { handlers: { bucketVerify: handler }, error: () => {} });
  assert.equal(code, EXIT.USAGE);
});
