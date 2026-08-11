// Rewrite-engine tests — the content-type-keyed reference localizer + the
// ported chrome strip. Offline, pure string transforms; the corpus is a plain
// Map built inline so each case names exactly the captures it satisfies.
//
// Covers the mechanism classes the sweep found:
//   B1  absolute web.archive.org/web/… refs in attrs / CSS url() / JS literals
//   B2  host-relative /web/… refs (already the target form — preserved)
//   plus srcset, @font-face/@import, data-*/action attributes, the
//   unsatisfiable-ref-left-foreign rule, and the byte-lossless latin1 path.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  RULE_VERSION,
  classifyContentType,
  rewrite,
  rewriteCss,
  rewriteHtml,
  rewriteJs,
  stripWaybackChrome
} from '../rewrite.js';

/** Build a corpus map from a list of capture keys. */
const corpusOf = (...keys) => new Map(keys.map(k => [k, true]));

const GKEY = '19981202230410/http://www.google.com/google.jpg';
const CSS_KEY = '20140403040000/http://example.com/screen.css';
const FONT_KEY = '20140403040000/http://example.com/fonts/x.woff2';
const JS_KEY = '20140403040000/http://example.com/app.js';
const IMG2X = '20140403040000/http://example.com/img@2x.png';

describe('classifyContentType', () => {
  it('maps html / css / js media types, ignoring parameters and case', () => {
    assert.equal(classifyContentType('text/html; charset=utf-8'), 'html');
    assert.equal(classifyContentType('application/xhtml+xml'), 'html');
    assert.equal(classifyContentType('TEXT/CSS'), 'css');
    assert.equal(classifyContentType('application/javascript'), 'js');
    assert.equal(classifyContentType('text/javascript'), 'js');
    assert.equal(classifyContentType('application/x-javascript'), 'js');
  });

  it('returns null (pass through) for binary / unknown / empty types', () => {
    assert.equal(classifyContentType('image/jpeg'), null);
    assert.equal(classifyContentType('font/woff2'), null);
    assert.equal(classifyContentType('application/octet-stream'), null);
    assert.equal(classifyContentType(''), null);
    assert.equal(classifyContentType(undefined), null);
  });
});

describe('rewriteHtml — B1 absolute refs in attributes', () => {
  const corpus = corpusOf(GKEY);

  it('localizes an absolute wayback ref in src (loses the host)', () => {
    const { text, changed } = rewriteHtml(
      `<img src="https://web.archive.org/web/19981202230410im_/http://www.google.com/google.jpg">`,
      corpus
    );
    assert.equal(text, `<img src="/web/19981202230410im_/http://www.google.com/google.jpg">`);
    assert.equal(changed, true);
  });

  it('localizes href and action too', () => {
    const corpus2 = corpusOf('20140403040000/http://example.com/post', '20140403040000/http://example.com/submit');
    const html =
      `<a href="https://web.archive.org/web/20140403040000/http://example.com/post">p</a>` +
      `<form action="https://web.archive.org/web/20140403040000/http://example.com/submit"></form>`;
    const out = rewriteHtml(html, corpus2).text;
    assert.ok(out.includes(`href="/web/20140403040000/http://example.com/post"`));
    assert.ok(out.includes(`action="/web/20140403040000/http://example.com/submit"`));
  });

  it('localizes data-* attributes', () => {
    const out = rewriteHtml(
      `<div data-src="https://web.archive.org/web/19981202230410im_/http://www.google.com/google.jpg"></div>`,
      corpus
    ).text;
    assert.ok(out.includes(`data-src="/web/19981202230410im_/http://www.google.com/google.jpg"`));
  });

  it('preserves the &amp; entity in the emitted attribute (browser decodes it either way)', () => {
    const key = '20140403040000/http://example.com/a?x=1&y=2';
    const out = rewriteHtml(
      `<a href="https://web.archive.org/web/20140403040000/http://example.com/a?x=1&amp;y=2">l</a>`,
      corpusOf(key)
    ).text;
    assert.ok(out.includes(`href="/web/20140403040000/http://example.com/a?x=1&amp;y=2"`));
  });
});

describe('rewriteHtml — B2 host-relative refs', () => {
  it('recognizes an already-root-relative ref and leaves it (idempotent no-op)', () => {
    const html = `<a href="/web/19981202230410im_/http://www.google.com/google.jpg">x</a>`;
    const { text, changed } = rewriteHtml(html, corpusOf(GKEY));
    assert.equal(text, html);
    assert.equal(changed, false);
  });
});

