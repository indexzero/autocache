/**
 * Parser contract tests (#249). The parser is the identity function of the
 * whole system — the edge handler, the enumerator, and the #248 audit all
 * derive (timestamp, originalUrl, key) through it — so this suite pins the
 * liberal-parse behaviors (flags, collapsed slashes, scheme-less originals)
 * and the rejections (garbage stays 404, never a bogus redirect).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureKey, decodeCapturePath, formatCapturePath, parseArchiveUrl, parseWaybackPath } from '../src/path.ts';

describe('parseWaybackPath', () => {
  it('parses a canonical capture path', () => {
    const parsed = parseWaybackPath('/20140403040000/http://sudomakethought.com/post/123');
    assert.notEqual(parsed, null);
    assert.equal(parsed?.timestamp, '20140403040000');
    assert.equal(parsed?.flag, undefined);
    assert.equal(parsed?.originalUrl, 'http://sudomakethought.com/post/123');
    assert.equal(parsed?.key, '20140403040000/http://sudomakethought.com/post/123');
    assert.equal(
      parsed?.archiveUrl,
      'https://web.archive.org/web/20140403040000/http://sudomakethought.com/post/123'
    );
    assert.equal(parsed?.canonicalArchiveUrl, parsed?.archiveUrl);
  });

  it('keeps the original URL query string as part of the capture identity', () => {
    const parsed = parseWaybackPath(
      '/20091121071757/http://www.microsoft.com:80/downloads/details.aspx?displaylang=en&FamilyID=3db8'
    );
    assert.equal(
      parsed?.originalUrl,
      'http://www.microsoft.com:80/downloads/details.aspx?displaylang=en&FamilyID=3db8'
    );
  });

  describe('replay flags on the timestamp', () => {
    for (const flag of ['if_', 'id_', 'im_', 'js_', 'cs_']) {
      it(`tolerates ${flag} and keeps it out of the key`, () => {
        const parsed = parseWaybackPath(`/20140403040000${flag}/http://example.com/`);
        assert.equal(parsed?.flag, flag);
        assert.equal(parsed?.timestamp, '20140403040000');
        // Flag preserved for the miss-redirect (replay semantics survive)...
        assert.equal(parsed?.archiveUrl, `https://web.archive.org/web/20140403040000${flag}/http://example.com/`);
        // ...but excluded from storage identity and provenance.
        assert.equal(parsed?.key, '20140403040000/http://example.com/');
        assert.equal(parsed?.canonicalArchiveUrl, 'https://web.archive.org/web/20140403040000/http://example.com/');
      });
    }
  });

  describe('liberal original-URL repair', () => {
    it('repairs proxy-collapsed scheme slashes (http:/host)', () => {
      const parsed = parseWaybackPath('/20140403040000/http:/example.com/page');
      assert.equal(parsed?.originalUrl, 'http://example.com/page');
    });

    it('accepts protocol-relative originals as https', () => {
      const parsed = parseWaybackPath('/20140403040000///example.com/page');
      assert.equal(parsed?.originalUrl, 'https://example.com/page');
    });

    it('accepts scheme-less originals as http (the corpus era default)', () => {
      const parsed = parseWaybackPath('/20140403040000/example.com/page');
      assert.equal(parsed?.originalUrl, 'http://example.com/page');
    });

    it('accepts short (date-prefix) timestamps, as wayback does', () => {
      assert.equal(parseWaybackPath('/2014/http://example.com/')?.timestamp, '2014');
      assert.equal(parseWaybackPath('/20140403/http://example.com/')?.timestamp, '20140403');
    });
  });

  describe('the /web/ prefix — replay-shaped requisite paths are first-class', () => {
    // Stored replay HTML references its assets root-relative in exactly this
    // shape (src="/web/<ts><flag>/<original>"), so the prefixed form MUST
    // parse to the same capture identity as the unprefixed one — that is
    // what lets stored documents resolve their requisites against the
    // mirror with zero URL rewriting.
    const IDENTICAL: Array<[string, string]> = [
      ['plain document', '/20140403040000/http://example.com/'],
      ['image requisite (im_)', '/20140403040000im_/http://example.com/logo.gif'],
      ['stylesheet requisite (cs_)', '/20140403040000cs_/http://example.com/site.css'],
      ['script requisite (js_)', '/20140403040000js_/http://example.com/app.js'],
      ['embed requisite (oe_)', '/20140403040000oe_/http://example.com/movie.swf'],
      ['iframe framing (if_)', '/20140403040000if_/http://example.com/'],
      ['short timestamp', '/2014/http://example.com/'],
      ['query-string original', '/20091121071757cs_/http://example.com/c.css?v=3&theme=old'],
      ['hostile original (raw # | ^)', '/20140403040000im_/http://example.com/a#b|c^d'],
      ['proxy-collapsed scheme', '/20140403040000im_/http:/example.com/x.png'],
      ['protocol-relative original', '/20140403040000///example.com/x.png'],
      ['scheme-less original', '/20140403040000/example.com/x.png']
    ];
    for (const [label, path] of IDENTICAL) {
      it(`parses /web variant identically to ${label}`, () => {
        const prefixed = parseWaybackPath(`/web${path}`);
        const unprefixed = parseWaybackPath(path);
        assert.notEqual(prefixed, null);
        // Same capture identity, same redirect targets — the prefix is
        // routing, not identity, so the parses are indistinguishable.
        assert.deepEqual(prefixed, unprefixed);
      });
    }

    it('never lets the prefix leak into the capture key', () => {
      const parsed = parseWaybackPath('/web/20140403040000im_/http://example.com/logo.gif');
      assert.equal(parsed?.key, '20140403040000/http://example.com/logo.gif');
      assert.equal(parsed?.flag, 'im_');
      assert.equal(parsed?.archiveUrl, 'https://web.archive.org/web/20140403040000im_/http://example.com/logo.gif');
    });

    const REJECTED_PREFIX: Array<[string, string]> = [
      ['bare /web/ (the toolbar home link)', '/web/'],
      ['no timestamp after the prefix', '/web/http://example.com/'],
      ['calendar view (ts + splat, no URL)', '/web/20140403040000*/http://example.com/'],
      ['prefix without its own slash', '/web20140403040000/http://example.com/'],
      ['unrelated /webx/ path', '/webx/20140403040000/http://example.com/']
    ];
    for (const [label, path] of REJECTED_PREFIX) {
      it(`still rejects ${label}`, () => {
        assert.equal(parseWaybackPath(path), null);
      });
    }
  });

  describe('rejections', () => {
    const REJECTED: Array<[string, string]> = [
      ['no leading slash', '20140403040000/http://example.com/'],
      ['too-short timestamp', '/201/http://example.com/'],
      ['too-long timestamp', '/201404030400001/http://example.com/'],
      ['non-digit timestamp', '/2014040304000x/http://example.com/'],
      ['flag without underscore shape', '/20140403040000abcd/http://example.com/'],
      ['no original URL', '/20140403040000/'],
      ['original with no host shape', '/20140403040000/not a url'],
      ['bare service path', '/favicon.ico'],
      ['empty', ''],
      ['root', '/']
    ];
    for (const [label, path] of REJECTED) {
      it(`rejects ${label}`, () => {
        assert.equal(parseWaybackPath(path), null);
      });
    }
  });
});

