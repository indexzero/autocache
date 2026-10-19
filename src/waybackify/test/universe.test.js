// Universe tests — the compile-time policy reader + the subset-baking
// primitive. Synthetic fixtures only; no filesystem beyond a tmp file for
// the reader, no network anywhere.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FQDN_BEHAVIORS,
  emptyUniverse,
  fqdnBehavior,
  isExcluded,
  readUniverse,
  subset,
  validateUniverse
} from '../universe.js';

describe('validateUniverse', () => {
  it('normalizes missing keys to the identity policy', () => {
    assert.deepEqual(validateUniverse({}), emptyUniverse());
    assert.deepEqual(validateUniverse({ exclude: ['http://a/'] }), { rewrites: {}, exclude: ['http://a/'], fqdns: {} });
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
    assert.deepEqual(readUniverse(file), { rewrites: { 'http://old/': 'https://new/' }, exclude: [], fqdns: {} });
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
    assert.deepEqual(subset(universe, ['http://other.example.com/']), { rewrites: {}, exclude: [] });
  });
});

describe('fqdns — per-host behavior', () => {
  const GH = { 'github.com': { on404: 'probe-repo-root-follow-rename' } };

  it('reads as an empty map when absent, and keeps a declared map', () => {
    assert.deepEqual(emptyUniverse().fqdns, {});
    assert.deepEqual(validateUniverse({}).fqdns, {});
    assert.deepEqual(validateUniverse({ fqdns: GH }).fqdns, GH);
  });

  it('names every known behavior in one frozen table', () => {
    assert.deepEqual(FQDN_BEHAVIORS, { on404: ['probe-repo-root-follow-rename'] });
    assert.ok(Object.isFrozen(FQDN_BEHAVIORS));
  });

  it('rejects malformed maps, loudly and with context', () => {
    assert.throws(() => validateUniverse({ fqdns: [] }, 'u.json'), /u\.json: invalid universe — `fqdns` must be an object/);
    assert.throws(() => validateUniverse({ fqdns: { 'https://github.com/': {} } }), /not a bare lowercase FQDN/);
    assert.throws(() => validateUniverse({ fqdns: { 'GitHub.com': {} } }), /not a bare lowercase FQDN/);
    assert.throws(() => validateUniverse({ fqdns: { localhost: {} } }), /not a bare lowercase FQDN/);
    assert.throws(() => validateUniverse({ fqdns: { 'github.com': 'probe' } }), /behavior for github\.com must be an object/);
    assert.throws(() => validateUniverse({ fqdns: { 'github.com': { on500: 'x' } } }), /unknown behavior `on500` for github\.com/);
    assert.throws(
      () => validateUniverse({ fqdns: { 'github.com': { on404: 'guess' } } }),
      /unknown value "guess" for `on404` on github\.com \(known: probe-repo-root-follow-rename\)/
    );
  });

  it('fqdnBehavior answers by the exact host of a url, and null for any other host', () => {
    const universe = validateUniverse({ fqdns: GH });
    assert.deepEqual(fqdnBehavior(universe, 'https://github.com/example/repo/issues/1'), GH['github.com']);
    assert.deepEqual(fqdnBehavior(universe, 'http://GitHub.com./x'), GH['github.com']);
    assert.equal(fqdnBehavior(universe, 'https://gist.github.com/x'), null);
    assert.equal(fqdnBehavior(universe, 'https://example.com/'), null);
    assert.equal(fqdnBehavior(universe, 'not a url'), null);
  });

  it('subset never bakes fqdns into a manifest: it stays generation-time policy', () => {
    const baked = subset(validateUniverse({ fqdns: GH }), ['https://github.com/a/b']);
    assert.deepEqual(baked, { rewrites: {}, exclude: [] });
  });
});
