import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferFlag, mapFindings } from '../src/mapkeys.js';

const now = () => '2026-07-29T00:00:00.000Z';

test('inferFlag keeps a raw-byte own flag', () => {
  assert.equal(inferFlag('im_', 'script'), 'im_'); // own raw flag wins over type
  assert.equal(inferFlag('cs_', undefined), 'cs_');
});

test('inferFlag ignores a framing flag and infers from resource type', () => {
  assert.equal(inferFlag('if_', 'stylesheet'), 'cs_');
  assert.equal(inferFlag('id_', 'script'), 'js_');
});

test('inferFlag infers from resource type when no flag', () => {
  assert.equal(inferFlag(null, 'stylesheet'), 'cs_');
  assert.equal(inferFlag(undefined, 'script'), 'js_');
  assert.equal(inferFlag(undefined, 'image'), 'im_');
  assert.equal(inferFlag(undefined, 'font'), 'oe_');
  assert.equal(inferFlag(undefined, 'fetch'), 'oe_'); // else → oe_
  assert.equal(inferFlag(undefined, undefined), 'oe_');
});

test('dangling-local: a full local URL maps to a captureKey via the serving parser', () => {
  const { entries } = mapFindings(
    { dangling: [{ url: 'http://127.0.0.1:5000/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'stylesheet' }] },
    { now }
  );
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    key: '20200101000000/https://cdn.example.com/a.css',
    flag: 'cs_',
    via: 'remaster-verify',
    firstSeen: now()
  });
});

test('dangling-local: a bare /web path (no host) still maps', () => {
  const { entries } = mapFindings(
    { dangling: [{ url: '/web/20200101000000/https://cdn.example.com/a.js', resourceType: 'script' }] },
    { now }
  );
  assert.equal(entries[0].key, '20200101000000/https://cdn.example.com/a.js');
  assert.equal(entries[0].flag, 'js_');
});

test('non-local: a foreign web.archive.org wayback URL is a MISSING asset (worklist), not an escape', () => {
  const { entries, escapes } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/web/20200101000000cs_/https://fonts.example.com/f.woff', resourceType: 'font' }] },
    { now }
  );
  assert.equal(escapes.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, '20200101000000/https://fonts.example.com/f.woff');
  assert.equal(entries[0].flag, 'cs_'); // raw own flag on the URL wins over the font type
});

test('non-local: proxy-collapsed scheme in a foreign wayback URL is repaired', () => {
  const { entries } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/web/20200101000000/http:/cdn.example.com/a.css', resourceType: 'stylesheet' }] },
    { now }
  );
  assert.equal(entries[0].key, '20200101000000/http://cdn.example.com/a.css');
});

test('non-local: a genuine third-party host is an escape, not a key', () => {
  const { entries, escapes } = mapFindings(
    { nonLocal: [{ url: 'https://www.google-analytics.com/ga.js', resourceType: 'script' }] },
    { now }
  );
  assert.equal(entries.length, 0);
  assert.equal(escapes.length, 1);
  assert.equal(escapes[0].url, 'https://www.google-analytics.com/ga.js');
});

test('non-local: a non-/web archive.org chrome URL is dropped, never recorded, never an escape', () => {
  const dropped = [];
  const { entries, escapes, chrome } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/_static/js/bundle.js', resourceType: 'script' }] },
    { now, log: l => dropped.push(l) }
  );
  assert.equal(entries.length, 0);
  assert.equal(escapes.length, 0);
  assert.equal(chrome.length, 1);
  assert.ok(dropped.some(l => l.includes('chrome')));
});

test('dedupe by key: first occurrence wins the flag', () => {
  const { entries } = mapFindings(
    {
      dangling: [
        { url: 'http://l/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'stylesheet' },
        { url: 'http://l/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'image' }
      ]
    },
    { now }
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].flag, 'cs_');
});

test('unparseable local path is dropped and logged, never a key', () => {
  const dropped = [];
  const { entries, unparseable } = mapFindings(
    { dangling: [{ url: 'http://l/not-a-wayback-path', resourceType: 'script' }] },
    { now, log: l => dropped.push(l) }
  );
  assert.equal(entries.length, 0);
  assert.equal(unparseable.length, 1);
  assert.ok(dropped.some(l => l.includes('unparseable')));
});

test('every produced entry is well-formed for recordDynamic (via/flag/key)', async () => {
  const { dynamicEntryError } = await import('@charlie.dev/waybackify/cache.js');
  const { entries } = mapFindings(
    {
      dangling: [{ url: 'http://l/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'stylesheet' }],
      nonLocal: [{ url: 'https://web.archive.org/web/20200101000000/https://f.example.com/x.woff', resourceType: 'font' }]
    },
    { now }
  );
  for (const e of entries) assert.equal(dynamicEntryError(e), null);
});
