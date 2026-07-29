// Offline unit tests for the wayback-404 verdict engine (audit.js, #248).
// Everything here is canned: CDX rows are faked at the WaybackMachine seam
// (auditCapture only calls wayback.getCapture) and replay bodies come from
// authored fixtures under test/fixtures/replay/. Zero network — live verdict
// tests are in audit-live.test.js behind WAYBACK_LIVE=1 (#246 split).
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCapture, parseWaybackUrl, stripWaybackChrome, classifyReplayHtml } from '../audit.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/replay');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('parseWaybackUrl', () => {
  it('parses a plain replay URL', () => {
    const p = parseWaybackUrl('https://web.archive.org/web/20081221144742/http://blogs.msdn.com:80/mharsh/archive.aspx');
    assert.deepEqual(p, {
      timestamp: '20081221144742',
      flags: '',
      original: 'http://blogs.msdn.com:80/mharsh/archive.aspx'
    });
  });

  it('separates replay flags from the timestamp', () => {
    const p = parseWaybackUrl('https://web.archive.org/web/20130607080910if_/http://findluk.com/');
    assert.equal(p.timestamp, '20130607080910');
    assert.equal(p.flags, 'if_');
    assert.equal(p.original, 'http://findluk.com/');
  });

  it('keeps parens and query strings in the original', () => {
    const p = parseWaybackUrl('https://web.archive.org/web/20100210134517/http://msdn.microsoft.com:80/en-us/library/dd129517(VS.85).aspx?q=1');
    assert.equal(p.original, 'http://msdn.microsoft.com:80/en-us/library/dd129517(VS.85).aspx?q=1');
  });

  it('repairs a proxy-collapsed scheme (http:/host)', () => {
    const p = parseWaybackUrl('https://web.archive.org/web/20120101000000/http:/nodejitsu.com/');
    assert.equal(p.original, 'http://nodejitsu.com/');
  });

  it('schemes a protocol-relative original', () => {
    const p = parseWaybackUrl('https://web.archive.org/web/20120101000000///cdn.example.com/x.js');
    assert.equal(p.original, 'https://cdn.example.com/x.js');
  });

  it('rejects non-replay URLs', () => {
    assert.equal(parseWaybackUrl('https://github.com/indexzero'), null);
    assert.equal(parseWaybackUrl('https://web.archive.org/cdx/search/cdx?url=x'), null);
    assert.equal(parseWaybackUrl('not a url'), null);
  });
});

describe('stripWaybackChrome', () => {
  it('removes the head inject, toolbar, and provenance comments', () => {
    const stripped = stripWaybackChrome(fixture('good-post.html'));
    assert.ok(!stripped.includes('__wm.'), 'wombat bootstrap survives');
    assert.ok(!stripped.includes('wm-ipp'), 'toolbar survives');
    assert.ok(!stripped.includes('_static/js/'), 'replay scripts survive');
    assert.ok(!stripped.includes('FILE ARCHIVED ON'), 'provenance comment survives');
    assert.ok(!stripped.includes('playback timings'), 'timing comment survives');
  });

  it('preserves the captured page content', () => {
    const stripped = stripWaybackChrome(fixture('good-post.html'));
    assert.ok(stripped.includes('Distributing Node.js services with cluster'));
    assert.ok(stripped.includes('graceful handoff'));
    assert.ok(stripped.includes('<title>Distributing Node.js services with cluster - example blog</title>'));
  });
});

describe('classifyReplayHtml', () => {
  it('a real post is good', () => {
    const r = classifyReplayHtml(fixture('good-post.html'));
    assert.equal(r.verdict, 'good');
    assert.ok(r.evidence.includes('Distributing Node.js services'), 'evidence carries the title');
  });

  it('IIS "page cannot be found" is wayback404', () => {
    const r = classifyReplayHtml(fixture('iis-404.html'));
    assert.equal(r.verdict, 'wayback404');
    assert.equal(r.reason, 'soft-404 title marker');
    assert.ok(r.evidence.length > 0);
  });

  it('parked-domain boilerplate is wayback404', () => {
    const r = classifyReplayHtml(fixture('parked-domain.html'));
    assert.equal(r.verdict, 'wayback404');
    assert.equal(r.reason, 'soft-404 body marker');
    assert.match(r.evidence, /domain/i);
  });

  it('a near-empty shell is suspect (never silently good)', () => {
    const r = classifyReplayHtml(fixture('near-empty.html'));
    assert.equal(r.verdict, 'suspect');
    assert.match(r.reason, /near-empty body/);
  });

  it('an under-construction placeholder is suspect', () => {
    const r = classifyReplayHtml(fixture('under-construction.html'));
    assert.equal(r.verdict, 'suspect');
    assert.equal(r.reason, 'soft error/placeholder marker');
  });

  it('the wayback machine error page leaking through a replay is wayback404', () => {
    const html = `<html><head><title>Wayback Machine</title></head><body>
      <p>Hrm.</p>
      <p>The Wayback Machine has not archived that URL.</p>
      <p>This page is not available on the web because page does not exist</p>
    </body></html>`;
    assert.equal(classifyReplayHtml(html).verdict, 'wayback404');
  });

  it('an archived-as-404 apache page is wayback404', () => {
    const html = `<html><head><title>404 Not Found</title></head><body>
      <h1>Not Found</h1><p>The requested URL /blog/post was not found on this server.</p>
    </body></html>`;
    assert.equal(classifyReplayHtml(html).verdict, 'wayback404');
  });

  it('a long article that MENTIONS a 404 phrase deep in its body is good', () => {
    const filler = 'This paragraph is ordinary prose about deploying services. '.repeat(60); // > 2000 chars
    const html = `<html><head><title>War stories from the error pages</title></head><body>
      <p>${filler}</p>
      <p>And then the load balancer showed us "the page cannot be found" for an hour.</p>
    </body></html>`;
    assert.equal(classifyReplayHtml(html).verdict, 'good');
  });

  it('but a 404 phrase in the LEAD of a short page still trips', () => {
    const html = `<html><head><title>Weblog</title></head><body>
      <p>The page you requested was not found on this weblog, sorry about that. Try the archives below,
      or head back to the front page for the latest posts.</p>
    </body></html>`;
    assert.equal(classifyReplayHtml(html).verdict, 'wayback404');
  });
});

