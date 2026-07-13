// Enumerator tests. Fixture-based behavior (extraction
// contexts, ledger schema, dedupe, determinism, per-file manifest) plus a
// smoke pass over the REAL words/ tree — the assertion that every corpus
// wayback reference parses with the library's parser is the "two halves agree"
// contract: the audit scope and the mirror's servable set are one list by
// construction. Ported from render/wayback/src/enumerate.ts's suite when the
// canonical logic moved here (the convergence — enumerate.js is now the single
// implementation; render/wayback re-exports it).
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractArchiveUrls,
  enumerateCorpus,
  enumerateFile,
  postIdForPath,
  summarize
} from '../enumerate.js';
import { parseWaybackUrl } from '../audit.js';

const FIXTURE_WORDS = fileURLToPath(new URL('./fixtures/words', import.meta.url));
const REAL_WORDS = fileURLToPath(new URL('../../../words', import.meta.url));

describe('extractArchiveUrls', () => {
  it('extracts inline destinations, reference definitions, and autolinks', () => {
    const urls = extractArchiveUrls(
      [
        '[a](https://web.archive.org/web/2014/http://a.com/) text',
        '<https://web.archive.org/web/2015/http://b.com/>',
        '[label]: https://web.archive.org/web/2016/http://c.com/'
      ].join('\n')
    );
    assert.deepEqual(urls, [
      'https://web.archive.org/web/2014/http://a.com/',
      'https://web.archive.org/web/2015/http://b.com/',
      'https://web.archive.org/web/2016/http://c.com/'
    ]);
  });

  it('consumes balanced parens inside inline destinations (msdn-style URLs)', () => {
    const urls = extractArchiveUrls(
      '[M tools](https://web.archive.org/web/2010/http://msdn.microsoft.com/library/dd129517(VS.85).aspx) x'
    );
    assert.deepEqual(urls, [
      'https://web.archive.org/web/2010/http://msdn.microsoft.com/library/dd129517(VS.85).aspx'
    ]);
  });

  it('keeps query strings, ignores non-archive URLs', () => {
    const urls = extractArchiveUrls(
      '[q](https://web.archive.org/web/2010/http://x.com/d.aspx?a=en&b=2) and [g](https://github.com/x)'
    );
    assert.deepEqual(urls, ['https://web.archive.org/web/2010/http://x.com/d.aspx?a=en&b=2']);
  });

  it('ignores schemeless prose mentions of web.archive.org/web/', () => {
    assert.deepEqual(extractArchiveUrls('a bare mention of web.archive.org/web/ in prose'), []);
  });
});

