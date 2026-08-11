# autocache

**Remaster the web for the future, together.**

autocache builds a self-hosted, self-contained mirror of Wayback Machine
captures — fetch, cache, remaster (strip archive.org chrome and localize links
so a page renders with nothing off-host), verify, and serve.

## Packages

| package | what it does |
|---|---|
| [`@autocache/waybackify`](src/waybackify) | core library — manifests, link rewriting, the cache store, key derivation |
| [`@autocache/waybackify-cli`](src/waybackify-cli) | the CLI — `manifest` · `rewrite` · `cache` · `remaster` · `bucket` |
| [`@autocache/waybackify-crawl`](src/waybackify-crawl) | the crawl engine + remaster-verify |
| [`@autocache/waybackify-serve`](src/waybackify-serve) | the edge server — Node, Cloudflare Workers, and Fastly Compute |

## Quickstart

```sh
pnpm install
pnpm -r test
```

Requires Node ≥ 24 (the serve tests run TypeScript directly) and pnpm 10.

## Design docs

Under [`src/waybackify-cli/docs/`](src/waybackify-cli/docs):

- [SCENE.GRAPH.md](src/waybackify-cli/docs/SCENE.GRAPH.md) — the multi-representation crawl model: a URL is a family of renderings, not one artifact
- [REMASTER.md](src/waybackify-cli/docs/REMASTER.md) — the standalone remaster tier (no archive.org byte survives)
- [CACHE.md](src/waybackify-cli/docs/CACHE.md) · [CRAWLERS.md](src/waybackify-cli/docs/CRAWLERS.md) · [SERVE.md](src/waybackify-cli/docs/SERVE.md) · [SYNC.md](src/waybackify-cli/docs/SYNC.md) · [GC.md](src/waybackify-cli/docs/GC.md)

## License

[Apache-2.0](LICENSE) © Charlie Robbins