describe('rewriteHtml — srcset', () => {
  it('localizes each satisfiable candidate and keeps descriptors + foreign candidates', () => {
    const corpus = corpusOf(IMG2X);
    const html =
      `<img srcset="https://web.archive.org/web/20140403040000im_/http://example.com/img@2x.png 2x, ` +
      `https://web.archive.org/web/20140403040000im_/http://example.com/absent.png 1x">`;
    const out = rewriteHtml(html, corpus).text;
    assert.ok(out.includes(`/web/20140403040000im_/http://example.com/img@2x.png 2x`));
    // The unsatisfiable candidate keeps its absolute host.
    assert.ok(out.includes(`https://web.archive.org/web/20140403040000im_/http://example.com/absent.png 1x`));
  });
});

describe('rewriteHtml — inline style attribute + <style> block (CSS)', () => {
  it('rewrites url() inside a style attribute', () => {
    const out = rewriteHtml(
      `<div style="background:url(https://web.archive.org/web/20140403040000im_/http://example.com/img@2x.png)"></div>`,
      corpusOf(IMG2X)
    ).text;
    assert.ok(out.includes(`url(/web/20140403040000im_/http://example.com/img@2x.png)`));
  });

  it('rewrites url()/@import inside an inline <style> block', () => {
    const html =
      `<style>@import "https://web.archive.org/web/20140403040000cs_/http://example.com/screen.css";\n` +
      `body{background:url(https://web.archive.org/web/20140403040000im_/http://example.com/img@2x.png)}</style>`;
    const out = rewriteHtml(html, corpusOf(CSS_KEY, IMG2X)).text;
    assert.ok(out.includes(`@import "/web/20140403040000cs_/http://example.com/screen.css"`));
    assert.ok(out.includes(`url(/web/20140403040000im_/http://example.com/img@2x.png)`));
  });
});

describe('rewriteHtml — inline <script> literals', () => {
  it('rewrites an exact wayback-URL string literal in an inline script', () => {
    const out = rewriteHtml(
      `<script>var u = "https://web.archive.org/web/20140403040000js_/http://example.com/app.js";</script>`,
      corpusOf(JS_KEY)
    ).text;
    assert.ok(out.includes(`"/web/20140403040000js_/http://example.com/app.js"`));
  });
});

describe('rewriteHtml — unsatisfiable references stay foreign', () => {
  it('leaves a ref whose capture is absent from the corpus untouched', () => {
    const html = `<img src="https://web.archive.org/web/19981202230410im_/http://www.google.com/NOPE.jpg">`;
    const { text, changed } = rewriteHtml(html, corpusOf(GKEY));
    assert.equal(text, html);
    assert.equal(changed, false);
  });

  it('leaves a non-wayback URL untouched', () => {
    const html = `<a href="https://example.com/live">live</a>`;
    assert.equal(rewriteHtml(html, corpusOf(GKEY)).text, html);
  });
});

