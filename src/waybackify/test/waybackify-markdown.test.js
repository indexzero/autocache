import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractLinks, waybackifyMarkdown } from '../index.js';

// Deterministic, offline wayback: every http(s) URL "has" an archive at a
// fixed timestamp, except hosts listed in `dead` (no snapshot → null).
function fakeWayback(dead = []) {
  return {
    async getSnapshot(url) {
      if (dead.some(d => url.includes(d))) return null;
      return { url: `https://web.archive.org/web/20140101000000/${url}`, available: true };
    }
  };
}
const archived = url => `https://web.archive.org/web/20140101000000/${url}`;

describe('extractLinks (pure detection for manifest generation)', () => {
  it('returns unique archivable URLs in document order; excludes the rest', () => {
    const md = [
      'inline [a](http://a.com/1)',
      'ref: [b][x]',
      '[x]: https://b.com/2',
      '<a href="http://c.com/3">c</a>',
      'bare http://a.com/1 again (dup)',
      'prose http://d.com/4',
      'image ![i](http://img.com/x.png)',
      'internal [h](/whoami) and [m](mailto:x@y.z)',
      'archived [z](https://web.archive.org/web/20200101000000/http://e.com)'
    ].join('\n');
    assert.deepEqual(extractLinks(md), [
      'http://a.com/1',
      'https://b.com/2',
      'http://c.com/3',
      'http://d.com/4'
    ]);
  });

  it('honors the skip (liveUrls) list', () => {
    const md = '[a](http://live.com/keep) [b](http://dead.com/x)';
    assert.deepEqual(extractLinks(md, { skip: ['http://live.com'] }), ['http://dead.com/x']);
  });
});

describe('waybackifyMarkdown — link forms', () => {
  const wayback = fakeWayback();

  it('archives an inline link', async () => {
    const { content } = await waybackifyMarkdown('see [x](http://a.com/p)', { wayback });
    assert.equal(content, `see [x](${archived('http://a.com/p')})`);
  });

  it('archives a reference definition, preserving label + indentation', async () => {
    const { content } = await waybackifyMarkdown('  [ref]: https://a.com/x "title"', { wayback });
    assert.equal(content, `  [ref]: ${archived('https://a.com/x')} "title"`);
  });

  it('archives an HTML anchor, preserving the tag', async () => {
    const { content } = await waybackifyMarkdown('<a href="http://a.com">t</a>', { wayback });
    assert.equal(content, `<a href="${archived('http://a.com')}">t</a>`);
  });

  it('archives a bare prose URL', async () => {
    const { content } = await waybackifyMarkdown('go to http://a.com/y now', { wayback });
    assert.equal(content, `go to ${archived('http://a.com/y')} now`);
  });
});

describe('waybackifyMarkdown — exclusions', () => {
  const wayback = fakeWayback();

  it('never archives an image embed', async () => {
    const md = '![alt](http://a.com/img.png)';
    const { content, replacements } = await waybackifyMarkdown(md, { wayback });
    assert.equal(content, md);
    assert.equal(replacements.length, 0);
  });

  it('leaves URLs in the skip (liveUrls) list — exact or prefix', async () => {
    const md = '[a](http://live.com/keep) and [b](http://dead.com/x)';
    const { content } = await waybackifyMarkdown(md, { wayback, skip: ['http://live.com'] });
    assert.ok(content.includes('[a](http://live.com/keep)')); // untouched
    assert.ok(content.includes(archived('http://dead.com/x'))); // archived
  });

  it('ignores internal/relative/anchor links and non-http schemes', async () => {
    const md = '[a](/whoami) [b](./rel) [c](#sec) [d](mailto:x@y.z)';
    const { content, replacements } = await waybackifyMarkdown(md, { wayback });
    assert.equal(content, md);
    assert.equal(replacements.length, 0);
  });

  it('leaves already-archived URLs alone', async () => {
    const md = `[a](${archived('http://a.com')})`;
    const { content } = await waybackifyMarkdown(md, { wayback });
    assert.equal(content, md);
  });

  it('leaves a link live when no snapshot exists (null)', async () => {
    const md = '[a](http://gone.com/x)';
    const { content } = await waybackifyMarkdown(md, { wayback: fakeWayback(['gone.com']) });
    assert.equal(content, md);
  });

  it('filters by domains when provided', async () => {
    const md = '[a](http://a.com/x) [b](http://b.com/y)';
    const { content } = await waybackifyMarkdown(md, { wayback, domains: ['b.com'] });
    assert.ok(content.includes('[a](http://a.com/x)')); // a.com not in domains → untouched
    assert.ok(content.includes(archived('http://b.com/y')));
  });
});

describe('waybackifyMarkdown — robustness', () => {
  const wayback = fakeWayback();

  it('is idempotent (second pass changes nothing)', async () => {
    const md = 'x http://a.com/1 and [y](http://a.com/2)';
    const once = (await waybackifyMarkdown(md, { wayback })).content;
    const twice = (await waybackifyMarkdown(once, { wayback })).content;
    assert.equal(twice, once);
  });

  it('handles repeated identical URLs without corruption', async () => {
    const md = 'http://a.com/z then http://a.com/z';
    const { content } = await waybackifyMarkdown(md, { wayback });
    assert.equal(content, `${archived('http://a.com/z')} then ${archived('http://a.com/z')}`);
  });

  it('dryRun reports replacements without mutating', async () => {
    const md = '[a](http://a.com/x)';
    const { content, replacements } = await waybackifyMarkdown(md, { wayback, dryRun: true });
    assert.equal(content, md);
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].waybackUrl, archived('http://a.com/x'));
  });
});
