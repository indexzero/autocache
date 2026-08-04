// The un-mirrorable-frontier predicates: the tracking-beacon denylist plus the
// non-fetchable-resource guard. These are consulted at the three frontier sites
// (cacheCapture fetch, fsck closure, crawl seed) so a replay never wastes a
// request on — nor counts closure against — a beacon or an inline/pseudo URL.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrackingBeacon, isFetchableResource, isUnmirrorable } from '../beacons.js';

test('the tracker denylist covers the added hosts (and mob.adnxs via the suffix)', () => {
  assert.ok(isTrackingBeacon('https://n.clarity.ms/collect'), 'Microsoft Clarity');
  assert.ok(isTrackingBeacon('http://alpha.getbackstory.com/gbs_setup_1_2.js'), 'Backstory widget');
  assert.ok(isTrackingBeacon('http://pixel.advertising.com/ups/254/occ'), 'advertising.com pixel');
  assert.ok(isTrackingBeacon('http://c1.microsoft.com//c.gif?DI=10139'), 'MS c.gif pixel (double slash)');
  assert.ok(isTrackingBeacon('http://mob.adnxs.com/seg?t=2'), 'mob.adnxs matches the .adnxs.com suffix');
});

test('the denylist stays CONSERVATIVE — nearby real content is NOT a beacon', () => {
  assert.equal(isTrackingBeacon('https://www.microsoft.com/en-us/'), false, 'microsoft.com content');
  assert.equal(isTrackingBeacon('https://c1.microsoft.com/download/setup.exe'), false, 'c1 host, non-c.gif path');
  assert.equal(isTrackingBeacon('https://fonts.googleapis.com/css?family=Bitter'), false, 'fonts are content');
  assert.equal(isTrackingBeacon('https://www.gravatar.com/avatar/abc'), false, 'avatars are content');
});

test('isFetchableResource rejects inline / pseudo / malformed URLs', () => {
  assert.equal(
    isFetchableResource('http://www.codediesel.com/wp-content/plugins/jetpack/genericons/data:application/font-woff;charset=utf-8;base64,d09GRg'),
    false,
    'a CSS url(data:...) mis-resolved into a path'
  );
  assert.equal(isFetchableResource('javascript:parent.adsIframeHtml()'), false, 'javascript: handler');
  assert.equal(isFetchableResource('http://javascript/'), false, 'javascript resolved to a bare host');
  assert.equal(isFetchableResource('data:image/png;base64,AAAA'), false, 'a bare data: URI');
  assert.equal(isFetchableResource('mailto:x@y.com'), false, 'mailto:');
  assert.equal(isFetchableResource(''), false, 'empty');
  assert.ok(isFetchableResource('http://example.com/a.png'), 'a real http image');
  assert.ok(isFetchableResource('https://github.com/apple-touch-icon-114.png'), 'a real https image');
});

test('isUnmirrorable = beacon OR non-fetchable; a real requisite is neither', () => {
  assert.ok(isUnmirrorable('https://n.clarity.ms/collect'), 'beacon');
  assert.ok(isUnmirrorable('javascript:void(0)'), 'non-fetchable');
  assert.equal(isUnmirrorable('https://github.com/apple-touch-icon-114.png'), false, 'a real image is mirrorable');
});
