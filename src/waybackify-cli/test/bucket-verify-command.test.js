// `waybackify bucket verify` handler — thin-wrapper wiring test. The parity
// engine (waybackify-verify) is covered by its own suite; here we prove
// the surface's required flags, the AWS-creds-from-env usage guard, and the
// verdict → exit-code mapping — all OFFLINE (an injected parity module, no
// network, no dispatcher install).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkpointPath } from '@autocache/waybackify-verify/verify-checkpoint';
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

// ---- where the engine loads from ------------------------------------------

test('the engine, the dispatcher, and the checkpoint store load from @autocache/waybackify-verify', () => {
  const engine = {
    '@autocache/waybackify-verify': 'parity.js',
    '@autocache/waybackify-verify/retry': 'retry.js',
    '@autocache/waybackify-verify/verify-checkpoint': 'verify-checkpoint.js'
  };
  for (const [specifier, file] of Object.entries(engine)) {
    assert.ok(import.meta.resolve(specifier).endsWith(`/waybackify-verify/dist/esm/${file}`), specifier);
  }
  const source = fs.readFileSync(new URL('../src/commands/bucket-verify.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /waybackify-serve/);
  for (const specifier of Object.keys(engine)) assert.ok(source.includes(`import('${specifier}')`), specifier);
});

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

// ---- resumable verification: the checkpoint file ---------------------

const TARGET_ARGS = ['--bucket', 'b', '--endpoint', 'http://x', '--prefix', 'orig'];
const TARGET = { endpoint: 'http://x', bucket: 'b', prefix: 'orig' };

/** The fake engine emits this checkpoint. The handler stores it verbatim. */
const EMITTED = { signature: 's', target: { ...TARGET }, sample: 3, passed: [], bodies: { verified: ['cap/aa/1'], healed: [] } };

/** A fake engine that emits one checkpoint, then answers `report`. */
function checkpointingParity(report, calls = []) {
  return {
    ...fakeParity(report, calls),
    runParityCheck: async options => {
      calls.push(options);
      await options.onCheckpoint?.(EMITTED);
      return report;
    }
  };
}

function verifyRun(root, extra, parity) {
  const handler = bucketVerifyHandler({ env: CREDS, parity });
  return run(['bucket', 'verify', '-r', root, ...TARGET_ARGS, ...extra], { handlers: { bucketVerify: handler }, logger: NOOP_LOGGER, out: () => {}, error: () => {} });
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bucket-verify-'));

test('a default run stores its checkpoint under <root>/.verify/ and does not resume', async () => {
  const root = tempRoot();
  const calls = [];
  const code = await verifyRun(root, [], checkpointingParity({ pass: false }, calls));
  assert.equal(code, EXIT.DOMAIN);
  assert.equal(calls[0].resume, undefined, 'the default is a full verify');
  assert.equal(typeof calls[0].onCheckpoint, 'function');
  // A failing run keeps its checkpoint for a later --resume.
  assert.deepEqual(JSON.parse(fs.readFileSync(checkpointPath(root, TARGET), 'utf8')), EMITTED);
});

test('a passing run removes its checkpoint', async () => {
  const root = tempRoot();
  const code = await verifyRun(root, [], checkpointingParity({ pass: true }));
  assert.equal(code, EXIT.OK);
  assert.equal(fs.existsSync(checkpointPath(root, TARGET)), false);
});

test('a PASS-DEGRADED report still exits 0 (the data is faithful)', async () => {
  const code = await verifyRun(tempRoot(), [], checkpointingParity({ pass: true, verdict: 'PASS-DEGRADED' }));
  assert.equal(code, EXIT.OK);
});

test('--resume hands the stored checkpoint to the engine', async () => {
  const root = tempRoot();
  await verifyRun(root, [], checkpointingParity({ pass: false }));
  const calls = [];
  await verifyRun(root, ['--resume', '--concurrency', '4'], checkpointingParity({ pass: false }, calls));
  assert.deepEqual(calls[0].resume, EMITTED);
  assert.equal(calls[0].concurrency, 4);
});

test('--resume with no stored checkpoint runs every layer in full', async () => {
  const calls = [];
  const code = await verifyRun(tempRoot(), ['--resume'], checkpointingParity({ pass: true }, calls));
  assert.equal(code, EXIT.OK);
  assert.equal(calls[0].resume, undefined);
});

test('--resume over a file that is not a checkpoint is a usage error (exit 2)', async () => {
  const root = tempRoot();
  const file = checkpointPath(root, TARGET);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"signature":1}');
  const calls = [];
  assert.equal(await verifyRun(root, ['--resume'], checkpointingParity({ pass: true }, calls)), EXIT.USAGE);
  assert.equal(calls.length, 0);
});

test('an explicit --layer runs exactly those layers: no checkpoint is read or written', async () => {
  const root = tempRoot();
  const calls = [];
  await verifyRun(root, ['--layer', '3'], checkpointingParity({ pass: false }, calls));
  assert.equal(calls[0].resume, undefined);
  assert.equal(calls[0].onCheckpoint, undefined);
  assert.equal(fs.existsSync(path.join(root, '.verify')), false);
});

test('--resume with --layer is a usage error (exit 2)', async () => {
  const calls = [];
  assert.equal(await verifyRun(tempRoot(), ['--resume', '--layer', '3'], checkpointingParity({ pass: true }, calls)), EXIT.USAGE);
  assert.equal(calls.length, 0);
});

test('a default run removes an old checkpoint before the engine reads the bucket', async () => {
  // Store a checkpoint that claims passed layers. Then start a default run
  // that stops before it records any progress. A later --resume must not find
  // the old verdicts, because the default run did not establish them.
  const root = tempRoot();
  await verifyRun(root, [], checkpointingParity({ pass: false }));
  const file = checkpointPath(root, TARGET);
  assert.equal(fs.existsSync(file), true);

  let seenAtStart;
  const interrupted = {
    ...fakeParity({ pass: true }),
    runParityCheck: async () => {
      seenAtStart = fs.existsSync(file);
      throw new Error('interrupted before the first request');
    }
  };
  assert.equal(await verifyRun(root, [], interrupted), EXIT.DOMAIN);
  assert.equal(seenAtStart, false, 'the old checkpoint was gone before the engine started');
  assert.equal(fs.existsSync(file), false);
});

test('a 240-byte --prefix stores and removes its checkpoint like any other target', async () => {
  // The checkpoint filename is a hash of the target, so a long prefix never
  // reaches the filesystem. An existing .verify/ directory is the case that
  // once failed with ENAMETOOLONG before the engine ran.
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.verify'));
  const prefix = 'archive/'.repeat(30);
  const target = { endpoint: 'http://x', bucket: 'b', prefix };
  const args = ['--bucket', 'b', '--endpoint', 'http://x', '--prefix', prefix];
  const runWith = (parity, calls) =>
    run(['bucket', 'verify', '-r', root, ...args], { handlers: { bucketVerify: bucketVerifyHandler({ env: CREDS, parity }) }, logger: NOOP_LOGGER, out: () => {}, error: () => {} });

  const calls = [];
  assert.equal(await runWith(checkpointingParity({ pass: false }, calls)), EXIT.DOMAIN);
  assert.equal(calls.length, 1, 'the engine ran');
  const file = checkpointPath(root, target);
  assert.match(path.basename(file), /^[0-9a-f]{32}\.json$/);
  assert.ok(fs.existsSync(file), 'the failing run kept its checkpoint');

  assert.equal(await runWith(checkpointingParity({ pass: true })), EXIT.OK);
  assert.equal(fs.existsSync(file), false, 'the passing run removed it');
});

test('a run that fails on a mismatch names the kept checkpoint file', async () => {
  const root = tempRoot();
  const infos = [];
  const logger = { ...NOOP_LOGGER, info: (obj, msg) => infos.push({ obj, msg }) };
  const handler = bucketVerifyHandler({ env: CREDS, parity: checkpointingParity({ pass: false }) });
  const code = await run(['bucket', 'verify', '-r', root, ...TARGET_ARGS], { handlers: { bucketVerify: handler }, logger, out: () => {}, error: () => {} });
  assert.equal(code, EXIT.DOMAIN);
  const kept = infos.find(line => line.obj?.evt === 'verify-checkpoint-kept');
  assert.ok(kept, 'the kept-checkpoint line was logged');
  assert.equal(kept.obj.path, checkpointPath(root, TARGET));
  assert.match(kept.msg, /--resume/);
});
