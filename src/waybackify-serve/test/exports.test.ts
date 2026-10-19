/**
 * The serving core exports no verifier. The four-layer parity engine, its
 * retrying dispatcher, and its checkpoint store live in
 * @autocache/waybackify-verify, which depends on this package. A re-export
 * here puts Node-only audit code back on the edge graph.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('waybackify-serve exports', () => {
  for (const subpath of ['parity', 'retry', 'verify-checkpoint']) {
    it(`does not export ./${subpath}`, async () => {
      assert.equal(Object.hasOwn(manifest.exports, `./${subpath}`), false);
      assert.equal(Object.hasOwn(manifest.tshy.exports, `./${subpath}`), false);
      await assert.rejects(import(`@autocache/waybackify-serve/${subpath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    });
  }
});