describe('rewriteHtml — uncaptured NAVIGATIONAL refs funnel to the mirror (Option C)', () => {
  // NOTHING captured: the corpus is empty, so every ref below is uncaptured.
  const empty = corpusOf();

  it('B1: an uncaptured absolute-archive <a href> sheds its host (no archive-in-frame escape)', () => {
    const html = `<a href="https://web.archive.org/web/20140403040000/http://example.com/ClassNotice.htm">notice</a>`;
    const { text, changed } = rewriteHtml(html, empty);
    assert.equal(text, `<a href="/web/20140403040000/http://example.com/ClassNotice.htm">notice</a>`);
    assert.equal(changed, true);
    // The load-bearing property: clicking it can no longer render live archive.org.
    assert.ok(!text.includes('web.archive.org'));
  });

  it('B2: an uncaptured host-relative <a href> stays in mirror form', () => {
    const html = `<a href="/web/20140403040000/http://example.com/ClassNotice.htm">notice</a>`;
    const { text } = rewriteHtml(html, empty);
    assert.ok(text.includes(`href="/web/20140403040000/http://example.com/ClassNotice.htm"`));
    assert.ok(!text.includes('web.archive.org'));
  });

  it('navigational context also covers <area href> and <form action>', () => {
    const html =
      `<area href="https://web.archive.org/web/20140403040000/http://example.com/map">` +
      `<form action="https://web.archive.org/web/20140403040000/http://example.com/submit"></form>`;
    const out = rewriteHtml(html, empty).text;
    assert.ok(out.includes(`href="/web/20140403040000/http://example.com/map"`));
    assert.ok(out.includes(`action="/web/20140403040000/http://example.com/submit"`));
    assert.ok(!out.includes('web.archive.org'));
  });

  it('a SUBRESOURCE <img src> stays foreign when uncaptured (unchanged behavior)', () => {
    const html = `<img src="https://web.archive.org/web/20140403040000im_/http://example.com/absent.png">`;
    const { text, changed } = rewriteHtml(html, empty);
    assert.equal(text, html);
    assert.equal(changed, false);
  });

  it('a <link href> stylesheet is a SUBRESOURCE, not navigational — stays foreign', () => {
    const html = `<link rel="stylesheet" href="https://web.archive.org/web/20140403040000cs_/http://example.com/screen.css">`;
    const { text, changed } = rewriteHtml(html, empty);
    assert.equal(text, html);
    assert.equal(changed, false);
    assert.ok(text.includes('web.archive.org'));
  });

  it('<base href> is NOT navigational — an uncaptured base stays foreign', () => {
    const html = `<base href="https://web.archive.org/web/20140403040000/http://example.com/">`;
    const { text, changed } = rewriteHtml(html, empty);
    assert.equal(text, html);
    assert.equal(changed, false);
  });

  it('captured navigational + captured subresource both localize (regression guard)', () => {
    const corpus = corpusOf(
      '20140403040000/http://example.com/post',
      '20140403040000/http://example.com/logo.gif'
    );
    const html =
      `<a href="https://web.archive.org/web/20140403040000/http://example.com/post">p</a>` +
      `<img src="https://web.archive.org/web/20140403040000im_/http://example.com/logo.gif">`;
    const out = rewriteHtml(html, corpus).text;
    assert.ok(out.includes(`href="/web/20140403040000/http://example.com/post"`));
    assert.ok(out.includes(`src="/web/20140403040000im_/http://example.com/logo.gif"`));
    assert.ok(!out.includes('web.archive.org'));
  });
});

describe('rewriteCss', () => {
  const corpus = corpusOf(FONT_KEY, IMG2X, CSS_KEY);

  it('localizes @font-face src url(), keeping the format() suffix', () => {
    const css = `@font-face{font-family:x;src:url(https://web.archive.org/web/20140403040000cs_/http://example.com/fonts/x.woff2) format("woff2")}`;
    const out = rewriteCss(css, corpus).text;
    assert.ok(out.includes(`url(/web/20140403040000cs_/http://example.com/fonts/x.woff2) format("woff2")`));
  });

  it('localizes @import and a quoted url()', () => {
    const css = `@import url("https://web.archive.org/web/20140403040000cs_/http://example.com/screen.css");`;
    const out = rewriteCss(css, corpus).text;
    assert.ok(out.includes(`url("/web/20140403040000cs_/http://example.com/screen.css")`));
  });

  it('leaves an unsatisfiable url() foreign', () => {
    const css = `body{background:url(https://web.archive.org/web/20140403040000im_/http://example.com/absent.png)}`;
    assert.equal(rewriteCss(css, corpus).changed, false);
  });
});

describe('rewriteJs — exact string literals only', () => {
  const corpus = corpusOf(JS_KEY);

  it('rewrites a full absolute wayback-URL literal', () => {
    const out = rewriteJs(`var u = 'https://web.archive.org/web/20140403040000js_/http://example.com/app.js';`, corpus).text;
    assert.ok(out.includes(`'/web/20140403040000js_/http://example.com/app.js'`));
  });

  it('does NOT touch a concatenated / partial URL (nothing clever)', () => {
    const js = `var u = "https://web.archive.org/web/20140403040000js_/http://example.com" + "/app.js";`;
    assert.equal(rewriteJs(js, corpus).changed, false);
  });

  it('does NOT touch a host-relative /web/ literal (absolute-only in JS)', () => {
    const js = `var u = "/web/20140403040000js_/http://example.com/app.js";`;
    assert.equal(rewriteJs(js, corpus).changed, false);
  });
});

/* ------------------------------------------------------------------------ *
 * Chrome-strip parity — modeled on render/wayback/test/html.test.ts.
 * ------------------------------------------------------------------------ */

