// `waybackify cache fill` handler — thin-wrapper wiring test. The load-bearing
// engine (spv/waybackify/backfill.js) is covered by its own unit + e2e suites;
// here we prove the handler maps argv → backfill() options, prints the one
// summary line, and turns an abort into a domain-failure throw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheFillHandler } from '../src/commands/cache-fill.js';

/** Run the handler with an injected library backfill(); capture its call + io. */
function run({ args, flags, result }) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const handler = cacheFillHandler({
    backfill: async opts => { calls.push(opts); return result; }
  });
  const push = (o, m) => stderr.push(typeof o === 'string' ? o : m);
  const logger = { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
  return { promise: handler({ args, flags, logger, out: l => stdout.push(l) }), calls, stdout, stderr };
}

const okResult = {
  worklist: { built: true, count: 3, path: '/c/.refetch/worklist.jsonl' },
  pending: 3, gone: 0, dryRun: false, aborted: false,
  stats: { attempted: 2, fetched: 2, cached: 1, deferred: 0, gone: 0 }
};

test('maps argv → backfill() options (numbers coerced, booleans set)', async () => {
  const { promise, calls } = run({
    args: { dir: 'words' },
    flags: { root: '/cache', delayMs: '250', abortAfter: '3', max: '10', refresh: true, dryRun: false },
    result: okResult
  });
  await promise;
  assert.equal(calls.length, 1);
  const o = calls[0];
  assert.equal(o.ledgerDir, 'words');
  assert.equal(o.root, '/cache');
  assert.equal(o.delayMs, 250);
  assert.equal(o.abortAfter, 3);
  assert.equal(o.max, 10);
  assert.equal(o.refresh, true);
  assert.equal(o.dryRun, false);
});

test('absent numeric flags fall back to the engine defaults', async () => {
  const { promise, calls } = run({ args: { dir: 'w' }, flags: { root: '/c' }, result: okResult });
  await promise;
  assert.equal(calls[0].delayMs, 1500);
  assert.equal(calls[0].abortAfter, 5);
  assert.equal(calls[0].max, Infinity);
});

test('prints exactly one JSON summary line on stdout', async () => {
  const { promise, stdout } = run({ args: { dir: 'w' }, flags: { root: '/c' }, result: okResult });
  await promise;
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    root: '/c', worklist: 3, pending: 3, dryRun: false,
    fetched: 2, cached: 1, deferred: 0, gone: 0, attempts: 2, aborted: false
  });
});

test('abort → throws (domain failure → exit 1), summary still printed', async () => {
  const aborted = { ...okResult, aborted: true, stats: { attempted: 5, fetched: 0, cached: 0, deferred: 5, gone: 0 } };
  const { promise, stdout } = run({ args: { dir: 'w' }, flags: { root: '/c' }, result: aborted });
  await assert.rejects(promise, /cache fill aborted: archive\.org unreachable/);
  assert.equal(JSON.parse(stdout[0]).aborted, true);
});

test('dry-run summary omits stats (no fetch happened)', async () => {
  const dry = { worklist: { built: true, count: 3, path: '/c/.refetch/worklist.jsonl' }, pending: 3, gone: 0, dryRun: true, aborted: false, stats: null };
  const { promise, stdout } = run({ args: { dir: 'w' }, flags: { root: '/c', dryRun: true }, result: dry });
  await promise;
  const line = JSON.parse(stdout[0]);
  assert.equal(line.dryRun, true);
  assert.equal(line.fetched, undefined);
});
