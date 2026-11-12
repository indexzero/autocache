# @autocache/waybackify-site

The whole-site source for the wayback mirror.

A source tells the cache pipeline which captures to fetch. The
[`waybackify`](../waybackify) library ships one: a markdown file, resolved
into a `wayback.json` manifest. This package is the second. It enumerates a
**site** — a set of CDX queries inside a date window — into a **capture
list** (`captures.jsonl`) holding one row per distinct version of every URL.
From there the ordinary pipeline takes over: `cache fill`, `cache remediate`,
`cache verify`, `cache status`.

It also exports a filled cache root as a `<host>/<timestamp>/<path>` tree.

Design and runbook: [docs/SITE.md](../../docs/SITE.md).

## From the CLI

The [`waybackify`](../waybackify-cli) CLI wires this package in as the `site`
group:

```sh
waybackify site enumerate sites.json --ledger ledger
waybackify cache fill ledger --root "$ROOT" --converge
waybackify site export ledger --root "$ROOT" --out raw/web
```

## From code

```js
import { readSiteConfig, enumerate, exportTree } from '@autocache/waybackify-site';

const config = readSiteConfig('sites.json');

// CDX index → <ledger>/<site>/captures.jsonl (+ cdx/, redirects.jsonl,
// inventory.jsonl, summary.json). Deterministic; `offline: true` rebuilds
// from the saved CDX pages with no network.
const { sites } = await enumerate(config, { ledger: 'ledger' });
// sites['example.org'] → { rows, okUrls, versions, maxVersionsPerUrl, redirects }

// A filled cache root → a browsable tree. Synchronous; returns the counts.
const summary = exportTree(root, 'raw/web', { ledger: 'ledger' });
```

| export | what it is |
|---|---|
| `readSiteConfig(file)`, `validateSiteConfig(raw)` | The site config: `window`, `cdx`, `sites[].queries`, `rules`. Fails loud on a malformed part. |
| `enumerate(config, options)` | The enumerator. `options`: `ledger` (required), `sites`, `offline`, `redirects`, `repickFrom`, plus the `fetch`, `sleep`, and `onProgress` seams. |
| `selectVersions(rows, options)` | The pure half: CDX rows in, the inventory, the capture list, and the counts out. |
| `exportTree(root, out, options)` | The path-tree export. `options`: `ledger`, `dryRun`. |
| `planPath(key)` | The path one capture key exports to, before collision handling. Pure. |

## The config

```json
{
  "window": { "from": "2002", "to": "2007" },
  "sites": [
    { "name": "example.org",
      "queries": [ { "url": "example.org", "matchType": "domain" } ] }
  ],
  "rules": [ { "host": "wiki.example.org", "html": "raw" } ]
}
```

`matchType` is `exact`, `prefix`, `host`, or `domain`. A `rules` entry marks
a host's HTML `raw`: fetched with `id_`, so `cache fill` does no requisite
fan-out for it. Non-HTML is always listed raw. Every key is described in
[docs/SITE.md](../../docs/SITE.md#the-site-config).

## Dependency direction

This package imports `@autocache/waybackify`: `cdx.js` for the paged index
walk, `ledger.js` for the capture-list file name and the capture-level join,
`cache.js` and `key.js` for the store. The library does not import this
package and has no notion of a site. It knows capture lists.

## Development

```sh
pnpm --filter @autocache/waybackify-site run test   # offline, zero network
```

The CDX pages under `test/fixtures/cdx/` are real rows from the index, cut
down to a handful of URLs. The archive itself is a mock fetch.
