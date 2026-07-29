import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRequests, isCspViolation } from '../src/probe.js';

const ORIGIN = 'http://127.0.0.1:5000';
const corpus = new Set(['20200101000000/https://cdn.example.com/have.css']);

test('a local capture path in the corpus is a hit, not a leak', () => {
  const r = classifyRequests(
    [{ url: `${ORIGIN}/web/20200101000000/https://cdn.example.com/have.css`, resourceType: 'stylesheet' }],
    corpus,
    ORIGIN
  );
  assert.equal(r.dangling.length, 0);
  assert.equal(r.nonLocal.length, 0);
  assert.equal(r.requests[0].corpus, 'hit');
});

test('a local capture path NOT in the corpus is dangling-local, carrying its resourceType', () => {
  const r = classifyRequests(
    [{ url: `${ORIGIN}/web/20200101000000/https://cdn.example.com/miss.css`, resourceType: 'stylesheet' }],
    corpus,
    ORIGIN
  );
  assert.equal(r.dangling.length, 1);
  assert.equal(r.dangling[0].resourceType, 'stylesheet');
});

test('a non-local origin is a non-local request, carrying its resourceType', () => {
  const r = classifyRequests([{ url: 'https://www.google-analytics.com/ga.js', resourceType: 'script' }], corpus, ORIGIN);
  assert.equal(r.nonLocal.length, 1);
  assert.equal(r.nonLocal[0].resourceType, 'script');
  assert.equal(r.dangling.length, 0);
});

test('a non-capture local path (favicon) is browser noise, never a leak', () => {
  const r = classifyRequests([{ url: `${ORIGIN}/favicon.ico`, resourceType: 'other' }], corpus, ORIGIN);
  assert.equal(r.dangling.length, 0);
  assert.equal(r.nonLocal.length, 0);
  assert.equal(r.requests[0].corpus, 'n/a');
});

test('data:/blob: schemes are inert and skipped', () => {
  const r = classifyRequests(
    [
      { url: 'data:image/png;base64,AAAA', resourceType: 'image' },
      { url: 'blob:http://x/abc', resourceType: 'other' }
    ],
    corpus,
    ORIGIN
  );
  assert.equal(r.requests.length, 0);
  assert.equal(r.dangling.length, 0);
  assert.equal(r.nonLocal.length, 0);
});

test('an egress-capable non-http scheme (wss:) is NOT dropped — it lands in non-local; data: still inert', () => {
  const r = classifyRequests(
    [
      { url: 'wss://web.archive.org/web/20200101000000/https://ex.com/live', resourceType: 'websocket' },
      { url: 'data:image/png;base64,AAAA', resourceType: 'image' }
    ],
    corpus,
    ORIGIN
  );
  // wss:// archive egress must be visible (reverting the inert-allowlist fix
  // silently drops it → this assertion fails).
  assert.equal(r.nonLocal.length, 1);
  assert.equal(r.nonLocal[0].url, 'wss://web.archive.org/web/20200101000000/https://ex.com/live');
  // the data: URL is genuinely inert and still skipped.
  assert.ok(!r.requests.some(x => x.url.startsWith('data:')));
  assert.equal(r.dangling.length, 0);
});

test('isCspViolation recognizes report-only violation phrasing', () => {
  assert.ok(isCspViolation("Refused to load the stylesheet 'https://x/y.css' because it violates the Content Security Policy"));
  assert.ok(isCspViolation('[Report Only] Refused to connect to https://x'));
  assert.equal(isCspViolation('a normal console log'), false);
});
