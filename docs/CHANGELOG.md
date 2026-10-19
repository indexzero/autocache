# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🆕 Added
- **GitHub repo-root probe before a deep-link 404 counts as gone**: `backfill` and `generate` probe the repo root of a `github.com` deep link that the archive lacks, and a renamed repo becomes a rewrite candidate (`.refetch/renamed.jsonl`, `manifest.rewrites`). A default port (`github.com:80`) still matches, and an inconclusive reply (403, 408, 429, 5xx) defers instead of writing a terminal record. (#13)
- **`noRewrite` in the manifest**: an optional list of URLs the author never wants rewritten. `apply` leaves a listed URL as written and never warns, ahead of `exclude`, `rewrites`, and `entries`. `generate` skips a listed URL (no universe bake, no seen verdict, no archive call) and copies the whole set into the new manifest. The `manifest` command carries the set forward from the previous file at `-o`. Every section matches with the same key, which folds the scheme, a trailing slash, and a default port.
- **Per-FQDN behaviors in the universe**: an optional `fqdns` map, for example `"github.com": { "on404": "probe-repo-root-follow-rename" }`. Keys are bare lowercase FQDNs, and behavior names and values come from the closed `FQDN_BEHAVIORS` table, so a typo fails validation. `fqdnBehavior(universe, url)` looks up the exact host, and `subset` never bakes `fqdns` into a manifest.

### 🚧 Changed
- **`remaster verify` reports upstream URLs**: the static escape layer now lists every distinct upstream URL it finds instead of a byte count. Each entry carries its resolved store key, a class (`inStore`, `inRecordedFrontier`, `novelResource`, `bare`, `unresolved`, `novelPage`, `unmirrorable`), and the next command to run. A rewriter miss, a fetchable gap, or a bare `archive.org` reference fails the layer, an out-of-scope page link is advisory, and a beacon is excluded. The `--json` report adds a `residual` object with the full classified list. (#12)

### 🐛 Fixed
- **Upstream keys follow the store's keying**: `&amp;` in HTML markup is decoded the way the store keys it, and stays raw inside `<script>` and `<style>` text. A `#fragment` is dropped from the lookup key on both sides, so a fragment variant matches its stored or recorded capture. (#12)
- **A quoted `>` in an attribute does not end a tag early**: the raw-text span detector walks attributes the way an HTML tokenizer does, so a `src` after `data-note="a > b"` still resolves to its stored capture. (#12)
- **A keyless `archive.org` reference goes through `isUnmirrorable`**: a replay URL whose original is not a URL with a host (a relative path, a bare `/`) now fails as `unresolved`. Only an original the shared predicate exempts (`javascript:`, `data:`, `mailto:`) stays excluded. (#12)

### 💥 Breaking
- **The manifest reader accepts version 2 only**: `readManifest` and `validateManifest` reject a version 1 manifest with `invalid manifest — unsupported version 1 (supported: 2)`. Every entry needs a non-null `wayback` URL, and a reader never converts a `wayback: null` entry into an exclusion. Rewrite such a file as version 2 with the URL under `exclude`. The `SUPPORTED_MANIFEST_VERSIONS` export is gone.
