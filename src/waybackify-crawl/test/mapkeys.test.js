import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferFlag, isTrackingBeacon, mapFindings } from '../src/mapkeys.js';

const now = () => '2026-07-29T00:00:00.000Z';

test('inferFlag keeps a raw-byte own flag', () => {
  assert.equal(inferFlag('im_', 'script'), 'im_'); // own raw flag wins over type
  assert.equal(inferFlag('cs_', undefined), 'cs_');
});

test('inferFlag ignores a framing flag and infers from resource type', () => {
  assert.equal(inferFlag('if_', 'stylesheet'), 'cs_');
  assert.equal(inferFlag('id_', 'script'), 'js_');
});

test('inferFlag infers from resource type when no flag', () => {
  assert.equal(inferFlag(null, 'stylesheet'), 'cs_');
  assert.equal(inferFlag(undefined, 'script'), 'js_');
  assert.equal(inferFlag(undefined, 'image'), 'im_');
  assert.equal(inferFlag(undefined, 'font'), 'oe_');
  assert.equal(inferFlag(undefined, 'fetch'), 'oe_'); // else → oe_
  assert.equal(inferFlag(undefined, undefined), 'oe_');
});

test('dangling-local: a full local URL maps to a captureKey via the serving parser', () => {
  const { entries } = mapFindings(
    { dangling: [{ url: 'http://127.0.0.1:5000/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'stylesheet' }] },
    { now }
  );
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    key: '20200101000000/https://cdn.example.com/a.css',
    flag: 'cs_',
    via: 'remaster-verify',
    firstSeen: now()
  });
});

test('dangling-local: a bare /web path (no host) still maps', () => {
  const { entries } = mapFindings(
    { dangling: [{ url: '/web/20200101000000/https://cdn.example.com/a.js', resourceType: 'script' }] },
    { now }
  );
  assert.equal(entries[0].key, '20200101000000/https://cdn.example.com/a.js');
  assert.equal(entries[0].flag, 'js_');
});

test('non-local: a foreign web.archive.org wayback URL is a MISSING asset (worklist), not an escape', () => {
  const { entries, escapes } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/web/20200101000000cs_/https://fonts.example.com/f.woff', resourceType: 'font' }] },
    { now }
  );
  assert.equal(escapes.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, '20200101000000/https://fonts.example.com/f.woff');
  assert.equal(entries[0].flag, 'cs_'); // raw own flag on the URL wins over the font type
});

test('non-local: proxy-collapsed scheme in a foreign wayback URL is repaired', () => {
  const { entries } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/web/20200101000000/http:/cdn.example.com/a.css', resourceType: 'stylesheet' }] },
    { now }
  );
  assert.equal(entries[0].key, '20200101000000/http://cdn.example.com/a.css');
});

test('non-local: a genuine third-party host is an escape, not a key', () => {
  const { entries, escapes } = mapFindings(
    { nonLocal: [{ url: 'https://www.google-analytics.com/ga.js', resourceType: 'script' }] },
    { now }
  );
  assert.equal(entries.length, 0);
  assert.equal(escapes.length, 1);
  assert.equal(escapes[0].url, 'https://www.google-analytics.com/ga.js');
});

test('non-local: a non-/web archive.org chrome URL is dropped, never recorded, never an escape', () => {
  const dropped = [];
  const { entries, escapes, chrome } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/_static/js/bundle.js', resourceType: 'script' }] },
    { now, log: l => dropped.push(l) }
  );
  assert.equal(entries.length, 0);
  assert.equal(escapes.length, 0);
  assert.equal(chrome.length, 1);
  assert.ok(dropped.some(l => l.includes('chrome')));
});

test('dedupe by key: first occurrence wins the flag', () => {
  const { entries } = mapFindings(
    {
      dangling: [
        { url: 'http://l/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'stylesheet' },
        { url: 'http://l/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'image' }
      ]
    },
    { now }
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].flag, 'cs_');
});

test('unparseable local path is dropped and logged, never a key', () => {
  const dropped = [];
  const { entries, unparseable } = mapFindings(
    { dangling: [{ url: 'http://l/not-a-wayback-path', resourceType: 'script' }] },
    { now, log: l => dropped.push(l) }
  );
  assert.equal(entries.length, 0);
  assert.equal(unparseable.length, 1);
  assert.ok(dropped.some(l => l.includes('unparseable')));
});

test('non-local: a foreign wayback GA __utm.gif beacon is DROPPED (tracking beacon), not a key', () => {
  const dropped = [];
  const { entries, escapes, beacons } = mapFindings(
    {
      nonLocal: [
        {
          // A real IA replay of a GA pixel — a `/web/` URL whose per-render
          // random utmn/utmhid means every render mints a fresh, unconvergeable key.
          url: 'https://web.archive.org/web/20120515000000im_/http://www.google-analytics.com/__utm.gif?utmwv=5.3.7&utmn=1734829201&utmhid=482910473&utmt=event',
          resourceType: 'image'
        }
      ]
    },
    { now, log: l => dropped.push(l) }
  );
  assert.equal(entries.length, 0); // never recorded as a captureKey
  assert.equal(escapes.length, 0); // not a policy escape either
  assert.equal(beacons.length, 1);
  assert.ok(dropped.some(l => l.includes('tracking beacon') && l.includes('__utm.gif')));
});

test('non-local: a foreign wayback content asset is KEPT (the beacon drop does not over-reach)', () => {
  const { entries, beacons } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/web/20200101000000cs_/https://content.example/style.css', resourceType: 'stylesheet' }] },
    { now }
  );
  assert.equal(beacons.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, '20200101000000/https://content.example/style.css');
});

