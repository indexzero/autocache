// `waybackify cache add` wiring tests — offline, library injected.
//
// The cache STORE (layout, write protocol, resume, requisites, the three
// debate edge cases) is tested where it lives: spv/waybackify/test/
// cache.test.js. This file pins the thin-wrapper contract only: argv payload
// → cacheCapture options, summary line on stdout, progress on stderr,
// failures → domain exit 1.
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

test('passes url, root, and requisites-by-default through to the library', async () => {
  const seen = {};
  const handler = cacheAddHandler({
    cacheCapture: async (url, options) => {
      seen.url = url;
      seen.options = options;
      return summaryOf({});
    },
    log: () => {},
    error: () => {}
  });

  assert.equal(await run(['cache', 'add', WB, '-o', '/tmp/cr'], { handlers: { cacheAdd: handler }, error: () => {} }), EXIT.OK);
  assert.equal(seen.url, WB);
  assert.equal(seen.options.root, '/tmp/cr');
  assert.equal(seen.options.requisites, true);

  await run(['cache', 'add', WB, '-o', '/tmp/cr', '--no-requisites'], { handlers: { cacheAdd: handler }, error: () => {} });
  assert.equal(seen.options.requisites, false);
});

test('--root|-r is canonical; -o is the deprecated alias', async () => {
  const seen = {};
  const handler = cacheAddHandler({
    cacheCapture: async (_url, options) => { seen.options = options; return summaryOf({}); },
    log: () => {},
    error: () => {}
  });
  await run(['cache', 'add', WB, '-r', '/canonical'], { handlers: { cacheAdd: handler }, error: () => {} });
  assert.equal(seen.options.root, '/canonical');
});

test('prints ONE JSON summary line on stdout, progress on stderr', async () => {
  const out = [];
  const err = [];
  const handler = cacheAddHandler({
    cacheCapture: async (_url, options) => {
      options.onEntry({ key: 'k1', hash: 'h1', status: 'body', action: 'fetched', flag: 'im_' });
      return summaryOf({ fetched: 2, skipped: 3 });
    },
    log: line => out.push(line),
    error: line => err.push(line)
  });

  assert.equal(await run(['cache', 'add', WB, '-o', '/tmp/cr'], { handlers: { cacheAdd: handler }, error: () => {} }), EXIT.OK);
  assert.equal(out.length, 1, 'exactly one stdout line');
  const summary = JSON.parse(out[0]);
  assert.deepEqual(summary, {
    key: '20111011002337/http://example.com/post',
    hash: 'ab'.repeat(32),
    root: '/tmp/cr',
    entries: 1,
    fetched: 2,
    skipped: 3,
    failed: 0
  });
  assert.ok(err.some(l => l.includes('im_') && l.includes('k1')), 'progress went to stderr');
});

test('requisite failures: summary still printed, then domain exit 1', async () => {
  const out = [];
  const err = [];
  const handler = cacheAddHandler({
    cacheCapture: async () => summaryOf({ failures: [{ key: 'k2', error: 'replay returned HTTP 503' }] }),
    log: line => out.push(line),
    error: line => err.push(line)
  });

  assert.equal(await run(['cache', 'add', WB, '-o', '/tmp/cr'], { handlers: { cacheAdd: handler }, error: () => {} }), EXIT.DOMAIN);
  assert.equal(JSON.parse(out[0]).failed, 1);
  assert.ok(err.some(l => l.includes('k2') && l.includes('503')));
});

test('library throws (bad URL, unreachable archive) → domain exit 1', async () => {
  const handler = cacheAddHandler({
    cacheCapture: async () => {
      throw new TypeError('cacheCapture: not a wayback replay URL: nope');
    },
    log: () => {},
    error: () => {}
  });
  assert.equal(await run(['cache', 'add', WB, '-o', '/tmp/cr'], { handlers: { cacheAdd: handler }, error: () => {} }), EXIT.DOMAIN);
});