describe('enumerateCorpus (fixture tree)', () => {
  const refs = enumerateCorpus(FIXTURE_WORDS);

  it('enumerates every reference from both sources, deduped', () => {
    assert.deepEqual(refs, [
      // 1/001 inline — sorted (source, then timestamp); the duplicate
      // sudomakethought link collapsed to one ref.
      {
        post: '1/001',
        source: 'inline',
        timestamp: '20050510075220',
        originalUrl: 'http://www.aa.com:80/',
        waybackUrl: 'https://web.archive.org/web/20050510075220/http://www.aa.com:80/'
      },
      {
        post: '1/001',
        source: 'inline',
        timestamp: '20100210134517',
        originalUrl: 'http://msdn.microsoft.com:80/en-us/library/dd129517(VS.85).aspx',
        waybackUrl:
          'https://web.archive.org/web/20100210134517/http://msdn.microsoft.com:80/en-us/library/dd129517(VS.85).aspx'
      },
      {
        post: '1/001',
        source: 'inline',
        timestamp: '20100323144106',
        originalUrl: 'http://smf.codeplex.com:80/',
        waybackUrl: 'https://web.archive.org/web/20100323144106/http://smf.codeplex.com:80/'
      },
      {
        post: '1/001',
        source: 'inline',
        timestamp: '20111005001528',
        originalUrl: 'http://example.com/shot.png',
        waybackUrl: 'https://web.archive.org/web/20111005001528/http://example.com/shot.png'
      },
      {
        post: '1/001',
        source: 'inline',
        timestamp: '20140403040000',
        originalUrl: 'http://sudomakethought.com/post/123',
        waybackUrl: 'https://web.archive.org/web/20140403040000/http://sudomakethought.com/post/123'
      },
      // 1/001 ledger — originalUrl comes from the wayback URL itself (the `:80`
      // spelling), not the ledger's live-URL key. The fixture's `wayback: null`
      // entry (waybackify's "no capture exists" state) is rightly absent: it
      // references nothing.
      {
        post: '1/001',
        source: 'ledger',
        timestamp: '20140129082008',
        originalUrl: 'http://registry.nodejitsu.com:80/',
        waybackUrl: 'https://web.archive.org/web/20140129082008/http://registry.nodejitsu.com:80/'
      },
      {
        post: '1/001',
        source: 'ledger',
        timestamp: '20160312105649',
        originalUrl: 'https://nodejitsu.com/npm',
        waybackUrl: 'https://web.archive.org/web/20160312105649/https://nodejitsu.com/npm'
      },
      // 2/001 — the same capture as 1/001 references, kept per-post (dedupe is
      // per (post, source, capture); cross-post collapse is summarize()'s
      // uniqueCaptures).
      {
        post: '2/001',
        source: 'inline',
        timestamp: '20140403040000',
        originalUrl: 'http://sudomakethought.com/post/123',
        waybackUrl: 'https://web.archive.org/web/20140403040000/http://sudomakethought.com/post/123'
      }
    ]);
  });

  it('is deterministic — same tree, same list', () => {
    assert.deepEqual(enumerateCorpus(FIXTURE_WORDS), refs);
  });

  it('summarizes the audit-scope counts', () => {
    assert.deepEqual(summarize(refs), {
      total: 8,
      inline: 6,
      ledger: 2,
      uniqueCaptures: 7, // the shared sudomakethought capture counts once
      posts: 2
    });
  });
});

describe('enumerateFile (the manifest unit)', () => {
  const file = path.join(FIXTURE_WORDS, '1/001/index.md');

  it('inline-only by default — no ledger rows', () => {
    const refs = enumerateFile(file);
    assert.equal(refs.length, 5);
    assert.ok(refs.every(r => r.source === 'inline'));
    assert.ok(refs.every(r => r.post === '1/001'));
  });

  it('--ledger folds in the sibling wayback.json (wayback:null skipped)', () => {
    const refs = enumerateFile(file, { ledger: true });
    assert.equal(refs.length, 7);
    assert.equal(refs.filter(r => r.source === 'ledger').length, 2);
    assert.ok(!refs.some(r => r.originalUrl.includes('never-captured')));
  });

  it('derives post ids from the path, else falls back to the path', () => {
    assert.equal(postIdForPath('words/1/043/index.md'), '1/043');
    assert.equal(postIdForPath('/abs/repo/words/1/043/index.md'), '1/043');
    assert.equal(postIdForPath('some/other/notes.md'), 'some/other/notes.md');
  });
});

describe('enumerateCorpus (real corpus smoke)', () => {
  // The real words/ tree ships in this repo — this is a contract over
  // committed content, not a network test. If it fails, either the corpus
  // gained an unparseable wayback URL (fix the corpus) or the parser regressed
  // (fix the parser); both are exactly what this smoke is for.
  const refs = enumerateCorpus(REAL_WORDS);

  it('finds a non-trivial number of references from both sources', () => {
    const counts = summarize(refs);
    assert.ok(counts.total > 0);
    assert.ok(counts.inline > 0);
    assert.ok(counts.ledger > 0);
    assert.ok(counts.uniqueCaptures > 0);
  });

  it('every reference round-trips through the parser to the same capture key', () => {
    for (const ref of refs) {
      const parsed = parseWaybackUrl(ref.waybackUrl);
      assert.ok(parsed !== null, ref.waybackUrl);
      assert.equal(`${parsed.timestamp}/${parsed.original}`, `${ref.timestamp}/${ref.originalUrl}`);
    }
  });
});
