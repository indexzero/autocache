# examples/hypertext

An homage corpus, mirrored by the toolkit it honors.

The six sources under `content/` cite the voices that led to autocache —
the hypertext lineage, the temporal axis, the generative axis, the
mechanism layer, and the two hard things — organized the way the ideas
organize themselves. Running the pipeline turns those citations into a
self-contained wayback mirror: Bush served beside Nelson, Fowler's bliki
beside the RFCs it jokes about.

## Run it

From a published install:

```sh
npm install
npm run pipeline
```

Before first publish (or from a checkout), run the standalone smoke instead.
It packs the four workspace packages into tarballs, installs them into a
scratch consumer with plain npm — no workspace links anywhere — and runs the
same pipeline through the installed bins:

```sh
node smoke.mjs              # full closure; network-heavy, takes minutes
node smoke.mjs --fill-max 4 # bounded quick pass
node smoke.mjs --keep       # leave the scratch dir behind for inspection
```

The smoke is the go/no-go for publishing: it rehearses exactly what
`npm install @autocache/waybackify-cli` will do after the first release.

## What the pipeline does

1. `waybackify manifest` — resolve every citation link against the CDX API
   into a per-source `wayback.json`, sharing one `seen.json` union. A rerun
   answers from the union and makes zero network calls.
2. `waybackify ledger` — survey the manifests as one collection.
3. `waybackify cache fill` — fetch each referenced capture and its static
   requisites into `cache/`. Resumable; `FILL_MAX` bounds it.
4. `waybackify cache verify` — fsck the cache root against its own sidecars.
5. `waybackify remaster build` — strip archive.org chrome and localize every
   satisfiable reference into `remastered/`, deterministically.
6. `waybackify remaster verify --tier static` — scan the remastered tier for
   archive.org escapes.
7. `waybackify-serve --root remastered` — serve the mirror; the pipeline
   probes one capture and the index and expects 200s.

## What verify reports here

The pipeline treats verify findings as reports, not failures — they are
statements about these particular captures, and this corpus keeps two
around on purpose:

- The archived RFC 3986 — the URI specification itself — contains `ftp://`
  example URIs, which the archive serves as `ftp:`-scheme replay links. The
  localizer only repairs `http(s)` originals, so these stay foreign and the
  static tier reports them. The URI spec is the one page on the web that
  will always do this.
- Blog captures of their era carry `<link rel="alternate">` feed references.
  `href` on `<link>` is a subresource, deliberately corpus-gated (only
  user-initiated navigation localizes uncaptured), so an uncaptured feed
  stays foreign and is reported.

A corpus that needs a perfectly standalone static tier curates around both:
capture the feed, or exclude the source. This one prefers the honest report
— cache invalidation and naming things, after all.
