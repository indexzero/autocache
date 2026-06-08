# waybackify

Transform dead links into Internet Archive Wayback Machine permalinks.

## Usage

### `waybackify(url, options)`

Transform a single URL into a Wayback Machine permalink.

**Parameters:**
- `url` _{string}_ - The URL to waybackify
- `options` _{Object}_ - Optional configuration
  - `timestamp` _{string}_ - Preferred timestamp (YYYYMMDDHHMMSS format)
  - `wayback` _{WaybackMachine}_ - Custom wayback instance

**Returns:** `Promise<string|null>` - Wayback URL or null if not found

```js
import waybackify from 'waybackify';

// Transform a dead link
const waybackUrl = await waybackify('http://registry.nodejitsu.com/');
console.log(waybackUrl);
// https://web.archive.org/web/20140328051253/http://registry.nodejitsu.com/

// With a specific timestamp
const specificUrl = await waybackify('http://example.com/', { 
  timestamp: '20200101000000' 
});
```

### `waybackifyBatch(urls, options)`

Transform multiple URLs into Wayback Machine permalinks.

**Parameters:**
- `urls` _{Array<string>}_ - Array of URLs to waybackify
- `options` _{Object}_ - Optional configuration

**Returns:** `Promise<Array<{url: string, waybackUrl: string|null}>>` - Results array

```js
import { waybackifyBatch } from 'waybackify';

const urls = [
  'http://registry.nodejitsu.com/',
  'https://the-pastry-box-project.net/charlie-robbins/2014-April-3',
  'http://quotedprintable.com/pages/scribbish'
];

const results = await waybackifyBatch(urls);
results.forEach(result => {
  console.log(`${result.url} -> ${result.waybackUrl || 'NOT FOUND'}`);
});
```

### `waybackifyMarkdown(markdown, options)`

Transform markdown content by replacing dead links with wayback URLs.

**Parameters:**
- `markdown` _{string}_ - Markdown content to process
- `options` _{Object}_ - Optional configuration
  - `domains` _{Array<string>}_ - Only process links from these domains
  - `dryRun` _{boolean}_ - Don't replace, just report (default: false)
  - `wayback` _{WaybackMachine}_ - Custom wayback instance

**Returns:** `Promise<{content: string, replacements: Array}>` - Transformed content and replacement info

```js
import { waybackifyMarkdown } from 'waybackify';

const markdown = `
# My Blog Post

Check out [this dead link](http://registry.nodejitsu.com/) that no longer works.

And here's a [reference link][1] format.

[1]: http://quotedprintable.com/pages/scribbish
`;

// Process only specific domains
const result = await waybackifyMarkdown(markdown, {
  domains: ['registry.nodejitsu.com', 'quotedprintable.com']
});

console.log(result.content); // Markdown with wayback URLs
console.log(`Replaced ${result.replacements.length} links`);

// Dry run to see what would be replaced
const dryRun = await waybackifyMarkdown(markdown, { dryRun: true });
dryRun.replacements.forEach(replacement => {
  console.log(`Would replace: ${replacement.url} -> ${replacement.waybackUrl}`);
});
```

### `WaybackMachine` Class

Direct access to the Internet Archive Wayback Machine API.

```js
import { WaybackMachine } from 'waybackify';

const wayback = new WaybackMachine();

// Get the closest archived snapshot
const snapshot = await wayback.getSnapshot('http://registry.nodejitsu.com/');
if (snapshot) {
  console.log(`Archived at: ${snapshot.url}`);
  console.log(`Timestamp: ${snapshot.timestamp}`);
}

// Get multiple snapshots
const snapshots = await wayback.getSnapshots('http://nodejitsu.com/', {
  from: '20140101',
  to: '20141231',
  limit: 10
});

snapshots.forEach(snapshot => {
  console.log(`${snapshot.timestamp}: ${snapshot.waybackUrl}`);
});
```

## Error Handling

The library gracefully handles various error conditions:

```js
// URLs that don't exist in the archive return null
const notFound = await waybackify('http://this-definitely-does-not-exist.com/');
console.log(notFound); // null

// Non-HTTP URLs are ignored
const invalid = await waybackify('mailto:test@example.com');
console.log(invalid); // null

// Already wayback URLs are returned as-is
const existing = await waybackify('https://web.archive.org/web/20210101000000/http://example.com/');
console.log(existing); // https://web.archive.org/web/20210101000000/http://example.com/
```

## Common Use Cases

### Blog Migration

When migrating old blog posts, many external links become dead over time:

```js
import { waybackifyMarkdown } from 'waybackify';
import { readFile, writeFile } from 'fs/promises';

const markdown = await readFile('old-blog-post.md', 'utf8');

// Only process known dead domains
const result = await waybackifyMarkdown(markdown, {
  domains: [
    'registry.nodejitsu.com',
    'live.visitmix.com',
    'the-pastry-box-project.net',
    'quotedprintable.com'
  ]
});

await writeFile('updated-blog-post.md', result.content);
console.log(`Updated ${result.replacements.length} dead links`);
```

### Content Audit

Find and report dead links without making changes:

```js
import { waybackifyMarkdown } from 'waybackify';
import { glob } from 'glob';

const files = await glob('content/**/*.md');

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const result = await waybackifyMarkdown(content, { dryRun: true });
  
  if (result.replacements.length > 0) {
    console.log(`\n${file}:`);
    result.replacements.forEach(r => {
      console.log(`  ${r.url} -> ${r.waybackUrl || 'NOT ARCHIVED'}`);
    });
  }
}
```

## Implementation Details

- Uses the Internet Archive Wayback Machine API directly
- Implements custom `undici` Agent with extended timeouts for reliable requests
- Handles both inline `[text](url)` and reference-style `[text]: url` markdown links
- Preserves existing wayback URLs to avoid double-processing
- Gracefully handles API failures and missing archives

## License

MIT © [Charlie Robbins](https://github.com/indexzero)