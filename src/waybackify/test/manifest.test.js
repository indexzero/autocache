// Manifest tests — schema v2 read/write/validate, the applied-source
// scanner, per-file enumeration, generate (offline, resolution injected),
// and apply (the importer-proven normalize equation, generalized).
// Synthetic fixtures only; zero network.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_VERSION,
  apply,
  canonicalize,
  emptyManifest,
  extractArchiveUrls,
  generate,
  readManifest,
  sourceRefs,
  validateManifest,
  writeManifest
} from '../manifest.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));

const WB_A = 'https://web.archive.org/web/20100101000000/http://a.example.com/';
const WB_B = 'https://web.archive.org/web/20140403040000/http://b.example.com/post';

/* ------------------------------------------------------------------------ *
 * validate / read / write
 * ------------------------------------------------------------------------ */

describe('validateManifest', () => {
  it('normalizes a v2 manifest to the canonical in-memory shape', () => {
    const m = validateManifest({
      version: 2,
      entries: { 'http://a.example.com/': { wayback: WB_A, timestamp: '20100101000000' } },
      exclude: ['https://live.example.com/']
    });
    assert.equal(m.version, MANIFEST_VERSION);
    assert.deepEqual(m.rewrites, {});
    assert.deepEqual(Object.keys(m.entries), ['http://a.example.com/']);
    assert.deepEqual(m.exclude, ['https://live.example.com/']);
  });

  it('reads a v1 `wayback: null` entry as legacy-exclude', () => {
    const m = validateManifest({
      version: 1,
      entries: {
        'http://a.example.com/': { wayback: WB_A, timestamp: '20100101000000', checkedAt: '2026-01-01T00:00:00Z' },
        'http://never-captured.example.com/': { wayback: null, timestamp: null, checkedAt: '2026-01-01T00:00:00Z' }
      }
    });
    assert.deepEqual(Object.keys(m.entries), ['http://a.example.com/']);
    assert.deepEqual(m.exclude, ['http://never-captured.example.com/']);
  });

  it('fails loud on an unknown version — never silently treated as understood', () => {
    assert.throws(() => validateManifest({ version: 3, entries: {} }), /unsupported version 3/);
    assert.throws(() => validateManifest({ entries: {} }), /unsupported version/);
  });

  it('fails loud on an unparseable wayback URL — a capture no mirror could serve', () => {
    assert.throws(
      () => validateManifest({ version: 2, entries: { 'http://a/': { wayback: 'https://example.com/not-wayback' } } }),
      /unparseable wayback URL/
    );
  });

  it('rejects malformed sections with context', () => {
    assert.throws(() => validateManifest([], 'x.json'), /x\.json: invalid manifest/);
    assert.throws(() => validateManifest({ version: 2, entries: [] }), /`entries` must be an object/);
    assert.throws(() => validateManifest({ version: 2, entries: {}, exclude: [1] }), /`exclude` must be an array/);
    assert.throws(
      () => validateManifest({ version: 2, entries: {}, rewrites: { 'http://a/': '' } }),
      /rewrite target/
    );
  });
});

