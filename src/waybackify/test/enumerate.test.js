// Offline unit tests for the minimal corpus enumerator (enumerate.js, #248).
// Runs against a small authored fixture corpus (test/fixtures/corpus) — no
// network, no dependence on the real words/ tree. Convergence note: when the
// canonical enumerator from PR #255 (render/wayback) merges, the audit runner
// swaps to it and these tests shrink to the extraction primitives.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInlineWaybackUrls, enumerateCorpus } from '../enumerate.js';

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/corpus');

describe('extractInlineWaybackUrls', () => {
  it('extracts an inline link destination', () => {
    const urls = extractInlineWaybackUrls('see [x](https://web.archive.org/web/20120101000000/http://a.com/) ok');
    assert.deepEqual(urls, ['https://web.archive.org/web/20120101000000/http://a.com/']);
  });

  it('keeps balanced parens inside the URL (the msdn shape)', () => {
    const urls = extractInlineWaybackUrls(
      '[M tools](https://web.archive.org/web/20100210134517/http://msdn.microsoft.com:80/en-us/library/dd129517(VS.85).aspx) compile'
    );
    assert.deepEqual(urls, [
      'https://web.archive.org/web/20100210134517/http://msdn.microsoft.com:80/en-us/library/dd129517(VS.85).aspx'
    ]);
  });

  it('trims prose punctuation off a bare URL', () => {
    const urls = extractInlineWaybackUrls('go to https://web.archive.org/web/20120101000000/http://a.com/page. Next sentence.');
    assert.deepEqual(urls, ['https://web.archive.org/web/20120101000000/http://a.com/page']);
  });

  it('handles reference definitions and HTML anchors', () => {
    const md = [
      '<a href="https://web.archive.org/web/20101112131415/http://smf.codeplex.com/">anchor</a>',
      '',
      '[ref]: https://web.archive.org/web/20130607080910if_/http://findluk.com/'
    ].join('\n');
    assert.deepEqual(extractInlineWaybackUrls(md), [
      'https://web.archive.org/web/20101112131415/http://smf.codeplex.com/',
      'https://web.archive.org/web/20130607080910if_/http://findluk.com/'
    ]);
  });

  it('counts each occurrence (dedupe happens at the capture level)', () => {
    const u = 'https://web.archive.org/web/20120101000000/http://a.com/';
    assert.equal(extractInlineWaybackUrls(`[a](${u}) and [b](${u})`).length, 2);
  });

  it('ignores schemeless prose mentions of web.archive.org/web/', () => {
    assert.deepEqual(extractInlineWaybackUrls('a bare mention of web.archive.org/web/ in prose'), []);
  });
});

describe('enumerateCorpus', () => {
  const result = enumerateCorpus(CORPUS);

  it('finds every ref from both sources', () => {
    assert.equal(result.refs.length, 10);
    assert.equal(result.refs.filter(r => r.source === 'inline').length, 7);
    assert.equal(result.refs.filter(r => r.source === 'ledger').length, 3);
  });

  it('skips wayback:null ledger entries (never captured ≠ a reference)', () => {
    assert.ok(!result.refs.some(r => r.original.includes('silverlightfx')));
  });

  it('dedupes captures by flagless <timestamp>/<original>', () => {
    assert.equal(result.captures.length, 7);
    const msdn = result.captures.find(c => c.original.includes('mix-08-talk'));
    // 2 inline occurrences in 1/001 + 1 ledger entry = 3 refs, one capture.
    assert.equal(msdn.refCount, 3);
    assert.deepEqual(msdn.posts, ['1/001']);
    assert.equal(msdn.key, `${msdn.timestamp}/${msdn.original}`);
  });

  it('a capture shared across posts lists both posts', () => {
    const shared = result.captures.find(c => c.original.includes('registry.nodejitsu.com'));
    assert.deepEqual(shared.posts, ['1/001', '1/002']);
  });

  it('strips replay flags into the capture identity', () => {
    const flagged = result.captures.find(c => c.original.includes('findluk'));
    assert.equal(flagged.timestamp, '20130607080910');
    assert.ok(flagged.waybackUrl.includes('20130607080910if_/'));
  });

  it('reports posts and skips deterministically', () => {
    assert.deepEqual(result.posts, ['1/001', '1/002', '2/001']);
    assert.deepEqual(result.skipped, []);
    const keys = result.captures.map(c => c.key);
    assert.deepEqual(keys, [...keys].sort(), 'captures must be sorted by key');
  });
});
