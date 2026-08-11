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
import waybackify from '@autocache/waybackify';

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
import { waybackifyBatch } from '@autocache/waybackify';

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
import { waybackifyMarkdown } from '@autocache/waybackify';

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
import { WaybackMachine } from '@autocache/waybackify';

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
import { waybackifyMarkdown } from '@autocache/waybackify';
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
import { waybackifyMarkdown } from '@autocache/waybackify';
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

### Wayback-404 verdicts (`audit.js`)

A wayback URL can lie: web.archive.org returns HTTP 200 for a replay page
whose captured content is itself a 404, soft-error page, or parked domain.
`auditCapture` classifies one capture:

```js
import { auditCapture } from '@autocache/waybackify';

const v = await auditCapture('https://web.archive.org/web/20081221144742/http://blogs.msdn.com:80/mharsh/archive/2008/03/05/slides-and-demos-from-my-mix-08-talk.aspx');
// { verdict: 'good' | 'wayback404' | 'suspect',
//   statuscode, reason, evidence, checkedAt, url, timestamp, original }
```

Two signals, in order: the capture's own archived `statuscode` from the CDX
index (`WaybackMachine#getCapture` — captures archived AS 404/5xx are
`wayback404` immediately), then soft-404 content heuristics on the replay body
with the wayback toolbar chrome stripped (`stripWaybackChrome` +
`classifyReplayHtml`, both exported and pure). Uncertain is always `suspect`,
never silently `good`; every verdict carries a short `evidence` snippet for
human review.

## Manifest / Universe / Ledger

Three concepts, three modules — the whole model for maintaining archived
links across a body of markdown, with no directory-layout conventions
anywhere (file paths are identity):

- a **Manifest** (`manifest.js`) is one source file's `wayback.json` — a
  standalone rewrite program;
- a **Universe** (`universe.js`) is compile-time policy — global rewrites +
  excludes, consulted only while GENERATING manifests, never at rewrite time;
- the **Ledger** (`ledger.js`) is the COLLECTION — every manifest discovered
  under a tree.

### Manifest schema v2

```json
{
  "version": 2,
  "rewrites": { "<url>": "<replacement-url>" },
  "entries": {
    "<url>": {
      "wayback": "https://web.archive.org/web/<timestamp>/<url>",
      "timestamp": "<YYYYMMDDHHMMSS>",
      "checkedAt": "<ISO-8601>"
    }
  },
  "exclude": ["<url>"]
}
```

- `entries` — archive resolutions: rewrite each url to its `wayback` replay
  URL. Every `wayback` is non-null and parseable.
- `rewrites` (optional) — unconditional url → url substitutions, baked from
  the Universe subset whose URLs appear in THIS source.
- `exclude` (optional) — urls deliberately left untouched: policy-live links
  and confirmed-not-archived links alike. Replaces schema v1's
  `wayback: null` convention outright.

Readers (`readManifest`/`validateManifest`) accept versions **{1, 2}**: a v1
file's `wayback: null` entries read as `exclude` (the legacy-exclude
migration rule); any other version fails loud. `writeManifest` always emits
canonical v2 (sorted keys, empty optional sections omitted).

### Operations

```js
import { generate, apply, readManifest, writeManifest, sourceRefs } from '@autocache/waybackify/manifest.js';
import { readUniverse, subset } from '@autocache/waybackify/universe.js';
import { discover, flatten, against } from '@autocache/waybackify/ledger.js';

// GENERATE: markdown + universe (+ seen) → manifest. Universe hits are
// classified offline; previously seen urls are copied offline; only
// never-seen urls cost an archive round-trip (CDX, injectable). The
// returned `seen` — Manifest-shaped, read-write — carries every verdict
// forward, so re-generation is idempotent (zero network).
const { manifest, seen } = await generate(markdown, universe, previousSeen);

// APPLY: source + manifest → published form. Precedence per url:
// exclude → rewrites → entries → untouched + warn. Fenced code and link
// TEXT are never rewritten; the url matching is scheme/slash/port-
// insensitive (the importer-proven equation: index ≡ apply(readme, manifest)).
const { content, warnings } = apply(markdown, manifest);

// LEDGER: discovery under any tree, the union manifest (the seen-file
// bootstrap), and the fetch-worklist join against a local capture cache
// (unfetched / cached / interstitial / error, via the cache's own sidecar
// reader).
const ledger = discover(root);
const union = flatten(ledger);
const worklists = await against(ledger, cacheRoot);
```

`sourceRefs(file, { manifest })` enumerates one file's wayback references
(inline markdown refs, optionally the sibling `wayback.json`'s entries),
deduped and deterministically ordered — the per-file unit the CLI's
enumeration surface wraps.

## Implementation Details

- Uses the Internet Archive Wayback Machine API directly
- HTTP goes through [`impit`](https://github.com/apify/impit) (browser
  impersonation) with extended timeouts — the archive throttles naive bulk
  clients
- Handles both inline `[text](url)` and reference-style `[text]: url` markdown links
- Preserves existing wayback URLs to avoid double-processing
- Gracefully handles API failures and missing archives

## License

MIT © [Charlie Robbins](https://github.com/indexzero)