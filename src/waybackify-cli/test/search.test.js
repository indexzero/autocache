// `waybackify search` wiring tests — offline, library face injected.
//
// The CDX query (retry/backoff, params, row decoding) is tested where it
// lives: spv/waybackify. This file pins the thin-wrapper contract only —
// argv payload → getSnapshots options, JSONL row shape on stdout, --limit
// caps rows, --near forwarded verbatim, empty = exit 0 / empty stdout,
// failure = stderr + domain exit 1.
//
// One WAYBACK_LIVE=1 smoke drives the real bin end-to-end and proves the
// `search --limit 3 | jq -r .waybackUrl` composability shape.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXIT, run } from '../src/cli.js';
import { searchHandler } from '../src/commands/search.js';

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/waybackify.js', import.meta.url));
const URL_UNDER_TEST = 'http://example.com/';

// Canned getSnapshots rows in the library's returned shape (the four contract
// fields plus the siblings getSnapshots also carries — url/digest/length).
const capture = (timestamp, statuscode, mimetype) => ({
  timestamp,
  url: URL_UNDER_TEST,
  mimetype,
  statuscode,
  digest: 'D'.repeat(32),
  length: '512',
  waybackUrl: `https://web.archive.org/web/${timestamp}/${URL_UNDER_TEST}`
});

const CANNED = [
  capture('20140403040000', '200', 'text/html'),
  capture('20160512120000', '200', 'text/html'),
  capture('20180101000000', '404', 'text/html'),
  capture('20200620093000', '200', 'text/html'),
  capture('20220815154500', '301', 'text/html')
];

test('emits one JSONL row per capture in the exact contract shape', async () => {
  const out = [];
  const handler = searchHandler({
    getSnapshots: async () => CANNED.slice(0, 2),
    log: line => out.push(line)
  });

  const code = await run(['search', URL_UNDER_TEST], { handlers: { search: handler }, error: () => {} });
  assert.equal(code, EXIT.OK);
  assert.equal(out.length, 2);
  assert.deepEqual(JSON.parse(out[0]), {
    timestamp: '20140403040000',
    statuscode: '200',
    mimetype: 'text/html',
    waybackUrl: 'https://web.archive.org/web/20140403040000/http://example.com/'
  });
  // Only the four contract keys — no digest/length/url leakage.
  assert.deepEqual(Object.keys(JSON.parse(out[1])), ['timestamp', 'statuscode', 'mimetype', 'waybackUrl']);
});

test('--limit caps the emitted rows', async () => {
  const out = [];
  const handler = searchHandler({
    // Return ALL five even though --limit 3 is asked, so the cap is proven to
    // be enforced by the wiring, not merely by the query.
    getSnapshots: async () => CANNED,
    log: line => out.push(line)
  });

  const code = await run(['search', URL_UNDER_TEST, '--limit', '3'], { handlers: { search: handler }, error: () => {} });
  assert.equal(code, EXIT.OK);
  assert.equal(out.length, 3);
});

test('--near is forwarded verbatim into the query options', async () => {
  const seen = {};
  const handler = searchHandler({
    getSnapshots: async (url, opts) => {
      seen.url = url;
      seen.opts = opts;
      return [];
    },
    log: () => {}
  });

  await run(['search', URL_UNDER_TEST, '--near', '20140403040000', '--limit', '5'], {
    handlers: { search: handler },
    error: () => {}
  });
  assert.equal(seen.url, URL_UNDER_TEST);
  assert.equal(seen.opts.near, '20140403040000');
  assert.equal(seen.opts.limit, 5);
});

test('zero captures → empty stdout, exit 0 (absence is an answer)', async () => {
  const out = [];
  const handler = searchHandler({
    getSnapshots: async () => [],
    log: line => out.push(line)
  });

  const code = await run(['search', URL_UNDER_TEST], { handlers: { search: handler }, error: () => {} });
  assert.equal(code, EXIT.OK);
  assert.equal(out.length, 0);
});

test('network/CDX failure → message on stderr, domain exit 1', async () => {
  const err = [];
  const handler = searchHandler({
    getSnapshots: async () => {
      throw new Error('waybackify: lookup failed for http://example.com/');
    },
    log: () => {}
  });

  const code = await run(['search', URL_UNDER_TEST], { handlers: { search: handler }, error: line => err.push(line) });
  assert.equal(code, EXIT.DOMAIN);
  assert.ok(err.some(l => l.includes('lookup failed')), 'failure message reached stderr');
});

// Live smoke: gated behind WAYBACK_LIVE=1 (opt-in, hits the Internet Archive).
// Drives the REAL bin — bin → run → searchHandler → WaybackMachine#getSnapshots
// — and validates the `search --limit 3 | jq -r .waybackUrl` shape: every
// stdout line is a JSON object whose .waybackUrl (what `jq -r .waybackUrl`
// would emit) is a canonical web.archive.org replay URL.
test('WAYBACK_LIVE smoke: real CDX query, composable JSONL', { skip: process.env.WAYBACK_LIVE !== '1' }, async () => {
  const { stdout } = await execFileAsync('node', [BIN, 'search', 'http://example.com', '--limit', '3']);
  const lines = stdout.split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 3, `expected 1..3 rows, got ${lines.length}`);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row), ['timestamp', 'statuscode', 'mimetype', 'waybackUrl']);
    // The `jq -r .waybackUrl` projection: each must be a usable replay URL.
    assert.match(row.waybackUrl, /^https:\/\/web\.archive\.org\/web\/\d{14}\//);
  }
});