describe('readManifest / writeManifest', () => {
  it('round-trips, writing canonical v2 (sorted keys, empties omitted, trailing newline)', () => {
    const file = path.join(tmpdir(), 'wayback.json');
    const m = emptyManifest();
    m.entries['http://z.example.com/'] = { wayback: WB_A, timestamp: '20100101000000' };
    m.entries['http://b.example.com/post'] = { wayback: WB_B, timestamp: '20140403040000' };
    writeManifest(file, m);

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    const raw = JSON.parse(text);
    assert.deepEqual(Object.keys(raw), ['version', 'entries']); // no empty rewrites/exclude
    assert.equal(raw.version, 2);
    assert.deepEqual(Object.keys(raw.entries), ['http://b.example.com/post', 'http://z.example.com/']);
    assert.deepEqual(readManifest(file), m); // deepEqual is key-order-blind: same content
  });

  it('a v1 file on disk reads as v2 with its nulls excluded', () => {
    const file = path.join(tmpdir(), 'wayback.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          'http://a.example.com/': { wayback: WB_A, timestamp: '20100101000000' },
          'http://gone.example.com/': { wayback: null, timestamp: null }
        }
      })
    );
    const m = readManifest(file);
    assert.deepEqual(m.exclude, ['http://gone.example.com/']);
    assert.deepEqual(Object.keys(m.entries), ['http://a.example.com/']);
  });

  it('canonicalize returns EXACTLY the object writeManifest serializes (one canonical form)', () => {
    const file = path.join(tmpdir(), 'wayback.json');
    const m = emptyManifest();
    m.rewrites['http://moved.example.com/'] = 'https://mirror.example.net/';
    m.entries['http://a.example.com/'] = { wayback: WB_A, timestamp: '20100101000000' };
    m.exclude.push('https://live.example.com/', 'https://live.example.com/'); // deduped on the way out
    writeManifest(file, m);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(canonicalize(m), null, 2)}\n`);
    assert.deepEqual(Object.keys(canonicalize(m)), ['version', 'rewrites', 'entries', 'exclude']);
    assert.deepEqual(canonicalize(m).exclude, ['https://live.example.com/']);
  });
});

/* ------------------------------------------------------------------------ *
 * extractArchiveUrls — the applied-source scanner
 * ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ *
 * sourceRefs — per-file enumeration, paths as identity
 * ------------------------------------------------------------------------ */

describe('sourceRefs', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'post.md');
  fs.writeFileSync(
    file,
    [
      `Inline [a](${WB_A}) and the same [again](${WB_A}), plus [b](${WB_B}).`,
      'A live link that is not a wayback ref: [x](https://example.com/).'
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'wayback.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'http://c.example.com/': {
          wayback: 'https://web.archive.org/web/20200101000000/http://c.example.com/',
          timestamp: '20200101000000'
        },
        'http://never.example.com/': { wayback: null, timestamp: null }
      }
    })
  );

  it('inline-only by default, deduped, the file path as identity', () => {
    const refs = sourceRefs(file);
    assert.deepEqual(
      refs.map(r => [r.path, r.source, r.timestamp]),
      [
        [file, 'inline', '20100101000000'],
        [file, 'inline', '20140403040000']
      ]
    );
  });

  it('manifest: true folds in the sibling wayback.json (excludes reference nothing)', () => {
    const refs = sourceRefs(file, { manifest: true });
    assert.deepEqual(
      refs.map(r => [r.source, r.originalUrl]),
      [
        ['inline', 'http://a.example.com/'],
        ['inline', 'http://b.example.com/post'],
        ['manifest', 'http://c.example.com/']
      ]
    );
    assert.ok(!refs.some(r => r.originalUrl.includes('never')));
  });

  it('a missing source file still enumerates the sibling manifest', () => {
    const refs = sourceRefs(path.join(dir, 'absent.md'), { manifest: true });
    assert.deepEqual(refs.map(r => r.source), ['manifest']);
  });

  it('throws with path + url context on an unparseable inline wayback URL', () => {
    const badFile = path.join(dir, 'bad.md');
    fs.writeFileSync(badFile, '[bad](https://web.archive.org/web/notdigits)');
    assert.throws(() => sourceRefs(badFile), new RegExp(`bad\\.md \\(inline\\): unparseable`));
  });
});

/* ------------------------------------------------------------------------ *
 * apply — precedence exclude → rewrites → entries → untouched+warn
 * ------------------------------------------------------------------------ */

describe('apply', () => {
  const manifest = () => {
    const m = emptyManifest();
    m.entries['http://a.example.com/'] = { wayback: WB_A, timestamp: '20100101000000' };
    return m;
  };

  it('rewrites entry urls to their replay form', () => {
    const { content, warnings } = apply('See [a](http://a.example.com/).', manifest());
    assert.equal(content, `See [a](${WB_A}).`);
    assert.deepEqual(warnings, []);
  });

  it('exclude wins over an entry for the same url — fails safe', () => {
    const m = manifest();
    m.exclude.push('http://a.example.com/');
    const { content, warnings } = apply('See [a](http://a.example.com/).', m);
    assert.equal(content, 'See [a](http://a.example.com/).');
    assert.deepEqual(warnings, []);
  });

  it('rewrites win over entries; a rewrite target is used verbatim', () => {
    const m = manifest();
    m.rewrites['http://a.example.com/'] = 'https://newhome.example.com/';
    const { content } = apply('See [a](http://a.example.com/).', m);
    assert.equal(content, 'See [a](https://newhome.example.com/).');
  });

  it('a url with no verdict anywhere stays untouched AND warns', () => {
    const { content, warnings } = apply('See [u](http://unknown.example.com/).', manifest());
    assert.equal(content, 'See [u](http://unknown.example.com/).');
    assert.deepEqual(warnings, ['http://unknown.example.com/']);
  });

  it('matches scheme/slash/port-insensitively (the importer-proven key)', () => {
    const m = emptyManifest();
    // The archive's canonical spelling: https + :443-free root; the author
    // wrote plain http without the trailing slash.
    m.entries['https://www.a.example.com/'] = { wayback: WB_A, timestamp: '20100101000000' };
    const { content, warnings } = apply('See [a](http://a.example.com).', m);
    assert.equal(content, `See [a](${WB_A}).`);
    assert.deepEqual(warnings, []);
  });

  it('never rewrites (or warns about) fenced code, link text, or archive urls', () => {
    const m = manifest();
    const source = [
      '[http://a.example.com/](http://a.example.com/)', // text stays, target rewrites
      '```',
      'curl http://a.example.com/ http://unknown.example.com/',
      '```',
      `Already applied: [x](${WB_A}).`
    ].join('\n');
    const { content, warnings } = apply(source, m);
    assert.equal(
      content,
      [
        `[http://a.example.com/](${WB_A})`,
        '```',
        'curl http://a.example.com/ http://unknown.example.com/',
        '```',
        `Already applied: [x](${WB_A}).`
      ].join('\n')
    );
    assert.deepEqual(warnings, []);
  });

  it('the normalize equation: applying a v1-read manifest reproduces the rendered form', () => {
    // index.md ≡ apply(README.md, wayback.json) — the importer's three-file
    // contract, expressed through the library. A null entry (legacy
    // not-archived) reads as exclude and leaves its link live, unwarned.
    const readme = [
      'A [dead link](http://a.example.com/) and a [checked-live one](http://never.example.com/).',
      '',
      '[ref]: http://b.example.com/post'
    ].join('\n');
    const v1 = validateManifest({
      version: 1,
      entries: {
        'http://a.example.com/': { wayback: WB_A, timestamp: '20100101000000' },
        'http://b.example.com/post': { wayback: WB_B, timestamp: '20140403040000' },
        'http://never.example.com/': { wayback: null, timestamp: null }
      }
    });
    const { content, warnings } = apply(readme, v1);
    assert.equal(
      content,
      [
        `A [dead link](${WB_A}) and a [checked-live one](http://never.example.com/).`,
        '',
        `[ref]: ${WB_B}`
      ].join('\n')
    );
    assert.deepEqual(warnings, []);
  });
});

