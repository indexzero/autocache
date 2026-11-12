# site — mirror every archived version of a whole site

`waybackify site enumerate` turns a set of CDX queries into a ledger that
[`cache fill`](BACKFILL.md) drives to closure: one capture of **every distinct
version of every URL** under a host, a domain, or a path prefix, inside a date
window. `waybackify site export` lays the filled [cache root](CACHE.md) out as
`<host>/<timestamp>/<path>` files a person can browse.

Between those two verbs a site is filled like any other ledger. Nothing in the
`cache` group knows what a site is.

## Contents

- [The run](#the-run)
- [Sources and the capture list](#sources-and-the-capture-list)
- [The site config](#the-site-config)
- [What `site enumerate` does](#what-site-enumerate-does)
- [What it writes](#what-it-writes)
- [Wrapper stubs and `cache remediate`](#wrapper-stubs-and-cache-remediate)
- [`site export`](#site-export)
- [A driver is a config file](#a-driver-is-a-config-file)
- [Why a capture list, and why a package](#why-a-capture-list-and-why-a-package)
- [Open proposals](#open-proposals)

## The run

```sh
ROOT=~/autocache-runs/example/cache-2026-11-10      # outside git

waybackify site enumerate sites.json --ledger ledger           # 1. CDX → ledger/<site>/captures.jsonl
waybackify cache fill ledger --root "$ROOT" --converge         # 2. fetch, pass after pass, until nothing is left
waybackify cache remediate --root "$ROOT"                      # 3. refetch raw what the archive wrapped
waybackify cache status ledger --root "$ROOT"                  # 4. what is left, and why
waybackify cache verify --root "$ROOT"                         # 5. fsck the store
waybackify site export ledger --root "$ROOT" --out raw/web     # 6. <host>/<timestamp>/<path>
```

Every step re-runs. A re-run resumes, or does nothing when no work is left.
When archive.org is down, wait and run the same command again.

Step 4 exits 1 while any capture is pending or needs attention. When it lists
captures to `repick`, run step 1 again with `--repick-from "$ROOT"` and then
step 2: the enumerator swaps each bad capture for the next one with the same
content, and `cache fill` notices the ledger changed.

## Sources and the capture list

A **source** tells the cache pipeline which captures to fetch. autocache had
one: a markdown file, whose links `waybackify manifest` resolves into a
`wayback.json` [manifest](../src/waybackify/README.md). A site is a second
source, and it does not fit a manifest:

| | manifest (`wayback.json`) | capture list (`captures.jsonl`) |
|---|---|---|
| is | one markdown file's rewrite program | a list of captures to fetch |
| keyed by | original URL — one capture per URL | nothing — one row per capture |
| holds several versions of a URL | no | yes |
| carries | `rewrites`, `exclude`, `noRewrite`, `checkedAt` | the producer's own fields: `mimetype`, `digest`, `rank`, … |
| written by | `waybackify manifest` | `waybackify site enumerate`, or any tool |
| read by `rewrite` | yes | no |
| read by `cache fill`, `ledger`, `cache status` | yes | yes |

A capture list is JSONL. Each row names one capture by its replay URL:

```json
{"wayback":"https://web.archive.org/web/20030224204757/http://www.example.org:80/pictures/","rank":1,"site":"example.org","original":"http://www.example.org:80/pictures/","timestamp":"20030224204757","mimetype":"text/html","digest":"FENXML3XN4Q6RBNQORLTMJEWRZGRANNQ","length":"4385","urlkey":"org,example)/pictures"}
```

The library reads two fields:

- `wayback` (required) — a parseable replay URL. Its flag is how the capture
  is fetched: none for the normal replay, `id_` for the raw bytes.
- `rank` (optional, a non-negative integer) — fetch order. `cache fill` works
  through rank 0 first, then rank 1, and so on. A capture a manifest names has
  rank 0.

Every other field belongs to whoever wrote the row and is carried, never
read. A row that fails either rule fails loud with its file and line.

The **ledger** is still every source file under a tree. `ledger.js#discover`
finds `wayback.json` and `captures.jsonl` alike, and one ledger can hold both.
Three views of it:

```sh
waybackify ledger ledger                  # one row per file
waybackify ledger ledger --captures       # one row per capture, every version kept
waybackify ledger ledger --root "$ROOT"   # the same rows, classified against a cache root
```

`ledger --flatten` is the union *manifest*. It keeps one capture per URL
because a manifest does, and it ignores capture lists. `--captures` is the
view that loses nothing.

## The site config

```json
{
  "window": { "from": "20020101000000", "to": "20071231235959" },
  "cdx": { "pageLimit": 100000, "pauseMs": 5000, "maxAttempts": 10 },
  "sites": [
    { "name": "example.org",
      "queries": [ { "url": "example.org", "matchType": "domain" } ] }
  ],
  "rules": [
    { "host": "wiki.example.org", "html": "raw",
      "why": "2,800 page versions × 7 skin assets each" }
  ]
}
```

| key | meaning |
|---|---|
| `window.from`, `window.to` | The capture window, 1–14 digits. `from` pads with 0s and `to` with 9s, so `"2002"` to `"2007"` spans both whole years. Absent means unbounded. |
| `cdx` | Optional. `pageLimit` (100000) rows per CDX page, `pauseMs` (5000) between requests, `maxAttempts` (10), `backoffMs` (30000) and `maxBackoffMs` (600000) for the outage backoff. |
| `sites[].name` | The directory the site's files are written under, so one path segment. |
| `sites[].queries[]` | A CDX query: `url` plus `matchType` (`exact`, `prefix`, `host`, or `domain`; default `exact`). A site can take several, for example a second domain that served the same pages. |
| `rules[]` | Per-host replay mode for HTML. `"html": "raw"` fetches that host's pages with `id_`. A rule covers its host and every subdomain. The first match wins. `why` is a note for the next reader. |

## What `site enumerate` does

1. **Pages the index.** Each query runs through the library's
   [`cdx.js`](../src/waybackify/cdx.js). Every request carries an explicit
   `limit`, because the index refuses an unbounded domain query. Pages chain
   through `showResumeKey`.
2. **Waits out an outage.** The index answers an outage with an HTML
   "Temporarily Offline" page, sometimes under a 200. A body that is not a
   JSON array is a failure, whatever the status says. The retry backs off
   from 30 s, doubling to 10 min. After `maxAttempts` the command exits 1. An
   outage is never read as "no captures".
3. **Saves every raw page verbatim** under `cdx/`, before it reads it.
4. **Resolves redirects.** A 3xx capture stores only a `Location`, which the
   index does not list. Each distinct one is probed once through the raw
   replay, without following it. A target inside a configured site that no 200
   capture covers gets its own exact query, up to three rounds deep.
5. **Selects versions.** A version is one distinct CDX `digest` of one URL,
   taken at its earliest 200 capture in the window. URLs group by `urlkey`,
   which folds the index's own aliasing (`www.`, `:80`, letter case) into one
   URL. The row keeps the `original` spelling, because that spelling is the
   capture's key.
6. **Chooses the replay mode.** HTML is listed through the normal replay, so
   `cache fill` records and fetches its requisites. A `rules` entry can mark a
   host's HTML raw. Everything else is listed raw (`id_`): the normal replay
   of a GIF or a PDF is the archive's viewer page, not the file.
7. **Ranks.** A URL's versions are ranked oldest first from 0. Rank 0 across a
   site is one capture of every URL, and `cache fill` fetches it first. A run
   cut short still holds one version of everything.

The command is **deterministic**. Nothing it writes carries a clock reading,
and it writes a file only when the bytes change. A rerun over unchanged CDX
data touches nothing. `--offline` rebuilds the whole ledger from the saved
pages with no network, byte for byte.

```
waybackify site enumerate <config.json> --ledger <dir>
   [--site <name>]... [--offline] [--no-redirects] [--repick-from <root>]
```

- `--site` limits the run to the named sites. Repeat it.
- `--no-redirects` skips step 4.
- `--repick-from <root>` skips every capture that cache root holds as
  `interstitial` or `error`, or lists in `.refetch/gone.jsonl`, and takes the
  next capture with the same digest. When every capture of a digest is bad it
  keeps the earliest.

Progress goes to stderr. One JSON line goes to stdout:

```json
{"ledger":"/work/ledger","window":{"from":"20020101000000","to":"20071231235959"},"offline":false,
 "sites":{"example.org":{"rows":3804,"okUrls":274,"versions":346,"maxVersionsPerUrl":12,
 "redirects":{"rows":331,"resolved":331,"intoSites":331}}}}
```

Exit 0 on success, 1 when the index stays offline, 2 on a usage error.

## What it writes

```
<ledger>/<site>/captures.jsonl          the capture list — what `cache fill` reads
<ledger>/<site>/cdx/<query>.pNNN.json   raw CDX pages, verbatim (the --offline input)
<ledger>/<site>/cdx/target~<url>.p…     exact CDX rows for redirect targets
<ledger>/<site>/redirects.jsonl         the resolved Location of each distinct 3xx
<ledger>/<site>/inventory.jsonl         every CDX row, with its disposition
<ledger>/<site>/summary.json            counts
```

`inventory.jsonl` accounts for every row the index returned:

| disposition | meaning |
|---|---|
| `version` | The capture chosen for one distinct digest of its URL. The row carries `rank` and `wayback`. |
| `same-content` | Another capture of a digest that already has a version. |
| `repicked-away` | A capture `--repick-from` proved bad. The row carries `bad`: `interstitial`, `error`, or `gone`. |
| `non-ok` | A non-200 capture. A 3xx carries `redirect: { status, target, site }`. |
| `out-of-window` | Outside the window. Only a redirect-target row can be. |
| `duplicate-row` | An exact repeat of an earlier row. The index does return these. |

The index's data is taken as it comes. Originals with a literal `&amp;`,
truncated originals, and the `unk` and `warc/revisit` mimetypes all pass
through. A mimetype that is not HTML is fetched raw.

## Wrapper stubs and `cache remediate`

The archive sometimes answers a replay request with its own viewer page in
place of the capture. It does this for most non-HTML documents, which is why
`site enumerate` lists them raw. It also does it, now and then, for HTML: one
mirror of three sites had 198 such captures, all of them CGI scripts under
one `cgi-bin/`.

[`commitEntry` refuses that page](CACHE.md#interstitial-captures) and commits a
bodiless `interstitial` sidecar with signature `wrapper-stub`. The capture is
then stuck. The capture key ignores the replay flag, so the sidecar that
records the refusal also satisfies every later fetch of the same capture.
`cache fill` leaves interstitials off its worklist, and `cacheCapture` skips
an existing sidecar.

`cache remediate` is the sweep that unsticks them:

```
waybackify cache remediate --root <root> [--delay-ms N] [--throttle-after N] [--max N] [--dry-run]
```

It walks the root's sidecars, so it needs no ledger. Each `wrapper-stub` or
`extension-mismatch` sidecar is refetched with `id_` and recommitted through
`commitEntry`, which runs the interstitial checks again on the new bytes. It
prints one JSON row per interstitial sidecar:

| outcome | meaning |
|---|---|
| `fixed` | The raw bytes are stored. The sidecar is `status: "body"`, `flag: "id_"`. |
| `still` | The raw bytes tripped a signature again. Pick another capture. |
| `unavailable` | The archive answered the raw fetch with a settled non-200. |
| `deferred` | 429, 5xx, or no answer. A re-run retries it. |
| `repick` | Not curable by a raw refetch, so untouched: a stub already fetched raw, or a `redirect-interstitial` or `archived-error` capture. |

Six deferrals in a row stop the sweep, because the archive is throttling.
Exit 0 when nothing was deferred, 1 when a re-run has work left.

A document fetched raw now records `"flag": "id_"` in its sidecar. That is
how the sweep knows a raw refetch was already tried, and how `site export`
can say which stored pages carry the archive's toolbar.

## `site export`

```
waybackify site export <ledger-dir> --root <root> --out <dir> [--dry-run]
```

A cache root is content-addressed, and [`remaster`](REMASTER.md) keeps that
layout because it is built to be served. `site export` copies every stored
body to a path a reader can guess:

```
<out>/<host>/<timestamp>/<path>     the stored bytes, untouched
<out>/index.jsonl                   one row per file
<out>/_unexported.jsonl             sidecars with no body: interstitial, error, redirect, empty
<out>/_collisions.jsonl             every path the export had to adjust
```

- `<host>` is the lowercased hostname without a leading `www.`. A non-default
  port becomes `<host>_<port>`.
- A URL ending in `/` becomes `…/index.html`.
- A query string joins the file name as `%3F<query>`, with path-hostile
  characters percent-encoded.
- A page's requisites share its timestamp, so a page and the images it
  embedded sit in the same `<timestamp>/` tree.

Each `index.jsonl` row carries `path`, `original`, `timestamp`, `wayback`,
`role` (`document` when the ledger names the capture, else `requisite`),
`flag`, `contentType`, `digest`, `sha256`, `bytes`, and `fetchedAt`. A
document also carries the ledger `files` that name it and its `rank`.

The bytes are the bytes the cache stored. A page fetched through the normal
replay still carries the archive's toolbar and `/web/<ts>/…` links. A page
fetched raw is the captured bytes. `wayback` says which.

**Collisions.** The default macOS filesystem ignores letter case, and real
sites hold both `E.gif` and `e.gif`. The export compares paths case-folded
and resolves a clash the same way on every filesystem:

| kind | resolution |
|---|---|
| `file-is-also-directory` | The file moves to `<path>/index.html`. |
| `case-collision`, `duplicate-path` | The later file gets a `~N` suffix before its extension. |
| `directory-case-merged` | The directory takes its first spelling, in code-unit order. |

Every adjustment is a row in `_collisions.jsonl`. Nothing is overwritten.

A re-run writes only files whose bytes changed and removes files an earlier
export wrote that this one no longer plans. The output directory must be
outside the cache root. `--dry-run` plans and counts, and writes nothing.

## A driver is a config file

A project that mirrors sites owns three facts: which sites, where the ledger
lives, and where the cache root lives. The first is `sites.json`. The other
two are arguments. Nothing else needs a script:

```sh
#!/bin/sh
# bin/mirror — the whole driver
set -eu
ROOT=${AUTOCACHE_ROOT:?set AUTOCACHE_ROOT to a cache root outside git}
cd "$(dirname "$0")/.."
waybackify site enumerate sites.json --ledger ledger
waybackify cache fill ledger --root "$ROOT" --converge || true
waybackify cache remediate --root "$ROOT" || true
waybackify cache verify --root "$ROOT" --quiet || true
waybackify cache status ledger --root "$ROOT"
```

The converge loop, the throttle handling, the worklist rebuild after the
ledger changes, and the status summary all live in the library
([BACKFILL.md](BACKFILL.md)). A driver that reimplements one of them has
found a gap in autocache.

## Why a capture list, and why a package

**The manifest was the wrong shape, not the wrong idea.** The first site
mirror wrote manifests, because a manifest was the only thing `cache fill`
read. A manifest maps each URL to one capture, so every version of a URL
needed its own manifest: 112 of them, one per version rank, for a site whose
busiest page had 112 versions. `checkedAt` meant nothing. The index's
`mimetype` and `digest` had nowhere to go, so they lived in a side file. And
`ledger --flatten` threw the versions away.

A markdown corpus strains the same way, more quietly. Two posts that link one
URL, each near its own date, hold two captures of it. The ledger of 104
manifests that prompted this work references 823 captures, and its
`--flatten` holds 793. The project carries its own capture-level walk to see
the other 30.

Both are one missing concept: **the unit the cache fetches is a capture, and
a ledger needs a capture-level form.** The manifest stays what its header
says it is — a rewrite program for one markdown file — and still feeds
`cache fill`. The capture list is the form for a source that has no markdown
to rewrite.

**The split follows one rule: a mechanism goes in the library, a source goes
in a layer.**

- Mechanisms every source needs live in `@autocache/waybackify` and under the
  existing `cache`, `ledger`, and `search` verbs: the capture list, paged CDX
  enumeration, the worklist stamp, the throttle stop, the converge loop,
  `cache remediate`, `cache status`.
- The site source lives in `@autocache/waybackify-site`: the config, the
  version selection, the path-tree export. It imports the library. The
  library does not know it exists.
- The CLI stays one bin and stays thin. `site` is a group in `waybackify`,
  wired to the package the way `cache crawl` is wired to
  `@autocache/waybackify-crawl`.

The alternative was a second CLI that wraps the first by spawning it. The
first site driver was exactly that, and its two hardest parts were
workarounds for the process boundary: a throttle watch that parsed the
NDJSON trace with `awk` and killed the child, and a status report built from
`jq` over `ledger --root`. Both are now library calls.

## Open proposals

These came out of the same mirror. None is implemented here.

1. **Requisite identity across versions.** A requisite is keyed by the *page's*
   timestamp, so a wiki's seven skin files are fetched again for every page
   version. `cache fill --no-requisites` and a `"html": "raw"` rule both avoid
   the fan-out, and both give up the assets. The fix that keeps them is to
   dedupe a requisite by `(asset URL, resolved capture)` before fetching.
   That changes what `requisites[]` means, so it wants its own design.
2. **Record where a requisite redirect landed.** A requisite fetched at the
   page's timestamp usually redirects to the asset's nearest capture. The
   client follows it, and the bytes are stored under the page-timestamp key
   with no record of the capture they came from. A `resolved` field on the
   sidecar would record it. It is also what proposal 1 would dedupe on.
3. **A per-row requisite policy.** A capture-list row could carry
   `"requisites": false`, so one site can fetch requisites for its home pages
   and skip them for its forum. Today the choice is per run
   (`--no-requisites`) or per host through the replay mode.
4. **Typed fetch errors.** `classifyFailure` still sorts failures by matching
   the message text, and impit's connection errors are multi-line debug
   dumps. `cdx.js` and `cache remediate` cut them to one line. `cacheCapture`
   should throw errors that carry a `kind` and a `status`.
5. **`search --near`.** The flag reaches `getSnapshots`, which ignores it.
   `getSnapshots` also defaults to ten rows and returns `[]` for any non-200.
   `search --match` goes through `cdx.js` and has neither problem. The plain
   `search <url>` path should move there too.
6. **`cache gc` for dropped sources.** A ledger describes the present. A
   source that leaves it leaves its captures in the root. See
   [GC.md](GC.md).
