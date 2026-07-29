import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compilePolicy } from '../src/policy.js';

const policy = compilePolicy({
  version: 1,
  escapes: [
    { host: 'google-analytics.com', reason: 'analytics' },
    { host: 'www.googletagmanager.com', reason: 'tag manager' }
  ]
});

test('exact host matches', () => {
  const m = policy.match('https://google-analytics.com/collect');
  assert.equal(m?.reason, 'analytics');
});

test('subdomain matches (suffix-aware)', () => {
  const m = policy.match('https://www.google-analytics.com/ga.js');
  assert.equal(m?.reason, 'analytics');
});

test('a look-alike host does NOT match (label boundary is a literal dot)', () => {
  assert.equal(policy.match('https://evilgoogle-analytics.com/x'), null);
});

test('an unlisted host does not match', () => {
  assert.equal(policy.match('https://example.com/x'), null);
});

test('deeper subdomain of a full-host entry matches', () => {
  assert.equal(policy.match('https://a.b.www.googletagmanager.com/gtm.js')?.reason, 'tag manager');
});

test('an unparseable URL never matches (returns null, does not throw)', () => {
  assert.equal(policy.match('not a url'), null);
});

test('matching is case-insensitive', () => {
  assert.equal(policy.match('https://WWW.Google-Analytics.COM/x')?.reason, 'analytics');
});

test('an empty policy matches nothing', () => {
  const empty = compilePolicy({ escapes: [] });
  assert.equal(empty.match('https://google-analytics.com/x'), null);
});

test('malformed entries (no host) are dropped, not fatal', () => {
  const p = compilePolicy({ escapes: [{ reason: 'no host' }, { host: 'ok.com', reason: 'r' }] });
  assert.equal(p.entries.length, 1);
  assert.equal(p.match('https://ok.com/x')?.reason, 'r');
});
