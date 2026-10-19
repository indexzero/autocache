// Key-derivation contract tests for the key module.
//
// key.js is the storage naming contract shared by the mirror server and its
// population tooling. This file pins the digests on the library side so the
// contract holds: the pinned sha256 below is permanent. If it ever changes,
// the mirror and its population tooling have diverged — stop and reconcile.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { assertMetadataSafe, bodyPath, captureHash, captureKey, capturePath, metaPath } from '../key.js';

describe('captureKey', () => {
  it('is `${timestamp}/${originalUrl}`, verbatim — no encoding, no normalization', () => {
    assert.equal(
      captureKey('20140403040000', 'http://sudomakethought.com/post/123'),
      '20140403040000/http://sudomakethought.com/post/123'
    );
    assert.equal(captureKey('2014', 'http://x.com:80/a?b=c&d=e#f'), '2014/http://x.com:80/a?b=c&d=e#f');
  });
});

describe('captureHash', () => {
  it('reproduces the cross-package pinned digest (the cross-package tripwire)', async () => {
    // This pin is permanent. Recompute only on a DELIBERATE layout change,
    // coordinated across the mirror server and the population CLI.
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

  it('produces legal names for keys the filesystem and S3 would both reject raw', async () => {
    const monster = `20140403040000/http://example.com/${'a'.repeat(2000)}`;
    assert.match(await captureHash(monster), /^[0-9a-f]{64}$/);
    assert.match(await captureHash('2014/http://x.com/a?b=c#d;e^f|g'), /^[0-9a-f]{64}$/);
  });
});

describe('capturePath / metaPath', () => {
  it('project the pinned digest into rootless `/`-joined object keys (the bucket-key contract)', async () => {
    // Same 77c4b856… digest the captureHash pin asserts — the
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

describe('bodyPath', () => {
  it('addresses a body by the sha256 digest that its SRI contentHash records', () => {
    const bytes = new TextEncoder().encode('shared page chrome');
    const digest = crypto.createHash('sha256').update(bytes);
    const hex = digest.copy().digest('hex');
    const sri = `sha256-${digest.digest('base64')}`;
    assert.equal(bodyPath(sri), `cap/${hex.slice(0, 2)}/${hex}`);
  });

  it('throws on a value that is not a sha256 SRI digest', () => {
    for (const bad of [undefined, '', 'sha256-unverified', 'sha512-AAAA', 'sha256-', `sha256-${'A'.repeat(40)}`]) {
      assert.throws(() => bodyPath(bad), /contentHash/, String(bad));
    }
  });
});

describe('assertMetadataSafe', () => {
  it('returns a safe contentType unchanged (spaces/semicolons are fine)', () => {
    assert.equal(assertMetadataSafe('text/html; charset=utf-8'), 'text/html; charset=utf-8');
    assert.equal(assertMetadataSafe(''), '');
  });

  it('enforces the commit-time + sync-time CR/LF + ≤1000-byte bounds', () => {
    // The shared validator cache.js#commitEntry and the bucket-sync emitter
    // both delegate to; the boundary is the object-metadata cap.
    assert.throws(() => assertMetadataSafe('text/html\r\nX-Evil: 1'), /CR\/LF/);
    const atLimit = `x/${'y'.repeat(980)}`;
    assert.equal(assertMetadataSafe(atLimit), atLimit); // exactly 1000 encoded bytes passes
    assert.equal(new TextEncoder().encode(JSON.stringify({ contentType: atLimit })).length, 1000);
    assert.throws(() => assertMetadataSafe(`${atLimit}z`), /1000/);
  });
});
