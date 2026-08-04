// Regression guard for the §4 request/response trace format — the load-bearing
// surface. These assert the EXACT static-padded human line (URL always last,
// bounded fields constant-width) so a refactor that shifts a column fails loud.
// Colors are injected as `null` (the piped/non-TTY path) so the assertions are
// the plain padded text, byte-for-byte the §4 mock's reproducible rows.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatTrace, hhmmss, humanBytes, humanMs, normalizeType, makeLogger, parseLoggingFlags } from '../src/logger.js';

// A fixed wall-clock so the HH:MM:SS prefix is deterministic in the assertions.
const T = new Date(2020, 0, 1, 21, 57, 11).getTime();
const TS = hhmmss(T); // whatever this machine renders 21:57:11 as (local, stable in-process)

test('§4 request line — `> GET`, URL last, aligned to the response URL column', () => {
  const line = formatTrace(
    { evt: 'request', time: T, method: 'GET', url: 'https://web.archive.org/web/20050510075220/http://www.aa.com:80/' },
    null
  );
  assert.equal(
    line,
    `${TS}  > GET                         https://web.archive.org/web/20050510075220/http://www.aa.com:80/`
  );
  // The URL starts at a fixed column (30 past the HH:MM:SS + two spaces).
  assert.equal(line.indexOf('https://'), TS.length + 2 + 30);
});

test('§4 response — 200 doc: `< 200   14.2KB  html   412ms  <url>` (byte-exact mock row)', () => {
  const line = formatTrace(
    {
      evt: 'response',
      time: T,
      url: 'https://web.archive.org/web/20050510075220/http://www.aa.com:80/',
      status: 200,
      bytes: 14520,
      contentType: 'text/html',
      ms: 412
    },
    null
  );
  assert.equal(
    line,
    `${TS}  < 200   14.2KB  html   412ms  https://web.archive.org/web/20050510075220/http://www.aa.com:80/`
  );
});

test('§4 response — 200 gif requisite (byte-exact mock row)', () => {
  const line = formatTrace(
    {
      evt: 'response',
      time: T,
      url: 'https://web.archive.org/web/20050510075220im_/http://www.aa.com:80/images/aa_logo.gif',
      status: 200,
      bytes: 3174,
      contentType: 'image/gif',
      ms: 94
    },
    null
  );
  assert.equal(
    line,
    `${TS}  < 200    3.1KB  gif     94ms  https://web.archive.org/web/20050510075220im_/http://www.aa.com:80/images/aa_logo.gif`
  );
});

test('§4 response — 404 requisite: `0B`, type `—`, trailing note (byte-exact mock row)', () => {
  const line = formatTrace(
    {
      evt: 'response',
      time: T,
      url: 'https://web.archive.org/web/20050510075220im_/http://www.aa.com:80/images/promo.gif',
      status: 404,
      bytes: 0,
      ms: 120,
      note: 'gone → terminal sidecar'
    },
    null
  );
  assert.equal(
    line,
    `${TS}  < 404       0B  —      120ms  https://web.archive.org/web/20050510075220im_/http://www.aa.com:80/images/promo.gif  gone → terminal sidecar`
  );
});

test('§4 response — 429 mid-retry: bodiless `—`/`—`, `>6` ms, trailing note', () => {
  const line = formatTrace(
    { evt: 'response', time: T, url: 'https://web.archive.org/web/x/http://slow.example/', status: 429, ms: 87, note: 'retry 1/5, backoff 400ms' },
    null
  );
  // The bounded `—` markers right-align per the `>7`/`>6` spec (the mock's
  // truncated em-dash rows are hand-approximations; the byte-exact 200/404 rows
  // above are the alignment ground truth).
  assert.equal(
    line,
    `${TS}  < 429        —  —       87ms  https://web.archive.org/web/x/http://slow.example/  retry 1/5, backoff 400ms`
  );
});

test('§4 response — ERR give-up: status `ERR`, all bodiless, ms `—`, trailing note', () => {
  const line = formatTrace(
    {
      evt: 'response',
      time: T,
      url: 'https://web.archive.org/web/x/http://x.example/',
      error: 'ECONNRESET',
      outcome: 'failed',
      note: 'ECONNRESET · gave up after 5 attempts'
    },
    null
  );
  assert.equal(
    line,
    `${TS}  < ERR        —  —          —  https://web.archive.org/web/x/http://x.example/  ECONNRESET · gave up after 5 attempts`
  );
});

test('the URL is ALWAYS last — every column before it is constant-width', () => {
  // Two responses with wildly different bounded fields land their URL at the
  // SAME column (only the trailing note, if any, follows the URL).
  const a = formatTrace({ evt: 'response', time: T, url: 'AAA', status: 200, bytes: 14520, contentType: 'text/html', ms: 412 }, null);
  const b = formatTrace({ evt: 'response', time: T, url: 'BBB', status: 404, bytes: 0, ms: 5, note: 'x' }, null);
  assert.equal(a.indexOf('AAA'), b.indexOf('BBB'));
});

