// Universe tests — the compile-time policy reader + the subset-baking
// primitive. Synthetic fixtures only; no filesystem beyond a tmp file for
// the reader, no network anywhere.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyUniverse, isExcluded, readUniverse, subset, validateUniverse } from '../universe.js';

describe('validateUniverse', () => {
  it('normalizes missing keys to the identity policy', () => {
    assert.deepEqual(validateUniverse({}), emptyUniverse());
    assert.deepEqual(validateUniverse({ exclude: ['http://a/'] }), { rewrites: {}, exclude: ['http://a/'] });
  });

  it('rejects malformed shapes, loudly and with context', () => {
    assert.throws(() => validateUniverse(null, 'u.json'), /u\.json: invalid universe/);
    assert.throws(() => validateUniverse({ rewrites: [] }), /`rewrites` must be an object/);
    assert.throws(() => validateUniverse({ rewrites: { 'http://a/': 42 } }), /must be a non-empty string/);
    assert.throws(() => validateUniverse({ exclude: [''] }), /`exclude` must be an array of non-empty strings/);
  });
});

describe('readUniverse', () => {
  it('reads + validates a universe file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'universe-')), 'universe.json');
    fs.writeFileSync(file, JSON.stringify({ rewrites: { 'http://old/': 'https://new/' } }));
    assert.deepEqual(readUniverse(file), { rewrites: { 'http://old/': 'https://new/' }, exclude: [] });
  });
});

describe('isExcluded', () => {
  const universe = { rewrites: {}, exclude: ['http://exact.example.com/page', 'https://prefix.example.com/tree/'] };

  it('matches exactly or by prefix — the frontmatter-skip rule', () => {
    assert.equal(isExcluded(universe, 'http://exact.example.com/page'), true);
    assert.equal(isExcluded(universe, 'http://exact.example.com/pa'), false);
    assert.equal(isExcluded(universe, 'https://prefix.example.com/tree/deep/leaf'), true);
    assert.equal(isExcluded(universe, 'https://prefix.example.com/elsewhere'), false);
  });
});

describe('subset', () => {
  const universe = {
    rewrites: { 'http://moved.example.com/': 'https://newhome.example.com/' },
    exclude: ['https://live.example.com/']
  };

  it('bakes only the given urls, expressed concretely', () => {
    const baked = subset(universe, [
      'http://moved.example.com/',
      'https://live.example.com/',
      'http://unrelated.example.com/'
    ]);
    assert.deepEqual(baked, {
      rewrites: { 'http://moved.example.com/': 'https://newhome.example.com/' },
      exclude: ['https://live.example.com/']
    });
  });

  it('a url claimed by exclude AND rewrites fails safe (exclude wins)', () => {
    const both = { rewrites: { 'http://x/': 'http://y/' }, exclude: ['http://x/'] };
    assert.deepEqual(subset(both, ['http://x/']), { rewrites: {}, exclude: ['http://x/'] });
  });

  it('universe policy for urls NOT in the source never leaks into the subset', () => {
    assert.deepEqual(subset(universe, ['http://other.example.com/']), emptyUniverse());
  });
});