// --- auditCapture orchestration, all seams faked -------------------------

const GOOD_URL = 'https://web.archive.org/web/20090315123456/http://blog.example.com/2009/03/distributing-node-services.html';

/** Fake WaybackMachine: canned getCapture (or a thrower). */
const fakeWayback = capture => ({
  getCapture: async () => {
    if (capture instanceof Error) throw capture;
    return capture;
  }
});

/** Fake replay fetch: canned status/content-type/body, records calls. */
const fakeFetch = ({ status = 200, contentType = 'text/html; charset=utf-8', body = '' } = {}) => {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    if (status instanceof Error) throw status;
    return {
      status,
      headers: { get: h => (h.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body
    };
  };
  fn.calls = calls;
  return fn;
};

const cdx200 = {
  timestamp: '20090315123456',
  original: 'http://blog.example.com/2009/03/distributing-node-services.html',
  statuscode: '200',
  mimetype: 'text/html'
};

describe('auditCapture', () => {
  it('throws on a non-wayback URL', async () => {
    await assert.rejects(() => auditCapture('https://github.com/indexzero'), TypeError);
  });

  it('CDX 404 capture → wayback404 without fetching the replay', async () => {
    const fetch = fakeFetch();
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback({ ...cdx200, statuscode: '404' }),
      fetch
    });
    assert.equal(v.verdict, 'wayback404');
    assert.equal(v.statuscode, '404');
    assert.match(v.reason, /archived as HTTP 404/);
    assert.equal(fetch.calls.length, 0, 'replay body was fetched needlessly');
    assert.equal(v.timestamp, '20090315123456');
    assert.equal(v.original, 'http://blog.example.com/2009/03/distributing-node-services.html');
    assert.ok(v.checkedAt);
  });

  it('CDX 503 capture → wayback404 (archived AS a server error)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback({ ...cdx200, statuscode: '503' }),
      fetch: fakeFetch()
    });
    assert.equal(v.verdict, 'wayback404');
    assert.equal(v.statuscode, '503');
  });

  it('CDX 200 + clean body → good', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: fixture('good-post.html') })
    });
    assert.equal(v.verdict, 'good');
    assert.equal(v.statuscode, '200');
  });

  it('CDX 200 + soft-404 body → wayback404 (the lying replay)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: fixture('iis-404.html') })
    });
    assert.equal(v.verdict, 'wayback404');
    assert.equal(v.statuscode, '200');
    assert.ok(v.evidence.length > 0, 'bad verdicts must carry evidence');
  });

  it('CDX 301 redirect capture + clean destination → good, with a note', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback({ ...cdx200, statuscode: '301' }),
      fetch: fakeFetch({ body: fixture('good-post.html') })
    });
    assert.equal(v.verdict, 'good');
    assert.match(v.reason, /redirect/);
  });

  it('capture missing from CDX + clean body → good, noted in reason', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(null),
      fetch: fakeFetch({ body: fixture('good-post.html') })
    });
    assert.equal(v.verdict, 'good');
    assert.equal(v.statuscode, null);
    assert.match(v.reason, /not in CDX/);
  });

  it('CDX lookup failure + clean body → suspect, never silently good', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(new Error('HTTP 429')),
      fetch: fakeFetch({ body: fixture('good-post.html') })
    });
    assert.equal(v.verdict, 'suspect');
    assert.match(v.reason, /CDX unverifiable/);
  });

  it('CDX lookup failure + soft-404 body → still wayback404 (content is decisive)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(new Error('HTTP 429')),
      fetch: fakeFetch({ body: fixture('parked-domain.html') })
    });
    assert.equal(v.verdict, 'wayback404');
  });

  it('replay fetch failure → suspect', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ status: new Error('request timed out') })
    });
    assert.equal(v.verdict, 'suspect');
    assert.match(v.reason, /replay fetch failed/);
  });

  it('replay HTTP 404 → wayback404 (capture missing from the archive)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ status: 404 })
    });
    assert.equal(v.verdict, 'wayback404');
    assert.match(v.reason, /HTTP 404/);
  });

  it('replay HTTP 503 → suspect (transient archive trouble)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ status: 503 })
    });
    assert.equal(v.verdict, 'suspect');
  });

  it('non-HTML capture (image) replaying cleanly → good, no heuristics', async () => {
    const v = await auditCapture('https://web.archive.org/web/20100101000000/http://example.com/logo.png', {
      wayback: fakeWayback({
        timestamp: '20100101000000',
        original: 'http://example.com/logo.png',
        statuscode: '200',
        mimetype: 'image/png'
      }),
      fetch: fakeFetch({ contentType: 'image/png', body: 'PNGBYTES' })
    });
    assert.equal(v.verdict, 'good');
    assert.match(v.reason, /non-HTML/);
  });

  it('near-empty shell → suspect end-to-end', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: fixture('near-empty.html') })
    });
    assert.equal(v.verdict, 'suspect');
    assert.match(v.reason, /near-empty/);
  });
});