const REPLAYED_HTML = `<html>
<head><script src="https://web-static.archive.org/_static/js/athena.js" type="text/javascript"></script>
<script type="text/javascript">window.addEventListener('DOMContentLoaded',function(){var v=archive_analytics.values;v.service='wb';archive_analytics.send_pageview({});});</script>
<script type="text/javascript" src="https://web-static.archive.org/_static/js/wombat.js?v=def" charset="utf-8"></script>
<script>window.RufflePlayer=window.RufflePlayer||{};window.RufflePlayer.config={"autoplay":"on"};</script>
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
<div id="wm-ipp-base" lang="en" style="display:none;">toolbar markup</div>
<!-- END WAYBACK TOOLBAR INSERT -->
<h1>the capture</h1>
<img src="/web/20140403040000im_/http://example.com/logo.gif">
<script>var pageOwn = 'analytics the PAGE shipped';</script>
</body>
</html>
<!-- FILE ARCHIVED ON 03:48:42 Apr 03, 2014 -->`;

describe('stripWaybackChrome (ported parity)', () => {
  it('removes the toolbar block, the _static includes, and the __wm/analytics/ruffle bootstrap', () => {
    const out = stripWaybackChrome(REPLAYED_HTML);
    assert.ok(!out.includes('WAYBACK TOOLBAR INSERT'));
    assert.ok(!out.includes('wm-ipp'));
    assert.ok(!out.includes('web-static.archive.org'));
    assert.ok(!out.includes('/_static/'));
    assert.ok(!out.includes('archive_analytics'));
    assert.ok(!out.includes('__wm.'));
    assert.ok(!out.includes('RufflePlayer'));
    assert.ok(!out.includes('End Wayback Rewrite JS Include'));
  });

  it('keeps the page: title, markup, the page\'s own script, requisite refs, and provenance', () => {
    const out = stripWaybackChrome(REPLAYED_HTML);
    assert.ok(out.includes('<title>archived page</title>'));
    assert.ok(out.includes('<h1>the capture</h1>'));
    assert.ok(out.includes("var pageOwn = 'analytics the PAGE shipped';"));
    assert.ok(out.includes('src="/web/20140403040000im_/http://example.com/logo.gif"'));
    assert.ok(out.includes('FILE ARCHIVED ON'));
  });

  it('leaves non-wayback HTML byte-for-byte untouched', () => {
    const civilian =
      '<html><head><title>t</title>' +
      '<script>var wm = "just a variable named wm";</script>' +
      '</head><body><p>no archive chrome here</p></body></html>';
    assert.equal(stripWaybackChrome(civilian), civilian);
  });
});

describe('rewriteHtml composes strip + localize', () => {
  it('strips chrome AND localizes a satisfiable requisite ref, without injecting attribution', () => {
    const out = rewriteHtml(REPLAYED_HTML, corpusOf('20140403040000/http://example.com/logo.gif')).text;
    assert.ok(!out.includes('WAYBACK TOOLBAR INSERT'));
    assert.ok(out.includes('src="/web/20140403040000im_/http://example.com/logo.gif"'));
    // Remaster carries nothing of ours — attribution is the serving chrome's job.
    assert.ok(!out.includes('wayback-charlie-dev-attribution'));
  });
});

describe('rewrite dispatch + byte-lossless latin1 path', () => {
  it('passes binary/unknown content types through untouched', () => {
    const bin = 'image-ish \x89PNG bytes with /web/20140403040000/http://x/y inside';
    const r = rewrite('image/jpeg', bin, corpusOf('20140403040000/http://x/y'));
    assert.equal(r.text, bin);
    assert.equal(r.changed, false);
    assert.equal(r.dialect, null);
  });

  it('leaves non-ASCII (latin1) bytes intact while rewriting the ASCII ref', () => {
    // A high byte (0xE9 = é in latin1) sits right beside a rewritable ref.
    const body = 'p{content:"\xe9"}a{background:url(https://web.archive.org/web/20140403040000im_/http://example.com/img@2x.png)}';
    const r = rewrite('text/css', body, corpusOf(IMG2X));
    assert.ok(r.text.includes('\xe9')); // the byte survived
    assert.ok(r.text.includes('url(/web/20140403040000im_/http://example.com/img@2x.png)'));
  });

  it('exposes a stable RULE_VERSION', () => {
    assert.equal(typeof RULE_VERSION, 'number');
  });
});
