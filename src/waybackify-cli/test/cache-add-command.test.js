// `waybackify cache add` wiring tests — offline, library injected.
//
// The cache STORE (layout, write protocol, resume, requisites, the three
// debate edge cases) is tested where it lives: spv/waybackify/test/
// cache.test.js. This file pins the thin-wrapper contract only: argv payload
// → cacheCapture options, the one summary line on the run()-wired `out` seam
// (stdout), progress + failures through the injected logger, failures → domain
// exit 1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { cacheAddHandler } from '../src/commands/cache-add.js';

const WB = 'https://web.archive.org/web/20111011002337/http://example.com/post';

const summaryOf = over => ({
  key: '20111011002337/http://example.com/post',
  hash: 'ab'.repeat(32),
  root: '/tmp/cr',
  entries: [{ key: 'k1', hash: 'h1', status: 'body', action: 'fetched', flag: null }],
  fetched: 1,
  skipped: 0,
  failures: [],
  ...over
});

// A logger that records every (obj, msg) call as one merged record, so a test
// asserts on the STRUCTURED fields (evt/key/flag) without a real pino/stderr.
// Duck-typed to the injected-logger contract.
function recordingLogger() {
  const lines = [];
  const rec = (obj, msg) => lines.push(typeof obj === 'string' ? { msg: obj } : { ...obj, msg });
  return { lines, trace: rec, debug: rec, info: rec, warn: rec, error: rec, fatal: rec };
}

test('passes url, root, and requisites-by-default through to the library', async () => {
  const seen = {};
  const handler = cacheAddHandler({
    cacheCapture: async (url, options) => { seen.url = url; seen.options = options; return summaryOf({}); }
  });

  const code = await run(['cache', 'add', WB, '-o', '/tmp/cr'],
    { handlers: { cacheAdd: handler }, logger: recordingLogger(), out: () => {}, error: () => {} });
  assert.equal(code, EXIT.OK);
  assert.equal(seen.url, WB);
  assert.equal(seen.options.root, '/tmp/cr');
  assert.equal(seen.options.requisites, true);

  await run(['cache', 'add', WB, '-o', '/tmp/cr', '--no-requisites'],
    { handlers: { cacheAdd: handler }, logger: recordingLogger(), out: () => {}, error: () => {} });
  assert.equal(seen.options.requisites, false);
});

test('--root|-r is canonical; -o is the deprecated alias', async () => {
  const seen = {};
  const handler = cacheAddHandler({
    cacheCapture: async (_url, options) => { seen.options = options; return summaryOf({}); }
  });
  await run(['cache', 'add', WB, '-r', '/canonical'],
    { handlers: { cacheAdd: handler }, logger: recordingLogger(), out: () => {}, error: () => {} });
  assert.equal(seen.options.root, '/canonical');
});

test('prints ONE JSON summary line on stdout, progress through the logger', async () => {
  const logger = recordingLogger();
  const handler = cacheAddHandler({
    cacheCapture: async (_url, options) => {
      options.onEntry({ key: 'k1', hash: 'h1', status: 'body', action: 'fetched', flag: 'im_' });
      return summaryOf({ fetched: 2, skipped: 3 });
    }
  });

  const out = [];
  const code = await run(['cache', 'add', WB, '-o', '/tmp/cr'],
    { handlers: { cacheAdd: handler }, logger, out: l => out.push(l), error: () => {} });
  assert.equal(code, EXIT.OK);

  assert.equal(out.length, 1, 'exactly one stdout line');
  assert.deepEqual(JSON.parse(out[0]), {
    key: '20111011002337/http://example.com/post',
    hash: 'ab'.repeat(32),
    root: '/tmp/cr',
    entries: 1,
    fetched: 2,
    skipped: 3,
    failed: 0
  });
  assert.ok(
    logger.lines.some(l => l.evt === 'cache-entry' && l.flag === 'im_' && l.key === 'k1'),
    'progress went to the logger as a structured cache-entry record'
  );
});

test('requisite failures: summary still printed, then domain exit 1', async () => {
  const logger = recordingLogger();
  const handler = cacheAddHandler({
    cacheCapture: async () => summaryOf({ failures: [{ key: 'k2', error: 'replay returned HTTP 503' }] })
  });

  const out = [];
  const code = await run(['cache', 'add', WB, '-o', '/tmp/cr'],
    { handlers: { cacheAdd: handler }, logger, out: l => out.push(l), error: () => {} });
  assert.equal(code, EXIT.DOMAIN);
  assert.equal(JSON.parse(out[0]).failed, 1);
  assert.ok(logger.lines.some(l => l.key === 'k2' && l.error?.includes('503')));
});

test('library throws (bad URL, unreachable archive) → domain exit 1', async () => {
  const handler = cacheAddHandler({
    cacheCapture: async () => { throw new TypeError('cacheCapture: not a wayback replay URL: nope'); }
  });
  const code = await run(['cache', 'add', WB, '-o', '/tmp/cr'],
    { handlers: { cacheAdd: handler }, logger: recordingLogger(), out: () => {}, error: () => {} });
  assert.equal(code, EXIT.DOMAIN);
});
