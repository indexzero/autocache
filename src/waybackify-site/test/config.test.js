// Site config validation — offline.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateSiteConfig } from '../src/config.js';

const site = { name: 'example.org', queries: [{ url: 'example.org', matchType: 'domain' }] };

describe('validateSiteConfig', () => {
  it('pads the window, fills cdx defaults, defaults matchType to exact', () => {
    const c = validateSiteConfig({
      window: { from: '2002', to: '2007' },
      sites: [{ name: 'a', queries: [{ url: 'http://example.org/docs/' }] }]
    });
    assert.deepEqual(c.window, { from: '20020000000000', to: '20079999999999' });
    assert.equal(c.cdx.pageLimit, 100000);
    assert.equal(c.cdx.backoffMs, 30000);
    assert.equal(c.sites[0].queries[0].matchType, 'exact');
    assert.deepEqual(c.rules, []);
  });

  it('an absent window spans everything', () => {
    const c = validateSiteConfig({ sites: [site] });
    assert.deepEqual(c.window, { from: '00000000000000', to: '99999999999999' });
  });

  it('keeps cdx overrides and lowercases rule hosts', () => {
    const c = validateSiteConfig({
      cdx: { pauseMs: 0, maxAttempts: 2 },
      sites: [site],
      rules: [{ host: 'Wiki.Example.org', html: 'raw', why: 'skin assets' }]
    });
    assert.equal(c.cdx.pauseMs, 0);
    assert.equal(c.cdx.maxAttempts, 2);
    assert.deepEqual(c.rules, [{ host: 'wiki.example.org', html: 'raw', why: 'skin assets' }]);
  });

  it('fails loud, with the context, on each malformed part', () => {
    const bad = (raw, re) => assert.throws(() => validateSiteConfig(raw, 'sites.json'), re);
    bad(null, /sites\.json: invalid site config — not an object/);
    bad({ sites: [] }, /`sites` must be a non-empty array/);
    bad({ sites: [{ name: '../x', queries: [{ url: 'a' }] }] }, /one path segment/);
    bad({ sites: [site, site] }, /duplicate site name "example\.org"/);
    bad({ sites: [{ name: 'a', queries: [] }] }, /`queries` must be a non-empty array/);
    bad({ sites: [{ name: 'a', queries: [{ url: 'a', matchType: 'glob' }] }] }, /matchType must be one of exact \| prefix \| host \| domain/);
    bad({ window: { from: 2002 }, sites: [site] }, /window\.from must be a 1–14 digit timestamp string/);
    bad({ window: { from: '2008', to: '2007' }, sites: [site] }, /window\.from is after window\.to/);
    bad({ cdx: { pageLimt: 5 }, sites: [site] }, /unknown cdx option "pageLimt"/);
    bad({ sites: [site], rules: [{ host: 'a', html: 'id_' }] }, /html must be "raw" or "replay"/);
  });
});
