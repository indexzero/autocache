# autocache

autocache builds a self-hosted, self-contained mirror of Internet Archive Wayback Machine captures.

A Wayback capture renders only while archive.org serves its chrome and assets. autocache fetches those captures into a local store, strips the archive.org chrome, and localizes every reference. The result is a tier of pages that render with nothing off-host. You serve that tier from your own host or an edge bucket.

## Requirements

- Node >= 24 (the server runs TypeScript directly through type-stripping).
- pnpm 10.
- For edge deployment: `s5cmd` and `rclone` on PATH (see [docs/SYNC.md](docs/SYNC.md)).

## Install

```sh
pnpm install
```

The CLI package puts a `waybackify` command on PATH. The server package puts a `waybackify-serve` command on PATH. From a checkout, run either one through pnpm:

```sh
pnpm --filter @autocache/waybackify-cli exec waybackify --help
```

## The pipeline

These steps build one mirror from a content tree to a served site. The local cache root is the source of truth, and every step resumes on re-run.

1. Generate a capture manifest for each markdown source.

   ```sh
   waybackify manifest post.md -u universe.json -o wayback.json
   ```

   The manifest maps every dead link in the source to a Wayback replay URL.

2. Populate the hermetic cache root from the ledger of manifests.

   ```sh
   waybackify cache fill ./content --root ./cache
   ```

   This fetches each referenced capture and its static requisites: images, stylesheets, and scripts. It is resumable and paces itself.

3. Crawl the documents to dynamic completeness.

   ```sh
   waybackify cache crawl --root ./cache --ledger ./content
   ```

   A browser renders each page and records the runtime assets the static parse missed. The step needs `agent-browser`.

4. Verify the cache root against its own sidecars.

   ```sh
   waybackify cache verify --root ./cache
   ```

   The command re-hashes every stored body and reports corruption, orphans, and short requisite closures.

5. Remaster the hermetic root into a standalone tier.

   ```sh
   waybackify remaster build ./cache ./remastered
   ```

   The build strips archive.org chrome and localizes every satisfiable reference. The same input yields a byte-identical output.

6. Verify that the remastered tier stands alone.

   ```sh
   waybackify remaster verify --root ./remastered --hermetic ./cache --tier static,dynamic
   ```

   The static tier scans for archive.org escapes. The dynamic tier renders pages and verifies each one reaches nothing off-host.

7. Serve the mirror from the remastered root.

   ```sh
   waybackify-serve --root ./remastered --port 8080
   ```

   The server reads the store directly and applies no per-request transform. Without `--port` it binds an ephemeral port.

### Deploy to the edge

These steps push the store to an S3-compatible bucket and serve from it. The examples use `$ENDPOINT` for the S3 endpoint and a `remote` defined in `rclone.conf` (see [docs/SYNC.md](docs/SYNC.md)).

1. Create a zero-byte scratch file for bodiless entries.

   ```sh
   EMPTY="$(mktemp)"
   ```

2. Emit and run the body-upload batch.

   ```sh
   waybackify bucket push --root ./remastered --bucket my-mirror --empty-file "$EMPTY" | s5cmd --endpoint-url "$ENDPOINT" run
   ```

3. Copy the sidecar objects.

   ```sh
   rclone copy ./remastered/meta remote:my-mirror/meta
   ```

4. Verify the bucket against the local root.

   ```sh
   waybackify bucket verify --root ./remastered --bucket my-mirror --endpoint "$ENDPOINT"
   ```

5. Serve from the bucket.

   ```sh
   waybackify-serve --bucket my-mirror --endpoint "$ENDPOINT" --port 8080
   ```

The server also runs on Cloudflare Workers and Fastly Compute.

## Packages

| Package | Role |
|---|---|
| [`@autocache/waybackify`](src/waybackify) | Core library: manifests, link rewriting, the cache store, and key derivation. |
| [`@autocache/waybackify-cli`](src/waybackify-cli) | The `waybackify` CLI: manifest, rewrite, ledger, check, search, audit, cache, remaster, bucket. |
| [`@autocache/waybackify-crawl`](src/waybackify-crawl) | The completeness crawler that drives documents to a dynamic-requisite fixpoint. |
| [`@autocache/waybackify-serve`](src/waybackify-serve) | The edge server for Node, Cloudflare Workers, and Fastly Compute. |

## Deep dives

Design and operations docs under [`docs/`](docs):

- [CACHE.md](docs/CACHE.md) — the on-disk cache root: identity-keyed bodies, authoritative sidecars, and the atomic write protocol.
- [BACKFILL.md](docs/BACKFILL.md) — `cache fill`: driving a cache root to full asset closure, paced and resumable.
- [REMASTER.md](docs/REMASTER.md) — the standalone remaster build: chrome stripped and references localized, deterministically.
- [SERVE.md](docs/SERVE.md) — the consumer contract for reading a cache root: hash the key, stat one sidecar.
- [SYNC.md](docs/SYNC.md) — the runbook for projecting a cache root onto Cloudflare R2 and Fastly Object Storage.
- [GC.md](docs/GC.md) — the garbage-collection design for pruning bucket projections (design only, unimplemented).
- [SCENE.GRAPH.md](docs/SCENE.GRAPH.md) — the multi-representation crawl model: a URL is a family of renderings, not one artifact.
- [CRAWLERS.md](docs/CRAWLERS.md) — a survey of prior art from other web crawlers and archivers.
- [WEBRECORDER.md](docs/WEBRECORDER.md) — an evaluation of Webrecorder-ecosystem tools against this pipeline.
- [PUBLISHING.md](docs/PUBLISHING.md) — the publish-readiness status of the packages.

## Tests

```sh
pnpm -r test
```

The suites run offline with no network calls.

## License

[Apache-2.0](LICENSE) © Charlie Robbins