test('non-local: fonts and video behind a foreign wayback URL are CONTENT, not beacons — KEPT', () => {
  const { entries, beacons } = mapFindings(
    {
      nonLocal: [
        { url: 'https://web.archive.org/web/20200101000000cs_/https://fonts.googleapis.com/css?family=Lato', resourceType: 'stylesheet' },
        { url: 'https://web.archive.org/web/20200101000000/https://r1---sn-abc.googlevideo.com/videoplayback?id=42', resourceType: 'media' },
        { url: 'https://web.archive.org/web/20200101000000im_/https://0.gravatar.com/avatar/deadbeef?s=64', resourceType: 'image' }
      ]
    },
    { now }
  );
  assert.equal(beacons.length, 0);
  assert.equal(entries.length, 3); // all three stay real findings
});

test('non-local: the IA-chrome drop still works alongside the beacon drop', () => {
  const dropped = [];
  const { entries, escapes, chrome, beacons } = mapFindings(
    { nonLocal: [{ url: 'https://web.archive.org/_static/js/bundle.js', resourceType: 'script' }] },
    { now, log: l => dropped.push(l) }
  );
  assert.equal(entries.length, 0);
  assert.equal(escapes.length, 0);
  assert.equal(chrome.length, 1);
  assert.equal(beacons.length, 0);
  assert.ok(dropped.some(l => l.includes('chrome')));
});

test('isTrackingBeacon: matches the documented denylist and spares content', () => {
  // Beacons (dropped).
  assert.ok(isTrackingBeacon('http://www.google-analytics.com/__utm.gif?utmn=99'));
  assert.ok(isTrackingBeacon('https://ssl.google-analytics.com/collect?v=1'));
  assert.ok(isTrackingBeacon('http://google-analytics.com/collect'));
  assert.ok(isTrackingBeacon('http://192.168.112.2o7.net/b/ss/x'));
  assert.ok(isTrackingBeacon('https://cnn.112.2o7.net/b/ss/y'));
  assert.ok(isTrackingBeacon('https://metrics.example.omtrdc.net/b/ss/z'));
  assert.ok(isTrackingBeacon('http://ad.doubleclick.net/adj/site'));
  assert.ok(isTrackingBeacon('http://ib.adnxs.com/pixel'));
  assert.ok(isTrackingBeacon('https://csi.gstatic.com/csi?v=3'));
  assert.ok(isTrackingBeacon('https://pixel.wp.com/g.gif?v=ext'));
  assert.ok(isTrackingBeacon('https://stats.wp.com/e-201.js'));
  assert.ok(isTrackingBeacon('https://www.facebook.com/tr?id=1&ev=PageView'));
  // Content (spared) — the over-reach guard.
  assert.equal(isTrackingBeacon('https://fonts.googleapis.com/css?family=Lato'), false);
  assert.equal(isTrackingBeacon('https://r1.googlevideo.com/videoplayback?id=1'), false);
  assert.equal(isTrackingBeacon('https://0.gravatar.com/avatar/abc'), false);
  assert.equal(isTrackingBeacon('https://fonts.gstatic.com/s/lato/x.woff2'), false); // NOT csi.gstatic.com
  assert.equal(isTrackingBeacon('https://i0.wp.com/example.com/img.png'), false); // NOT the stats pixel host
  assert.equal(isTrackingBeacon('https://www.facebook.com/plugins/like.php'), false); // FB content, not /tr
  assert.equal(isTrackingBeacon('https://www.google-analytics.com/analytics.js'), false); // the LIBRARY is content
  assert.equal(isTrackingBeacon('not a url'), false);
});

test('every produced entry is well-formed for recordDynamic (via/flag/key)', async () => {
  const { dynamicEntryError } = await import('@charlie.dev/waybackify/cache.js');
  const { entries } = mapFindings(
    {
      dangling: [{ url: 'http://l/web/20200101000000/https://cdn.example.com/a.css', resourceType: 'stylesheet' }],
      nonLocal: [{ url: 'https://web.archive.org/web/20200101000000/https://f.example.com/x.woff', resourceType: 'font' }]
    },
    { now }
  );
  for (const e of entries) assert.equal(dynamicEntryError(e), null);
});