// Signal 1.5: the corpus audit is a client of the canonical interstitial
// detector (#363), so captures that are archive.org talking ABOUT content —
// wrapper stubs, redirect interstitials, extension mismatches — are named
// wayback404 instead of slipping through as good/suspect. These fixtures are the
// exact ones interstitial.test.js uses (the #292 sweep's two species), reused
// here so audit-time and cache-time detection are pinned to the same bytes.
const INTERSTITIAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/interstitial');
const interstitial = name => fs.readFileSync(path.join(INTERSTITIAL, name), 'utf8');

describe('auditCapture — interstitial species (#363 wired into #248)', () => {
  it('wrapper stub → wayback404 with signature (was: suspect near-empty)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: interstitial('wrapper-stub.html') })
    });
    assert.equal(v.verdict, 'wayback404');
    assert.equal(v.signature, 'wrapper-stub');
    assert.match(v.reason, /interstitial: wrapper-stub/);
    assert.equal(v.target, undefined, 'wrapper stub carries no redirect target');
    // The body snippet must ride along for the human pass (#248's FP guard).
    assert.match(v.evidence, /title:|text:/, 'interstitial evidence keeps a body snippet');
  });

  it('redirect interstitial → wayback404 with the DECODED target (the re-point pass needs it)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: interstitial('redirect-interstitial.html') })
    });
    assert.equal(v.verdict, 'wayback404');
    assert.equal(v.signature, 'redirect-interstitial');
    assert.match(v.reason, /interstitial: redirect-interstitial/);
    assert.deepEqual(v.target, { url: 'http://example.com/moved-here', timestamp: '20140403040000' });
    assert.match(v.evidence, /→ 20140403040000\/http:\/\/example\.com\/moved-here/);
  });

  it('interstitial verdict wins over the soft-404 marker path (precise name, not coincidence)', async () => {
    // The redirect fixture also carries a "Got an HTTP 302 … at crawl time"
    // phrase the soft-404 heuristics would match; Signal 1.5 runs FIRST, so the
    // verdict names the species rather than the coincidental prose marker.
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: interstitial('redirect-interstitial.html') })
    });
    assert.equal(v.signature, 'redirect-interstitial');
    assert.doesNotMatch(v.reason, /soft-404/);
  });

  it('extension mismatch (.pdf served as text/html) → SUSPECT, not a confident wayback404', async () => {
    // A .pdf/.txt URL can legitimately replay as HTML (vanity URLs, viewer/landing
    // pages); extension-mismatch inspects no body and maps to none of #248's
    // dead-link classes, so the live audit surfaces it for a human as suspect
    // rather than confidently condemning it (P3 remediation, both reviewers).
    const PDF_URL = 'https://web.archive.org/web/20140403040000/http://example.com/report.pdf';
    const v = await auditCapture(PDF_URL, {
      wayback: fakeWayback({ timestamp: '20140403040000', original: 'http://example.com/report.pdf', statuscode: '200', mimetype: 'text/html' }),
      fetch: fakeFetch({ contentType: 'text/html', body: '<html><body>An actual document lives here, not a wrapper.</body></html>' })
    });
    assert.equal(v.verdict, 'suspect');
    assert.equal(v.signature, 'extension-mismatch');
    assert.match(v.reason, /interstitial: extension-mismatch/);
  });

  it('a genuinely good HTML capture is untouched by Signal 1.5 (no false positive)', async () => {
    const v = await auditCapture(GOOD_URL, {
      wayback: fakeWayback(cdx200),
      fetch: fakeFetch({ body: fixture('good-post.html') })
    });
    assert.equal(v.verdict, 'good');
    assert.equal(v.signature, undefined);
  });
});
