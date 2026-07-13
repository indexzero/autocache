// Key-derivation contract tests for the EXTRACTED key module.
//
// key.js moved here from render/wayback/src/key.ts (now a re-export shim);
// that package's test/key.test.ts keeps pinning the same digests through the
// shim. This file pins them AGAIN on the library side so the contract holds
// even if the shim is ever unwired: the pinned sha256 below must equal
// render/wayback/test/key.test.ts's byte-for-byte, forever, or the mirror
// and its population tooling have diverged — stop and reconcile.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { captureHash, captureKey, captureMetadata, capturePath, fastlyKVKey, metaPath } from '../key.js';

describe('captureKey', () => {
  it('is `${timestamp}/${originalUrl}`, verbatim — no encoding, no normalization', () => {
    assert.equal(
      captureKey('20140403040000', 'http://sudomakethought.com/post/123'),
      '20140403040000/http://sudomakethought.com/post/123'
    );
    assert.equal(captureKey('2014', 'http://x.com:80/a?b=c&d=e#f'), '2014/http://x.com:80/a?b=c&d=e#f');
  });
});

describe('captureHash / fastlyKVKey', () => {
  it('reproduces the cross-package pinned digest (the cross-package tripwire)', async () => {
    // Identical to the pin in render/wayback/test/key.test.ts. Recompute
    // only on a DELIBERATE layout change, coordinated across the mirror
    // server and the population CLI.
    assert.equal(
      await fastlyKVKey('20140403040000/http://example.com/'),
      'cap:77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac'
    );
    assert.equal(
      await captureHash('20140403040000/http://example.com/'),
      '77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac'
    );
  });

  it('WebCrypto digest === node:crypto digest (the reference patch equivalence)', async () => {
    // The corpus body-capture patch asserted "node's crypto SHA-256 hex is
    // byte-identical to key.ts's WebCrypto digest" — pin it as a fact.
    const key = '2014/http://x.com/a?b=c#d;e^f|g';
    assert.equal(await captureHash(key), crypto.createHash('sha256').update(key, 'utf8').digest('hex'));
  });

  it('produces legal names for keys the filesystem and KV would both reject raw', async () => {
    const monster = `20140403040000/http://example.com/${'a'.repeat(2000)}`;
    assert.match(await fastlyKVKey(monster), /^cap:[0-9a-f]{64}$/);
    assert.match(await captureHash('2014/http://x.com/a?b=c#d;e^f|g'), /^[0-9a-f]{64}$/);
  });
});

describe('capturePath / metaPath', () => {
  it('project the pinned digest into rootless `/`-joined object keys (the bucket-key contract)', async () => {
    // Same 77c4b856… digest the fastlyKVKey/captureHash pins assert — the
    // shard is <hash>[0:2], the keys are `/`-joined object keys, NEVER OS
    // paths and NEVER root-prefixed. Recompute only on a DELIBERATE layout
    // change, coordinated across the mirror server and the population CLI.
    assert.equal(
      await capturePath('20140403040000/http://example.com/'),
      'cap/77/77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac'
    );
    assert.equal(
      await metaPath('20140403040000/http://example.com/'),
      'meta/77/77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac.json'
    );
  });

  it('shard + hash are exactly captureHash (one source of truth)', async () => {
    const key = '2014/http://x.com/a?b=c#d;e^f|g';
    const hash = await captureHash(key);
    assert.equal(await capturePath(key), `cap/${hash.slice(0, 2)}/${hash}`);
    assert.equal(await metaPath(key), `meta/${hash.slice(0, 2)}/${hash}.json`);
  });
});

describe('captureMetadata', () => {
  it('encodes the R2-httpMetadata-shaped object as JSON', () => {
    assert.equal(captureMetadata({ contentType: 'text/html; charset=utf-8' }), '{"contentType":"text/html; charset=utf-8"}');
  });

  it('rejects CR/LF and the 1000-byte overflow at write time', () => {
    assert.throws(() => captureMetadata({ contentType: 'text/html\r\nX-Evil: 1' }), /CR\/LF/);
    const atLimit = `x/${'y'.repeat(980)}`;
    assert.equal(new TextEncoder().encode(captureMetadata({ contentType: atLimit })).length, 1000);
    assert.throws(() => captureMetadata({ contentType: `${atLimit}z` }), /1000/);
  });
});