/* ------------------------------------------------------------------------ *
 * generate — classification order, subset baking, idempotence
 * ------------------------------------------------------------------------ */

describe('generate', () => {
  const SOURCE = [
    'A [dead](http://dead.example.com/) link, a [moved](http://moved.example.com/) one,',
    'a [live](https://live.example.com/keep) one, and a [gone](http://gone.example.com/) one.'
  ].join('\n');
  const UNIVERSE = {
    rewrites: { 'http://moved.example.com/': 'https://newhome.example.com/' },
    exclude: ['https://live.example.com/']
  };
  const SNAPSHOT = {
    url: 'https://web.archive.org/web/20100101000000/http://dead.example.com/',
    timestamp: '20100101000000'
  };

  /** A scripted resolver that records its calls. */
  const resolver = () => {
    const calls = [];
    return {
      calls,
      resolve: async (url, opts) => {
        calls.push({ url, ...opts });
        if (url === 'http://dead.example.com/') return SNAPSHOT;
        return null; // authoritatively not archived
      }
    };
  };

  it('classifies universe first (no network), then resolves only the rest', async () => {
    const { calls, resolve } = resolver();
    const { manifest, deferred, stats } = await generate(SOURCE, UNIVERSE, null, { resolve, near: '20100601' });

    // Universe hits never reached the resolver.
    assert.deepEqual(calls.map(c => c.url).sort(), ['http://dead.example.com/', 'http://gone.example.com/']);
    assert.deepEqual(calls.map(c => c.near), ['20100601', '20100601']);

    // Subset baking: the universe policy lands in the manifest, concretely.
    assert.deepEqual(manifest.rewrites, { 'http://moved.example.com/': 'https://newhome.example.com/' });
    // Not-archived spells exclude in v2 — alongside the policy-live url.
    assert.deepEqual(manifest.exclude.sort(), ['http://gone.example.com/', 'https://live.example.com/keep']);
    assert.equal(manifest.entries['http://dead.example.com/'].wayback, SNAPSHOT.url);
    assert.deepEqual(deferred, []);
    assert.deepEqual(stats, { urls: 4, fromUniverse: 2, fromSeen: 0, resolved: 2 });
  });

  it('appends verdicts to the returned seen, and a second generation costs zero network', async () => {
    const first = resolver();
    const run1 = await generate(SOURCE, UNIVERSE, emptyManifest(), { resolve: first.resolve });
    assert.equal(first.calls.length, 2);
    assert.equal(run1.seen.entries['http://dead.example.com/'].wayback, SNAPSHOT.url);
    assert.deepEqual(run1.seen.exclude, ['http://gone.example.com/']);

    const second = resolver();
    const run2 = await generate(SOURCE, UNIVERSE, run1.seen, { resolve: second.resolve });
    assert.equal(second.calls.length, 0, 'idempotent: everything answered from seen');
    assert.deepEqual(run2.manifest, run1.manifest);
    assert.deepEqual(run2.stats, { urls: 4, fromUniverse: 2, fromSeen: 2, resolved: 0 });
  });

  it('matches seen scheme/slash/port-insensitively, so respellings stay idempotent', async () => {
    const seen = validateManifest({
      version: 2,
      entries: {
        'https://dead.example.com': { wayback: SNAPSHOT.url, timestamp: SNAPSHOT.timestamp }
      },
      exclude: ['http://gone.example.com']
    });
    const { calls, resolve } = resolver();
    const { manifest } = await generate(SOURCE, UNIVERSE, seen, { resolve });
    assert.equal(calls.length, 0);
    // The manifest keys stay in the SOURCE's spelling.
    assert.deepEqual(Object.keys(manifest.entries), ['http://dead.example.com/']);
    assert.ok(manifest.exclude.includes('http://gone.example.com/'));
  });

  it('a resolver throw defers the url — recorded, retried next run, never guessed', async () => {
    const resolve = async url => {
      if (url === 'http://dead.example.com/') throw new Error('CDX timeout');
      return null;
    };
    const { manifest, seen, deferred } = await generate(SOURCE, UNIVERSE, emptyManifest(), { resolve });
    assert.deepEqual(deferred, [{ url: 'http://dead.example.com/', error: 'CDX timeout' }]);
    assert.ok(!('http://dead.example.com/' in manifest.entries));
    assert.ok(!('http://dead.example.com/' in seen.entries), 'a deferral never enters seen');
  });

  it('the emitted manifest round-trips through write/read', async () => {
    const { resolve } = resolver();
    const { manifest } = await generate(SOURCE, UNIVERSE, null, { resolve });
    const file = path.join(tmpdir(), 'wayback.json');
    writeManifest(file, manifest);
    const back = readManifest(file);
    assert.deepEqual(back.entries, manifest.entries);
    assert.deepEqual(back.rewrites, manifest.rewrites);
    assert.deepEqual(back.exclude, [...new Set(manifest.exclude)].sort());
  });
});