describe('parseArchiveUrl', () => {
  it('parses full web.archive.org URLs into the same shape', () => {
    const parsed = parseArchiveUrl('https://web.archive.org/web/20160312105649/https://nodejitsu.com/npm');
    assert.equal(parsed?.key, '20160312105649/https://nodejitsu.com/npm');
  });

  it('agrees with parseWaybackPath — same URL, same key', () => {
    const viaUrl = parseArchiveUrl('https://web.archive.org/web/20140403040000if_/http://example.com/a?b=c');
    const viaPath = parseWaybackPath('/20140403040000if_/http://example.com/a?b=c');
    assert.deepEqual(viaUrl, viaPath);
  });

  it('rejects non-archive URLs and non-replay archive URLs', () => {
    assert.equal(parseArchiveUrl('https://example.com/web/20140403040000/http://x.com/'), null);
    assert.equal(parseArchiveUrl('https://web.archive.org/details/some-item'), null);
  });
});

describe('captureKey', () => {
  it('is the `${timestamp}/${originalUrl}` storage contract', () => {
    assert.equal(captureKey('20140403040000', 'http://example.com/'), '20140403040000/http://example.com/');
  });
});

describe('formatCapturePath / decodeCapturePath — the href round-trip pair', () => {
  it('is the identity for a wire-safe key (todays reachable paths keep working byte-for-byte)', () => {
    const key = '20091121071757/http://www.microsoft.com:80/downloads/details.aspx?displaylang=en&FamilyID=3db8';
    assert.equal(formatCapturePath(key), `/${key}`);
    assert.equal(decodeCapturePath(`/${key}`), `/${key}`);
  });

  it('percent-encodes exactly the bytes a request line cannot carry raw, and decodes them back', () => {
    const key = '20140101000000/http://example.com/a b/<i>"q"</i>\\x^y`z{w}#f';
    const href = formatCapturePath(key);
    assert.ok(!/[ "<>\\^`{}#]/.test(href), 'no WHATWG-mangled byte survives raw in the href');
    assert.equal(decodeCapturePath(href), `/${key}`);
  });

  it('the encoding is a WHATWG fixed point — a browser transmits the href byte-identically', () => {
    const keys = [
      '20140403040000/http://x.com/a?b=c#f',
      '20140101000000/http://example.com/café/日本',
      "20140101000000/http://example.com/a?q='hi' &x=<1>",
      '20140101000000/http://example.com/100%/a%20b'
    ];
    for (const key of keys) {
      const href = formatCapturePath(key);
      const url = new URL(`http://h${href}`);
      assert.equal(url.pathname + url.search, href, `fixed point for ${key}`);
      assert.equal(decodeCapturePath(url.pathname + url.search), `/${key}`, `decodes to the byte-exact key for ${key}`);
    }
  });

  it('escapes % itself, so a key holding a literal percent-sequence never decodes to a different key', () => {
    const key = '20140101000000/http://example.com/a%20b';
    assert.equal(formatCapturePath(key), '/20140101000000/http://example.com/a%2520b');
    assert.equal(decodeCapturePath('/20140101000000/http://example.com/a%2520b'), `/${key}`);
    // The UNDOUBLED form is a different request — it decodes to the space
    // key, never back to the literal-%20 key (raw-first serving handles the
    // precedence between the two).
    assert.equal(decodeCapturePath(`/${key}`), '/20140101000000/http://example.com/a b');
  });

  it('never invents path structure: %2F stays literal, malformed escapes pass through', () => {
    assert.equal(decodeCapturePath('/2014/http://x.com/a%2Fb'), '/2014/http://x.com/a%2Fb');
    assert.equal(decodeCapturePath('/2014/http://x.com/100%'), '/2014/http://x.com/100%');
    assert.equal(decodeCapturePath('/2014/http://x.com/a%2'), '/2014/http://x.com/a%2');
    assert.equal(decodeCapturePath('/2014/http://x.com/a%zz'), '/2014/http://x.com/a%zz');
  });
});
