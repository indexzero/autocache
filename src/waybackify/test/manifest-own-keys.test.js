import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canonicalize, readManifest, validateManifest, writeManifest } from '../manifest.js';

const capture = {
  wayback: 'https://web.archive.org/web/20200102030405/https://example.org/document',
  timestamp: '20200102030405',
  checkedAt: '2026-10-29T00:00:00Z'
};
const keys = ['https://example.org/document', '__proto__', 'constructor', 'toString'];

// JSON object keys are data, including names inherited by ordinary objects.
const manifestWithKeys = section => JSON.parse(JSON.stringify({
  version: 2,
  [section]: Object.fromEntries(keys.map(key => [key, capture]))
}));

for (const section of ['sources', 'entries']) {
  describe(`${section} own capture keys`, () => {
    it('preserves every own key without changing prototypes or the input', () => {
      const raw = manifestWithKeys(section);
      const before = JSON.stringify(raw);
      const validated = validateManifest(raw);
      assert.deepEqual(Object.keys(validated[section]), keys);
      assert.equal(Object.getPrototypeOf(validated[section]), Object.prototype);
      assert.equal(Object.hasOwn(Object.prototype, 'wayback'), false);
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(validated[section], key);
        assert.ok(property, key);
        assert.equal(property.enumerable, true);
        assert.equal(property.writable, true);
        assert.equal(property.configurable, true);
        assert.deepEqual(property.value, capture);
        assert.notEqual(property.value, raw[section][key]);
      }
      assert.equal(JSON.stringify(raw), before);
    });

    it('retains own keys through canonical JSON and repeated file round trips', () => {
      const raw = manifestWithKeys(section);
      const canonical = canonicalize(raw);
      assert.deepEqual(Object.keys(canonical[section]), [...keys].sort());
      assert.equal(Object.getPrototypeOf(canonical[section]), Object.prototype);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-own-keys-')), 'wayback.json');
      writeManifest(file, raw);
      const first = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(first);
      assert.deepEqual(Object.keys(parsed[section]), [...keys].sort());
      assert.deepEqual(parsed[section].__proto__, capture);
      const reread = readManifest(file);
      assert.deepEqual(reread[section], canonical[section]);
      assert.equal(Object.getPrototypeOf(reread[section]), Object.prototype);
      writeManifest(file, reread);
      assert.equal(fs.readFileSync(file, 'utf8'), first);
    });

    it('still rejects invalid capture values under an own __proto__ key', () => {
      for (const invalid of [null, [], { ...capture, wayback: null }, { ...capture, timestamp: '20200101' }]) {
        const raw = { version: 2, [section]: { ['__proto__']: invalid } };
        assert.throws(() => validateManifest(raw, 'own-key.json'), /own-key\.json: invalid manifest.*entry for __proto__/);
        assert.throws(() => canonicalize(raw), /invalid manifest.*entry for __proto__/);
      }
    });
  });
}
