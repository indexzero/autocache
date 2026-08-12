---
status: "research — links binned after full research pass; no adoption decisions made here"
scope: "Webrecorder-ecosystem links provided by the owner, evaluated against the waybackify pipeline"
audience: "maintainers of waybackify-cli, waybackify-crawl, and waybackify-serve"
related:
  - "CRAWLERS.md"
  - "SCENE.GRAPH.md"
sources:
  - "links provided verbatim by the owner on 2026-08-07"
  - "all GitHub repos cloned locally to ~/Git/<org>/<repo> and read"
  - "Google Slides decks read via public text export"
  - "specs downloaded from specs.webrecorder.net and read"
on_conflict: "SCENE.GRAPH.md governs the coverage model; CACHE.md/SERVE.md govern current behavior; this document only maps candidates onto them"
---

# Webrecorder Ecosystem — Evaluated Intake

The owner supplied the links below for evaluation against the waybackify
pipeline. Every GitHub repo was cloned to `~/Git/<org>/<repo>` and read;
the three Google Slides decks were read in full via text export; the four
`specs.webrecorder.net` documents were downloaded and read. Each entry
carries a short summary of what it is and which aspect of the codebase it
could replace or inform.

Two links appeared twice in the intake (`mirror-adapt-centre`,
`browsertrix-crawler`); they are binned once.

## Bin 1 — Capture: browser-based crawling and behaviors

*Maps to: `waybackify-crawl` — page acquisition, deferred-representation
triggering, and the scene graph's execute-and-observe pass.*