test('humanBytes / humanMs / normalizeType', () => {
  assert.equal(humanBytes(14520), '14.2KB');
  assert.equal(humanBytes(3174), '3.1KB');
  assert.equal(humanBytes(0), '0B');
  assert.equal(humanBytes(null), '—');
  assert.equal(humanBytes(undefined), '—');
  assert.equal(humanBytes(1024 * 1024 * 3.5), '3.5MB');
  assert.equal(humanMs(412), '412ms');
  assert.equal(humanMs(1400), '1.4s');
  assert.equal(humanMs(null), '—');
  assert.equal(normalizeType('text/html; charset=utf-8'), 'html');
  assert.equal(normalizeType('image/gif'), 'gif');
  assert.equal(normalizeType('application/json'), 'json');
  assert.equal(normalizeType('application/octet-stream'), '—');
  assert.equal(normalizeType(''), '—');
  assert.equal(normalizeType(undefined), '—');
});

test('makeLogger({ level: "silent" }) emits nothing but satisfies the interface', () => {
  const log = makeLogger({ level: 'silent' });
  // Must not throw; must be a no-op logger with the full method set.
  for (const m of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    assert.equal(typeof log[m], 'function');
    log[m]({ evt: 'response' }, 'nothing');
  }
});

test('parseLoggingFlags — the verbosity knobs, and --json/LOG_LEVEL orthogonality', () => {
  // Default progress throttle is 500 (env WAYBACKIFY_PROGRESS_EVERY overrides).
  const D = 500;
  // -v/-vv/-q/--silent map to levels; the flags are STRIPPED from argv.
  assert.deepEqual(parseLoggingFlags(['check', 'x']), { level: undefined, logFile: undefined, progressEvery: D, argv: ['check', 'x'] });
  assert.deepEqual(parseLoggingFlags(['-v', 'check', 'x']), { level: 'debug', logFile: undefined, progressEvery: D, argv: ['check', 'x'] });
  assert.deepEqual(parseLoggingFlags(['-vv', 'check']), { level: 'trace', logFile: undefined, progressEvery: D, argv: ['check'] });
  assert.deepEqual(parseLoggingFlags(['-v', '-v', 'check']), { level: 'trace', logFile: undefined, progressEvery: D, argv: ['check'] }); // stacking
  assert.deepEqual(parseLoggingFlags(['-q', 'check']), { level: 'warn', logFile: undefined, progressEvery: D, argv: ['check'] });
  assert.deepEqual(parseLoggingFlags(['--silent', 'check']), { level: 'silent', logFile: undefined, progressEvery: D, argv: ['check'] });
  // --silent wins over -q wins over -v.
  assert.equal(parseLoggingFlags(['--silent', '-q', '-v']).level, 'silent');
  assert.equal(parseLoggingFlags(['-q', '-v']).level, 'warn');
  // --log-file consumes its value (space form and =form); it is removed from argv.
  assert.deepEqual(parseLoggingFlags(['cache', 'add', '--log-file', '/tmp/w.jsonl', 'url']), {
    level: undefined,
    logFile: '/tmp/w.jsonl',
    progressEvery: D,
    argv: ['cache', 'add', 'url']
  });
  assert.equal(parseLoggingFlags(['--log-file=/tmp/w.jsonl']).logFile, '/tmp/w.jsonl');
  // --progress-every consumes its value (space + =form) and is stripped from argv.
  const pe = parseLoggingFlags(['cache', 'verify', '--progress-every', '25', '-r', '/c']);
  assert.equal(pe.progressEvery, 25);
  assert.deepEqual(pe.argv, ['cache', 'verify', '-r', '/c']);
  assert.equal(parseLoggingFlags(['--progress-every=10']).progressEvery, 10);
  // A non-positive/garbage throttle disables it (0 = off).
  assert.equal(parseLoggingFlags(['--progress-every', '0']).progressEvery, 0);
  assert.equal(parseLoggingFlags(['--progress-every', 'nope']).progressEvery, 0);
  // --json is orthogonal: it passes THROUGH to the command (logger still runs).
  assert.deepEqual(parseLoggingFlags(['cache', 'verify', '--json']).argv, ['cache', 'verify', '--json']);
  // A value flag never swallows a FOLLOWING flag as its value.
  const g = parseLoggingFlags(['--log-file', '--silent', 'check']);
  assert.equal(g.logFile, undefined, '--log-file did not eat --silent as a filename');
  assert.equal(g.level, 'silent', '--silent still took effect');
  assert.deepEqual(g.argv, ['check']);
});

test('level filtering — the file sink captures MORE than the terminal level', () => {
  // Human stream at `warn`, file stream always at `trace`: a debug/info/trace
  // record is filtered from the terminal but MUST land in the file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-log-'));
  const logFile = path.join(dir, 'sub', 'waybackify.jsonl'); // mkdir:true creates `sub/`
  const log = makeLogger({ logFile, level: 'warn' });
  log.trace({ evt: 'x' }, 'a trace record');
  log.debug({ evt: 'x' }, 'a debug record');
  log.info({ evt: 'x' }, 'an info record');
  log.warn({ evt: 'x' }, 'a warn record');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const levels = lines.map(l => l.level).sort((a, b) => a - b);
  assert.deepEqual(levels, [10, 20, 30, 40], 'file (trace) holds every record the warn terminal dropped');
  // base:undefined dropped pid/hostname; the record keeps its fields + msg.
  assert.equal(lines[0].pid, undefined);
  assert.equal(lines[0].hostname, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
