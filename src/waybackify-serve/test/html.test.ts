/**
 * Serve-time HTML transform tests (#249, #361) — the one string-transform
 * contract left after the banner was removed:
 *
 * - stripWaybackChrome: the archive's injected chrome removed — against BOTH
 *   a synthetic replay-shaped sample and the REAL chrome in the committed
 *   cache-root fixture — while non-wayback HTML passes through identical, byte
 *   for byte. Nothing of ours is added; capture bytes carry nothing of ours.
 */

import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripWaybackChrome } from '../src/html.ts';
import { captureHash } from '@charlie.dev/waybackify/key.js';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));

/** Read a capture body straight out of the committed fixture cache-root. */
async function fixtureBody(key: string): Promise<string> {
  const hash = await captureHash(key);
  return fsp.readFile(`${FIXTURE_ROOT}/cap/${hash.slice(0, 2)}/${hash}`, 'utf8');
}

/**
 * A replay-shaped page, modeled line-for-line on the chrome archive.org
 * injects today (the committed fixture carries the real thing; this
 * synthetic twin makes the unit assertions readable). The page's OWN inline
 * script and its OWN rewritten asset refs must survive the strip.
 */
const REPLAYED_HTML = `<html>
<head><script src="https://web-static.archive.org/_static/js/athena.js" type="text/javascript"></script>
<script type="text/javascript">window.addEventListener('DOMContentLoaded',function(){var v=archive_analytics.values;v.service='wb';archive_analytics.send_pageview({});});</script>
<script type="text/javascript" src="https://web-static.archive.org/_static/js/bundle-playback.js?v=abc" charset="utf-8"></script>
<script type="text/javascript" src="https://web-static.archive.org/_static/js/wombat.js?v=def" charset="utf-8"></script>
<script>window.RufflePlayer=window.RufflePlayer||{};window.RufflePlayer.config={"autoplay":"on"};</script>
<script type="text/javascript" src="https://web-static.archive.org/_static/js/ruffle/ruffle.js"></script>
<script type="text/javascript">
  __wm.init("https://web.archive.org/web");
  __wm.wombat("http://example.com/","20140403040000","https://web.archive.org/","web","https://web-static.archive.org/_static/","123");
</script>
<link rel="stylesheet" type="text/css" href="https://web-static.archive.org/_static/css/banner-styles.css?v=ghi" />
<link rel="stylesheet" type="text/css" href="/_static/css/iconochive.css?v=jkl" />
<!-- End Wayback Rewrite JS Include -->
<title>archived page</title>
</head>
<body bgcolor="#FFFFFF" background="/web/20140403040000im_/http://example.com/bg.jpg"><!-- BEGIN WAYBACK TOOLBAR INSERT -->
<script>__wm.rw(0);</script>
<div id="wm-ipp-base" lang="en" style="display:none;">toolbar markup, forms, sparkline canvas</div>
<div id="wm-ipp-print">The Wayback Machine - https://web.archive.org/web/20140403040000/http://example.com/</div>
<script type="text/javascript">//<![CDATA[
__wm.bt(775,27,25,2,"web","http://example.com/","20140403040000",1996,"https://web-static.archive.org/_static/",["x"], false);
  __wm.rw(1);
//]]></script>
<!-- END WAYBACK TOOLBAR INSERT -->
<h1>the capture</h1>
<img src="/web/20140403040000im_/http://example.com/logo.gif">
<script>var pageOwn = 'analytics the PAGE shipped';</script>
</body>
</html>
<!--
     FILE ARCHIVED ON 03:48:42 Apr 03, 2014 AND RETRIEVED FROM THE
     INTERNET ARCHIVE ON 05:55:35 Jul 12, 2026.
-->`;

describe('stripWaybackChrome', () => {
  it('removes the comment-delimited toolbar block wholesale', () => {
    const out = stripWaybackChrome(REPLAYED_HTML);
    assert.ok(!out.includes('WAYBACK TOOLBAR INSERT'));
    assert.ok(!out.includes('wm-ipp'));
    assert.ok(!out.includes('__wm.bt'));
  });

  it('removes the _static script/CSS includes and the archive analytics/wombat/ruffle bootstrap', () => {
    const out = stripWaybackChrome(REPLAYED_HTML);
    assert.ok(!out.includes('web-static.archive.org'));
    assert.ok(!out.includes('/_static/'));
    assert.ok(!out.includes('archive_analytics'));
    assert.ok(!out.includes('__wm.'));
    assert.ok(!out.includes('RufflePlayer'));
    assert.ok(!out.includes('End Wayback Rewrite JS Include'));
  });

  it("keeps the page itself: markup, rewritten asset refs, and the page's own scripts", () => {
    const out = stripWaybackChrome(REPLAYED_HTML);
    assert.ok(out.includes('<title>archived page</title>'));
    assert.ok(out.includes('<h1>the capture</h1>'));
    // The rewritten requisite refs are the page's plumbing, not chrome —
    // they are exactly what src/path.ts now resolves locally.
    assert.ok(out.includes('background="/web/20140403040000im_/http://example.com/bg.jpg"'));
    assert.ok(out.includes('src="/web/20140403040000im_/http://example.com/logo.gif"'));
    assert.ok(out.includes("var pageOwn = 'analytics the PAGE shipped';"));
    // Trailing provenance comment is kept — renders as nothing, says where
    // the bytes came from.
    assert.ok(out.includes('FILE ARCHIVED ON'));
  });

  it('strips the REAL chrome in the committed fixture capture', async () => {
    const real = await fixtureBody('19981202230410/http://www.google.com/');
    // Sanity: the fixture really carries the chrome we claim to strip.
    assert.ok(real.includes('BEGIN WAYBACK TOOLBAR INSERT'));
    assert.ok(real.includes('web-static.archive.org/_static/'));

    const out = stripWaybackChrome(real);
    assert.ok(!out.includes('WAYBACK TOOLBAR INSERT'));
    assert.ok(!out.includes('wm-ipp'));
    assert.ok(!out.includes('web-static.archive.org'));
    assert.ok(!out.includes('__wm.'));
    assert.ok(!out.includes('archive_analytics'));
    // The page survives, requisite refs intact.
    assert.ok(out.includes('Search the web using Google!'));
    assert.ok(out.includes('src="/web/19981202230410im_/http://www.google.com/google.jpg"'));
  });

  it('leaves non-wayback HTML byte-for-byte untouched', () => {
    const civilian =
      '<html><head><title>t</title>' +
      '<link rel="stylesheet" href="https://example.com/site.css">' +
      '<script src="/js/app.js"></script>' +
      '<script>var wm = "just a variable named wm";</script>' +
      '</head><body><p>no archive chrome here</p><!-- an ordinary comment --></body></html>';
    assert.equal(stripWaybackChrome(civilian), civilian);
  });

  it('adds nothing of ours — the stripped page carries no banner or marker markup (#361)', () => {
    const out = stripWaybackChrome(REPLAYED_HTML);
    assert.ok(!out.includes('wayback-charlie-dev-attribution'));
    assert.ok(!out.includes('archive.org/donate'));
    // The page's own content is exactly what remains.
    assert.ok(out.includes('<h1>the capture</h1>'));
  });
});
