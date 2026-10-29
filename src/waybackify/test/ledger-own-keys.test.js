import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { against, discover, flatten } from '../ledger.js';
import { canonicalize, readManifest, sourceRefs, writeManifest } from '../manifest.js';

const original = 'https://example.org/document';
const capture = timestamp => ({
  wayback: `https://web.archive.org/web/${timestamp}/${original}`,
  timestamp,
  checkedAt: '2026-10-29T00:00:00Z'
});
const first = capture('20200102030405');
const later = capture('20210102030405');
const keys = ['__proto__', 'constructor', 'toString', original];

function put(root, name, section, value) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  // Computed keys serialize as own JSON properties, including __proto__.
  fs.writeFileSync(path.join(dir, 'wayback.json'), JSON.stringify({
    version: 2,
    [section]: Object.fromEntries(keys.map(key => [key, value]))
  }));
  return dir;
}

for (const section of ['sources', 'entries']) {
  describe(`ledger own ${section} keys`, () => {
    it('preserves special keys and their first-seen captures through flatten and JSON', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-own-keys-'));
      put(root, 'z', section, later);
      put(root, 'a', section, first);
      const found = discover(root);
      const before = JSON.stringify(found);
      const union = flatten(found);
      assert.deepEqual(Object.keys(union[section]), keys);
      assert.equal(Object.getPrototypeOf(union[section]), Object.prototype);
      for (const key of keys) {
        assert.equal(Object.hasOwn(union[section], key), true);
        assert.deepEqual(union[section][key], first);
        assert.notEqual(union[section][key], found[0].manifest[section][key]);
      }
      const file = path.join(root, 'union.json');
      writeManifest(file, union);
      assert.deepEqual(canonicalize(readManifest(file)), canonicalize(union));
      assert.equal(JSON.stringify(found), before);
    });

    it('includes a special-key capture in reference and cache worklists', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-own-worklist-'));
      const dir = path.join(root, 'post');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'wayback.json'), JSON.stringify({
        version: 2, [section]: { ['__proto__']: first }
      }));
      const source = path.join(dir, 'README.md');
      fs.writeFileSync(source, 'A document with no inline archive references.');
      assert.deepEqual(sourceRefs(source, { manifest: true }).map(ref => ref.waybackUrl), [first.wayback]);
      const found = discover(root);
      const worklists = await against(found, path.join(root, 'empty-cache'));
      assert.deepEqual(worklists.unfetched.map(item => item.waybackUrl), [first.wayback]);
      const union = flatten(found);
      assert.deepEqual(Object.keys(union[section]), ['__proto__']);
    });
  });
}
