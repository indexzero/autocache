# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🆕 Added
- **GitHub repo-root probe before a deep-link 404 counts as gone**: `backfill` and `generate` probe the repo root of a `github.com` deep link that the archive lacks. A renamed repo becomes a rewrite candidate (`.refetch/renamed.jsonl`, `manifest.rewrites`), and a default port (`github.com:80`) still matches. An inconclusive reply defers the link instead of writing a terminal record. Inconclusive replies are a 403, 408, 429, or 5xx, a redirect off GitHub or without a Location, and a network error. (#13)
- **`noRewrite` in the manifest**: an optional list of URLs the author never wants rewritten. `apply` leaves a listed URL as written and never warns, ahead of `exclude`, `rewrites`, and `entries`. `generate` skips a listed URL (no universe bake, no seen verdict, no archive call) and copies the whole set into the new manifest. The `manifest` command carries the set forward from the previous file at `-o`. Every section matches with the same key, which folds the scheme, a trailing slash, and a default port. (#14)
- **Per-FQDN behaviors in the universe**: an optional `fqdns` map, for example `"github.com": { "on404": "probe-repo-root-follow-rename" }`. Keys are bare lowercase FQDNs, and behavior names and values come from the closed `FQDN_BEHAVIORS` table, so a typo fails validation. `fqdnBehavior(universe, url)` looks up the exact host, and `subset` never bakes `fqdns` into a manifest. (#14)

### 🚧 Changed
- **`remaster verify` reports upstream URLs by class**: the static escape layer lists every distinct upstream URL instead of a byte count. Each entry carries the store key it resolves to, a class, a document count, and the next command. A rewriter miss (`inStore`), a fetchable gap (`inRecordedFrontier`, `novelResource`), a `bare` reference, or an `unresolved` original fails the layer. The gate loosens for two classes. An out-of-scope page link (`novelPage`) now advises, and the layer excludes a beacon or pseudo URL (`unmirrorable`). The old scan failed both. Keys follow the store's keying. Markup and attribute values decode `&amp;`, raw text (`<script>`, `<style>`, `<xmp>`, comments) keeps it, and the `#fragment` drops from every compared key. An HTML tokenizer (`parse5`) supplies the tag names, attribute spans, and content states. Only a navigational position is a page link: `<a href>`, `<area href>`, `<form action>`, or a `<link>` whose every `rel` token is `next`, `prev`, `canonical`, or `alternate`. Every other URL position, CSS `url()` included, is a resource whatever its extension. The `--json` report adds a `residual` object with the full classified list. (#12)

### 💥 Breaking
- **`remaster verify` reads sidecar v3 only**: the tree reader rejects a v1, v2, or unknown sidecar with `unsupported sidecar version N`. No reader or fallback exists for an older shape. Rebuild a remastered tree from a current store before you verify it. (#12)
- **The manifest reader accepts version 2 only**: `readManifest` and `validateManifest` reject a version 1 manifest with `invalid manifest — unsupported version 1 (supported: 2)`. Every entry needs a non-null `wayback` URL, and a reader never converts a `wayback: null` entry into an exclusion. Rewrite such a file as version 2 with the URL under `exclude`. The `SUPPORTED_MANIFEST_VERSIONS` export is gone. (#14)