- **[browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler)**
  (cloned: `~/Git/webrecorder/browsertrix-crawler`) +
  **[docs](https://crawler.docs.browsertrix.com/)** — Dockerized
  high-fidelity crawler driving parallel Brave windows via Puppeteer/CDP,
  capturing traffic to WARC/WACZ. It is the obvious candidate to replace
  the *acquisition* half of `waybackify-crawl` (rendering, behaviors,
  network capture) if we chose to consume WACZ instead of raw fetches —
  though one crawl still runs one environment (`--mobileDevice`,
  `--windowSize`, `--lang` are per-crawl), so the scene-graph environment
  matrix would sit *above* it as an orchestrator.
- **[custom-behaviors](https://github.com/webrecorder/custom-behaviors)**
  (cloned: `~/Git/webrecorder/custom-behaviors`) — community collection of
  site-specific behavior classes and DevTools Flow-Recorder JSON flows,
  loadable by URL/git path via `--customBehaviors`. Prior art for how
  per-site interaction scripts are packaged and versioned; would replace
  any bespoke per-site interaction scripting we grow in the crawl layer.
- **[ArchiveWeb.page](https://webrecorder.net/archiveweb.page)** (live
  page at [archiveweb.page](https://archiveweb.page/); the
  webrecorder.net path currently 404s) — Chrome extension + desktop app
  for *manual* capture-while-browsing, exporting WACZ replayable in
  ReplayWeb.page. Not a pipeline replacement, but the human-driven
  fallback for pages our crawler cannot negotiate (logins, CAPTCHAs) —
  the manual tier of the archive-ceiling policy.
- **Deck: "How to Develop a Browsertrix Behavior"** (Kreymer & Walsh,
  IIPC WAC 2025 workshop —
  [slides](https://docs.google.com/presentation/d/19LEQpc99NqCajEK7YIuoqRxHsvWx7FiF2flbZ9Fsxuw/edit))
  — taxonomy of behavior mechanisms: background (autoplay, autofetch,
  autoclick), autoscroll, site-specific, and three authoring tiers
  (autoclick selector → Flow Recorder JSON → custom JS class). Directly
  informs how the execute-and-observe pass should expose its interaction
  hooks rather than inventing a new idiom.
- **Deck: "High-Fidelity Social Media Archiving: Current State of the
  Art"** (Kreymer & Walsh, IIPC WAC 2026 —
  [slides](https://docs.google.com/presentation/d/12jLMPYpLR3s7Ucq2Hf_n4qOzjzv7pZrOgEN69VPq0jY/edit))
  — field report on logged-in profile management, logout/CAPTCHA
  detection ("Fail on Not Logged In"), per-platform rate-limit economics
  (26,594 posts case study). Mostly out of waybackify's scope (we mirror
  an upstream archive, not live social media), but the "single post page
  as capture unit; feeds only for URL discovery" pattern is a useful
  frontier-design precedent.

## Bin 2 — Serve/replay: mirror-shaped replay on the original URL space

*Maps to: `waybackify-serve` and the rewriter — this bin is the closest
existing analogue to the whole serving stack.*

- **[web-archive-site-mirror](https://github.com/webrecorder/web-archive-site-mirror)**
  (cloned: `~/Git/webrecorder/web-archive-site-mirror`) — a template
  (404.html + sw.js + init.js) that serves a WACZ *as the site itself* on
  its original (or any) domain via service-worker replay on static
  hosting: `init(<wacz-url>, <origin>, <timestamp?>)`, with
  `excludeUrlPaths` (deterministic 404 for unwanted requests),
  `allowProxyPath`/`allowProxyPassthrough` (explicit live-web escape
  hatches), custom 404 template, home-page override, and banner
  injection. This is a functioning, minimal competitor to
  `waybackify-serve`'s mirror model — same goal, opposite architecture
  (client-side SW + static WACZ vs our edge server + cache root), and its
  option surface is a checklist for our serve-time policy menu
  (block-cleanly / passthrough / neutralize).
- **[mirror-adapt-centre](https://github.com/webrecorder/mirror-adapt-centre)**
  (cloned: `~/Git/webrecorder/mirror-adapt-centre`; listed twice in
  intake) — a deployed *instance* of that template (identical code,
  filled-in `init.js` pointing at `adapt-centre.wacz`, CNAME
  `adapt-centre.webrecorder.net`) mirroring the ADAPT Centre site.
  Value is as a worked example proving the template in production, not as
  a distinct tool.
- **[wabac.js](https://github.com/webrecorder/wabac.js)** (cloned:
  `~/Git/webrecorder/wabac.js`) — the TypeScript service-worker replay
  engine behind ReplayWeb.page and the mirror template: collection API,
  URL rewriting, WACZ range-request loading, fuzzy matching. If we ever
  wanted to stop maintaining our own serve-time rewriter, this is the
  component that replaces it — at the cost of moving replay from our edge
  (CSP-enforced, server-side) into the visitor's service worker.
- **[wombat](https://github.com/webrecorder/wombat)** (cloned:
  `~/Git/webrecorder/wombat`) — the client-side JS-API override layer
  (three bundles: `wombat.js`, `wombatProxyMode.js`, `wombatWorkers.js`)
  that rewrites dynamically constructed URLs at runtime and virtualizes
  host objects. Candidate replacement for any client-side rewriting shim
  we inject, and the production-tested base for the scene graph's
  virtualized-host execute-and-observe sandbox (§3 of SCENE.GRAPH.md).

## Bin 3 — Formats and plumbing: WARC/WACZ/CDXJ libraries and converters

*Maps to: the cache store layer (CACHE.md) — on-disk identity, indexing,
and ingest converters.*

- **[warcio.js](https://github.com/webrecorder/warcio.js)** (cloned:
  `~/Git/webrecorder/warcio.js`) — streaming WARC read/write for Node and
  browsers (TS port of Python warcio; async iterators, gzip per-record).
  If the store ever speaks WARC — for interchange, or to consume
  Browsertrix output — this replaces any hand-rolled record parsing.
- **[cdxj-indexer](https://github.com/webrecorder/cdxj-indexer)**
  (cloned: `~/Git/webrecorder/cdxj-indexer`) — CLI producing CDXJ/CDX
  indexes from WARCs, with custom fields including *request* headers
  (`req.http:method`, `req.http:referer`). Notable for the scene graph's
  §4: the CDXJ custom-field mechanism is an existing way to persist
  negotiated-request metadata next to the capture key — a lighter path
  than inventing a new ledger row format.
- **[har2warc](https://github.com/webrecorder/har2warc)** (cloned:
  `~/Git/webrecorder/har2warc`) — converts HAR to WARC. Directly relevant
  to the HAR-driven dynamic-requisites fetch loop already prioritized for
  the cache pipeline: it is the existing bridge from "what the browser
  actually loaded" (HAR) to archival storage, and could replace bespoke
  HAR ingestion.
- **[warcit](https://github.com/webrecorder/warcit)** (cloned:
  `~/Git/webrecorder/warcit`) — wraps an on-disk directory of documents
  into standard WARC (with a written treatment of conversions and
  transclusions). The inverse of our cache-root layout: if waybackify's
  file tree ever needs to be exported as a standards-compliant archive,
  this is the shape of that exporter.

## Bin 4 — Formal specs: packaging, attestation, and requirements

*Maps to: CACHE.md's identity model and any future interchange/attestation
story.*

- **[specs.webrecorder.net](https://specs.webrecorder.net/)** (downloaded)
  — index of the five Webrecorder specs (Use Cases, WACZ, WACZ-auth,
  CDXJ, WACZ-IPFS), developed via the
  [webrecorder/specs issue tracker](https://github.com/webrecorder/specs).
- **[WACZ 1.1.1](https://specs.webrecorder.net/wacz/1.1.1/)** (downloaded)
  — ZIP + Frictionless `datapackage.json` packaging of WARC + CDXJ +
  pages, designed for HTTP-range random access on static storage with no
  server mediation. The candidate *interchange and possibly storage*
  format for waybackify captures: it would replace a bespoke export
  format outright, and competes with the cache root as the at-rest layout
  (its stated motivation — replay from static storage without a wayback
  server — is exactly the mirror template's serving model in Bin 2).
- **[WACZ Signing and Verification 0.1.0](https://specs.webrecorder.net/wacz-auth/0.1.0/)**
  (downloaded) — `datapackage-digest.json` carrying either an anonymous
  ECDSA signature or a domain-certificate identity plus RFC 3161
  timestamp over the manifest hash. This is the formalization of
  SCENE.GRAPH.md's byte-preservation attestation ("the mirror could no
  longer attest that what it serves is what was captured") — adopting it
  would replace any home-grown integrity manifest in the cache.
- **[Use Cases for Decentralized Web Archives 0.1.0](https://specs.webrecorder.net/use-cases/0.1.0/)**
  (downloaded) — requirements catalog (researcher save, institutional
  deposit, journalism with authenticity/encryption, art preservation)
  behind WACZ's design; several sections still stubs. Informs
  requirements framing; replaces nothing.

## Bin 5 — Environment and era emulation

*Maps to: SCENE.GRAPH.md's environment axis and serve-time policy — the
"change the environment, not the bytes" pole.*

- **[oldweb.today](https://oldweb.today/#19960101/http://geocities.com/)**
  + **[oldweb-today/oldweb-today](https://github.com/oldweb-today/oldweb-today)**
  (cloned: `~/Git/oldweb-today/oldweb-today`) — period browsers (Netscape,
  IE, with era Java/Flash) running in WebAssembly emulators (v86,
  Basilisk II) with a JS network stack (picotcp) that terminates the
  emulated browser's HTTP and answers from `fetch()` against archives —
  static-hostable, zero content transformation. It will not replace any
  waybackify component (GET-only, two proxied headers, heavy), but it is
  the reference implementation of serving *unmodified bytes* to an
  era-correct engine — the limit case of the scene graph's era-tolerant
  sandbox and descriptive-fidelity position.

## Bin 6 — Adjacent utilities and demos

*Maps to: embed handling in the rewriter, and nothing else in the
pipeline.*

- **[oembed.link](https://oembed.link/)** +
  **[webrecorder/oembed.link](https://github.com/webrecorder/oembed.link)**
  (cloned: `~/Git/webrecorder/oembed.link`) — a Cloudflare Worker giving
  every oEmbed-able URL a stable `https://oembed.link/<url>` page that
  renders *only the embed*, exactly so that embeds become archivable as
  ordinary pages. A trick worth stealing if era social embeds in the
  corpus need capturing as standalone requisites; replaces nothing
  currently in the codebase.
- **[create-archive-now](https://github.com/webrecorder/create-archive-now)**
  (cloned: `~/Git/webrecorder/create-archive-now`) — demo page combining
  the `<archive-web-page>` embed (capture via CORS proxy) with
  `<replay-web-page>` (replay), exporting WACZ from the browser.
  A capabilities demo of the embed components, not a pipeline candidate.

## Bin 7 — Community practice: deduplication and storage identity

*Maps to: CACHE.md's capture-key → content-hash identity model.*

- **Deck: "Deduplication in Browser-Based Crawling with Browsertrix"**
  (Walsh & Kreymer, IIPC WAC 2026 —
  [slides](https://docs.google.com/presentation/d/1UwXDOcRA8zg5CExXru9o_Ml6oQZxThkA_neQ8PrlpOI/edit))
  — content-hash dedup within and across crawls via a persistent
  Redis/Kvrocks index, WARC `revisit` records extended with a proposed
  `WARC-Refers-To-Container: file://<file>.wacz` header, and dependent
  WACZs manifested (name/hash/size) in the signed `datapackage.json` to
  preserve portability and chain of trust. This is the ecosystem
  converging on what waybackify's cache already does (content-hash
  identity, one body per key) — prior art to cite, and the
  dependent-manifest idea is the pattern to copy if the store is ever
  split across multiple archives.

---

## Cross-cutting observation

Read together, Bins 2–4 compose into a complete alternative waybackify:
Browsertrix crawls to WACZ (Bin 1), the site-mirror template + wabac.js +
wombat serve it on the original URL space from static hosting (Bin 2),
with WACZ/CDXJ as store and index and WACZ-auth as attestation (Bins 3–4).
The architectural difference is *where replay authority lives*: the
Webrecorder stack puts it in the visitor's service worker over static
files; waybackify puts it in an edge server over a cache root with a
strict CSP. What none of the bins provide is the scene graph itself —
multi-environment coverage, axis derivation, and the environment-tagged
ledger remain waybackify-specific (see CRAWLERS.md §9).
