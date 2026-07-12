// Requisite-extraction tests — offline, fixture-driven.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRequisites } from '../requisites.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/replay');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('extractRequisites', () => {
  const refs = extractRequisites(fixture('requisites-page.html'));
  const byKey = new Map(refs.map(r => [r.key, r]));

  it('finds every im_/cs_/js_/oe_ ref, absolute and root-relative, deduped by key', () => {
    assert.deepEqual(
      refs.map(r => r.key).sort(),
      [
        '20111011002337/http://ajax.googleapis.com/ajax/libs/jquery/1.4/jquery.min.js',
        '20111011002337/http://example.com/css/print.css',
        '20111011002337/http://example.com/css/screen.css',
        '20111011002337/http://example.com/images/collapsed-scheme.jpg',
        '20111011002337/http://example.com/images/diagram.png',
        '20111011002337/http://example.com/js/jquery-1.4.2.min.js',
        '20111011002337/http://example.com/media/demo.swf',
        '20111011002337/http://static.example.com/avatar.gif?s=48&d=identicon'
      ]
    );
  });

  it('keys are flagless; fetch URLs keep the flag (raw-asset replay)', () => {
    const img = byKey.get('20111011002337/http://example.com/images/diagram.png');
    assert.equal(img.flag, 'im_');
    assert.equal(img.waybackUrl, 'https://web.archive.org/web/20111011002337im_/http://example.com/images/diagram.png');
    assert.equal(byKey.get('20111011002337/http://example.com/css/screen.css').flag, 'cs_');
    assert.equal(byKey.get('20111011002337/http://example.com/media/demo.swf').flag, 'oe_');
    assert.equal(byKey.get('20111011002337/http://ajax.googleapis.com/ajax/libs/jquery/1.4/jquery.min.js').flag, 'js_');
  });

  it('never extracts flagless page links, if_ frames, or archive _static chrome', () => {
    for (const r of refs) {
      assert.notEqual(r.flag, 'if_');
      assert.ok(!r.original.includes('_static'), `chrome leaked: ${r.original}`);
      assert.ok(!r.original.includes('example.com/about'), `flagless link leaked: ${r.original}`);
      assert.ok(!r.original.includes('frame.html'), `if_ frame leaked: ${r.original}`);
    }
  });

  it('repairs proxy-collapsed schemes exactly like parseWaybackUrl', () => {
    assert.ok(byKey.has('20111011002337/http://example.com/images/collapsed-scheme.jpg'));
  });

  it('keeps query strings verbatim in the original', () => {
    assert.ok(byKey.has('20111011002337/http://static.example.com/avatar.gif?s=48&d=identicon'));
  });

  it('decodes attribute entities: src="...&amp;..." yields the & original a browser fetches', () => {
    const html = '<img src="/web/20111011002337im_/http://x.example/i.php?a=1&amp;b=2&amp;c=3">';
    const [r] = extractRequisites(html);
    assert.equal(r.original, 'http://x.example/i.php?a=1&b=2&c=3');
    assert.equal(r.key, '20111011002337/http://x.example/i.php?a=1&b=2&c=3');
  });

  it('CSS url(...) refs: bare ) terminates, balanced (...) pairs are kept (msdn rule)', () => {
    const html =
      '<div style="background:url(/web/20111011002337im_/http://x.example/bg.png);color:red">' +
      '<a href="/web/20111011002337im_/http://msdn.example/library/dd129517(VS.85).aspx">balanced</a>';
    const refs = extractRequisites(html);
    assert.deepEqual(refs.map(r => r.original).sort(), [
      'http://msdn.example/library/dd129517(VS.85).aspx',
      'http://x.example/bg.png'
    ]);
  });

  it('returns [] for HTML with no flagged refs', () => {
    assert.deepEqual(extractRequisites('<html><body><a href="https://web.archive.org/web/2014/http://x.com/">x</a></body></html>'), []);
    assert.deepEqual(extractRequisites(''), []);
  });
});
