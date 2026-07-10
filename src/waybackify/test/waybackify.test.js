// Offline unit tests — URL parsing/classification and short-circuit paths
// only. Nothing here touches the network, so this file (plus
// waybackify-markdown.test.js, which injects a fake wayback) is what the
// default `pnpm test` / CI gate runs. The live Wayback Machine CDX tests
// live in waybackify-live.test.js behind WAYBACK_LIVE=1.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { waybackify, waybackifyBatch, waybackifyMarkdown, WaybackMachine } from '../index.js';

describe('WaybackMachine', () => {
  it('should create a WaybackMachine instance', () => {
    const wayback = new WaybackMachine();
    assert.ok(wayback instanceof WaybackMachine);
    assert.strictEqual(wayback.baseUrl, 'http://archive.org');
  });
});

describe('waybackify', () => {
  it('should return original URL if already wayback URL', async () => {
    const waybackUrl = 'https://web.archive.org/web/20210101000000/http://example.com/';
    const result = await waybackify(waybackUrl);
    assert.strictEqual(result, waybackUrl);
  });

  it('should return null for non-HTTP URLs', async () => {
    const result = await waybackify('mailto:test@example.com');
    assert.strictEqual(result, null);
  });

  it('should return null for ftp URLs', async () => {
    const result = await waybackify('ftp://example.com/file.txt');
    assert.strictEqual(result, null);
  });
});

describe('waybackifyBatch', () => {
  it('should handle empty URL array', async () => {
    const results = await waybackifyBatch([]);
    assert.strictEqual(results.length, 0);
  });
});

describe('waybackifyMarkdown', () => {
  it('should handle markdown with no links', async () => {
    const markdown = `
# Just a title

Some text without any links.
    `.trim();

    const result = await waybackifyMarkdown(markdown, { dryRun: true });

    assert.strictEqual(result.content, markdown);
    assert.strictEqual(result.replacements.length, 0);
  });

  it('should preserve existing wayback URLs', async () => {
    const waybackUrl = 'https://web.archive.org/web/20210101000000/http://example.com/';
    const markdown = `[Already wayback](${waybackUrl})`;

    const result = await waybackifyMarkdown(markdown, { dryRun: true });

    assert.strictEqual(result.replacements.length, 0);
    assert.strictEqual(result.content, markdown);
  });
});
