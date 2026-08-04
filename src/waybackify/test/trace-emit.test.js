// The §4 request/response trace EMISSION — the library produces the structured
// records the CLI renders. Complements waybackify-cli/test/logger.test.js (which
// pins the padded human lines): here we assert the FIELDS the emitters attach
// (evt/status/bytes/contentType/attempt/note), injecting a capture logger.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WaybackMachine } from '../index.js';
import { cacheCapture } from '../cache.js';
import { fsck } from '../fsck.js';

/** A logger that records every (level, obj, msg) call. */
function captureLogger() {
  const calls = [];
  const mk = level => (obj, msg) => calls.push({ level, ...obj, msg });
  return { calls, trace: mk('trace'), debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal') };
}

/** A minimal fetch Response over a byte body. */
function res(status, contentType, body = '') {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? contentType : null) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return body;
    }
  };
}

test('WaybackMachine #cdxRows — 429 retries warn, final give-up is error (the §4 ERR row)', async () => {
  const log = captureLogger();
  let n = 0;
  const impit = {
    async fetch() {
      n++;
      if (n < 3) return res(429, 'text/html', 'slow down');
      throw new Error('ECONNRESET');
    }
  };
  const wb = new WaybackMachine({ impit, maxAttempts: 3, logger: log });
  await assert.rejects(() => wb.getCapture('http://x.example/', '20090106000000'));

  const requests = log.calls.filter(c => c.evt === 'request');
  const responses = log.calls.filter(c => c.evt === 'response');
  assert.equal(requests.length, 3, 'one request per attempt');
  assert.ok(requests.every(r => r.method === 'GET'));
  // Attempts 1 & 2 are 429 mid-retry warns with a backoff note; attempt 3 is the
  // give-up error (status null, outcome failed).
  const retries = responses.filter(r => r.level === 'warn');
  assert.equal(retries.length, 2);
  assert.equal(retries[0].status, 429);
  assert.match(retries[0].note, /retry 1\/3, backoff 400ms/);
  assert.match(retries[1].note, /retry 2\/3, backoff 800ms/);
  const giveUp = responses.find(r => r.level === 'error');
  assert.equal(giveUp.status, null);
  assert.equal(giveUp.outcome, 'failed');
  assert.match(giveUp.note, /ECONNRESET · gave up after 3 attempts/);
});

test('cacheCapture — doc 200 (info + requisites count), requisite 200 (info), requisite 404 (warn, gone)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-trace-'));
  const log = captureLogger();
  // A doc that references one image requisite; that requisite 404s.
  const docHtml = '<img src="/web/20050510075220im_/http://www.aa.com:80/images/promo.gif">';
  const fetchImpl = async url => {
    if (url.endsWith('/http://www.aa.com:80/')) return res(200, 'text/html', docHtml);
    if (url.includes('promo.gif')) return res(404, 'text/html', '');
    return res(200, 'application/octet-stream', 'x');
  };
  await cacheCapture('https://web.archive.org/web/20050510075220/http://www.aa.com:80/', { root, fetch: fetchImpl, logger: log });

  const responses = log.calls.filter(c => c.evt === 'response');
  const doc = responses.find(r => r.status === 200 && r.key.endsWith('/http://www.aa.com:80/'));
  assert.equal(doc.level, 'info');
  assert.equal(doc.contentType, 'text/html');
  assert.equal(doc.bytes, new TextEncoder().encode(docHtml).length);
  assert.equal(doc.requisites, 1, 'doc response carries the requisite edge count');

  const gone = responses.find(r => r.status === 404);
  assert.equal(gone.level, 'warn', 'a gone requisite is a notable incompleteness (warn)');
  assert.equal(gone.bytes, 0);
  assert.match(gone.note, /gone → terminal sidecar/);

  await fs.rm(root, { recursive: true, force: true });
});

test('cacheCapture — a named-doc TRANSPORT throw pairs the request with an ERR response, then rethrows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-throw-'));
  const log = captureLogger();
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => cacheCapture('https://web.archive.org/web/20050510075220/http://www.aa.com:80/', { root, fetch: fetchImpl, logger: log }));
  const req = log.calls.find(c => c.evt === 'request');
  const resp = log.calls.find(c => c.evt === 'response');
  assert.ok(req, 'the request event fired');
  assert.ok(resp, 'the transport throw still emitted a response event (pairing preserved)');
  assert.equal(resp.level, 'error');
  assert.equal(resp.status, null);
  assert.equal(resp.outcome, 'failed');
  assert.match(resp.error, /ECONNRESET/);
  await fs.rm(root, { recursive: true, force: true });
});

test('silent-loop progress — fsck emits a throttled aggregate every N (§6)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prog-'));
  const log = captureLogger();
  // Populate a small root: a doc + one 200 requisite → 2 sidecars.
  const docHtml = '<img src="/web/20050510075220im_/http://www.aa.com:80/a.gif">';
  const fetchImpl = async url => (url.includes('a.gif') ? res(200, 'image/gif', 'GIFDATA') : res(200, 'text/html', docHtml));
  await cacheCapture('https://web.archive.org/web/20050510075220/http://www.aa.com:80/', { root, fetch: fetchImpl });

  // progressEvery: 0 → silent (the pre-§6 behavior).
  const silent = captureLogger();
  await fsck(root, { logger: silent, progressEvery: 0 });
  assert.equal(silent.calls.filter(c => c.evt === 'fsck-progress').length, 0, 'progressEvery 0 stays silent');

  // progressEvery: 1 → one aggregate per sidecar, with {done,total}.
  await fsck(root, { logger: log, progressEvery: 1 });
  const progress = log.calls.filter(c => c.evt === 'fsck-progress');
  assert.equal(progress.length, 2, 'two sidecars → two throttled emissions at N=1');
  assert.equal(progress[0].done, 1);
  assert.equal(progress[1].done, 2);
  assert.equal(progress[0].total, 2);

  await fs.rm(root, { recursive: true, force: true });
});
