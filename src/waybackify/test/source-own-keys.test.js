import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canonicalize, generate } from '../manifest.js';

const keys = ['__proto__', 'constructor', 'toString'];
const capture = original => ({
  wayback: `https://web.archive.org/web/20200102030405/${original}`,
  timestamp: '20200102030405',
  checkedAt: '2026-10-29T00:00:00Z',
  metadata: { retained: true }
});
const ownMap = (key, value) => JSON.parse(JSON.stringify({ [key]: value }));
function assertCapture(map, key, entry) {
  assert.equal(Object.hasOwn(map, key), true);
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  assert.deepEqual(map[key], entry);
}

test('generate retains literal own source keys reused from either seen capture map', async () => {
  for (const section of ['sources', 'entries']) {
    for (const key of keys) {
      const entry = capture(key);
      const seen = { version: 2, [section]: ownMap(key, entry) };
      const before = JSON.stringify(seen);
      const result = await generate('', null, seen, {
        sourceUrls: [key, key],
        resolve() { assert.fail('The stored capture must satisfy this source'); }
      });
      assert.deepEqual(result.unresolvedSources, []);
      assertCapture(result.manifest.sources, key, entry);
      assertCapture(result.seen.sources, key, entry);
      assert.notEqual(result.manifest.sources[key], result.seen.sources[key]);
      assert.notEqual(result.manifest.sources[key], seen[section][key]);
      assertCapture(canonicalize(result.manifest).sources, key, entry);
      assertCapture(canonicalize(result.seen).sources, key, entry);
      assert.equal(JSON.stringify(seen), before);
    }
  }
});

test('generate stores newly resolved literal source keys as own data properties', async () => {
  for (const key of keys) {
    const calls = [];
    const result = await generate('', null, null, {
      sourceUrls: [key, key],
      async resolve(url, options) {
        calls.push({ url, options });
        return { url: capture(key).wayback, timestamp: capture(key).timestamp };
      }
    });
    assert.deepEqual(calls, [{ url: key, options: { near: undefined, exactOriginal: true } }]);
    assert.deepEqual(result.unresolvedSources, []);
    const entry = result.manifest.sources[key];
    assert.equal(entry.wayback, capture(key).wayback);
    assert.equal(entry.timestamp, capture(key).timestamp);
    assert.equal(typeof entry.checkedAt, 'string');
    assertCapture(result.manifest.sources, key, entry);
    assertCapture(result.seen.sources, key, entry);
    assertCapture(canonicalize(result.manifest).sources, key, entry);
  }
});

test('generate preserves prior own source keys without requesting another capture', async () => {
  for (const key of keys) {
    const entry = capture(key);
    const sources = ownMap(key, entry);
    const before = JSON.stringify(sources);
    const result = await generate('', null, null, {
      sources, sourceUrls: [key], resolve() { assert.fail('Prior source must be preserved'); }
    });
    assert.deepEqual(result.unresolvedSources, []);
    assertCapture(result.manifest.sources, key, entry);
    assert.equal(JSON.stringify(sources), before);
  }
});

test('generate keeps invalid literal source captures unresolved', async () => {
  for (const snapshot of [{ url: 'https://example.org/', timestamp: '20200102030405' },
    { url: capture('__proto__').wayback, timestamp: '20200101' }]) {
    const result = await generate('', null, null, { sourceUrls: ['__proto__'], resolve: async () => snapshot });
    assert.equal(result.unresolvedSources.length, 1);
    assert.deepEqual(result.manifest.sources, {});
    assert.deepEqual(result.seen.sources, {});
  }
});
