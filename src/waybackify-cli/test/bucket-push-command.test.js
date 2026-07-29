// `waybackify bucket push` handler — thin-wrapper wiring test. The batch emitter
// (spv/waybackify/bucket-batch.js) is covered by its own suite; here we prove
// the handler maps argv → emitBucketBatch() options, streams the batch to
// stdout (stderr under --dry-run), and always writes the summary to stderr.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { bucketPushHandler } from '../src/commands/bucket-push.js';

const BATCH = ['cp --content-type text/html --metadata status=body /c/cap/ab/h s3://b/cap/ab/h'];
const resultOf = (lines = BATCH, summary = { total: 1, bodied: 1, bodiless: 0 }) => ({ lines, summary });

function handlerFor(result) {
  const calls = [];
  const out = [];
  const err = [];
  const handler = bucketPushHandler({
    emitBucketBatch: async (root, options) => { calls.push({ root, options }); return result; },
    log: l => out.push(l),
    error: l => err.push(l)
  });
  return { handler, calls, out, err };
}

test('maps root + bucket + empty-file → emitBucketBatch()', async () => {
  const { handler, calls } = handlerFor(resultOf());
  assert.equal(
    await run(['bucket', 'push', '-r', '/c', '--bucket', 'b', '--empty-file', '/tmp/e'], { handlers: { bucketPush: handler }, error: () => {} }),
    EXIT.OK
  );
  assert.deepEqual(calls[0], { root: '/c', options: { bucket: 'b', emptyFile: '/tmp/e' } });
});

test('emptyFile defaults to null when --empty-file is absent', async () => {
  const { handler, calls } = handlerFor(resultOf());
  await run(['bucket', 'push', '-r', '/c', '--bucket', 'b'], { handlers: { bucketPush: handler }, error: () => {} });
  assert.equal(calls[0].options.emptyFile, null);
});

test('batch → stdout, summary → stderr by default', async () => {
  const { handler, out, err } = handlerFor(resultOf());
  await run(['bucket', 'push', '-r', '/c', '--bucket', 'b'], { handlers: { bucketPush: handler }, error: () => {} });
  assert.deepEqual(out, BATCH);
  assert.ok(err.some(l => l.includes('1 objects (1 bodied, 0 bodiless)')));
  assert.ok(!err.some(l => l.startsWith('cp ')), 'no batch on stderr in normal mode');
});

test('--dry-run diverts the batch to stderr; nothing on stdout', async () => {
  const { handler, out, err } = handlerFor(resultOf());
  await run(['bucket', 'push', '-r', '/c', '--bucket', 'b', '--dry-run'], { handlers: { bucketPush: handler }, error: () => {} });
  assert.deepEqual(out, [], 'stdout stays empty under --dry-run');
  assert.ok(err.some(l => l.startsWith('cp ')), 'the batch went to stderr');
  assert.ok(err.some(l => l.includes('dry-run, nothing written to stdout')));
});

test('a bad root/sidecar throw → domain exit 1', async () => {
  const handler = bucketPushHandler({
    emitBucketBatch: async () => { throw new Error('emit-bucket-batch: unparseable sidecar meta/ab/h.json'); },
    log: () => {},
    error: () => {}
  });
  assert.equal(await run(['bucket', 'push', '-r', '/c', '--bucket', 'b'], { handlers: { bucketPush: handler }, error: () => {} }), EXIT.DOMAIN);
});
