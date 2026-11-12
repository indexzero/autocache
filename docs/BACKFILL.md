# cache fill — drive a cache root to full asset closure

`waybackify cache fill <dir> --root <root>` populates a local cache root (the
wayback mirror bucket image, see [CACHE.md](CACHE.md)) with **every capture
the ledger under `<dir>` references** — through its `wayback.json` manifests
and its `captures.jsonl` capture lists ([SITE.md](SITE.md#sources-and-the-capture-list))
alike — each referenced page **and its
requisites** (the `im_`/`cs_`/`js_`/`oe_` images, stylesheets, scripts), not just
the HTML. It is the bulk, resumable form of [`cache add`](../src/waybackify-cli/README.md): where
`cache add` fetches one capture, `cache fill` walks a whole ledger to completion,
politely and convergently.

The load-bearing engine is the library's `backfill.js`; this command is thin
wiring over it. A corpus repo typically wraps it in a one-line shim that fills
in its own posts directory: `waybackify cache fill path/to/your/posts --root <root>`.

## What it does

```
waybackify cache fill <dir> --root <root>
   [--delay-ms N] [--request-delay-ms N] [--abort-after N] [--throttle-after N]
   [--no-requisites] [--pages-only] [--max N] [--refresh] [--dry-run]
   [--converge [--backoff-s N] [--backoff-max-s N] [--max-stall N]]
```

1. **Enumerate once → a durable worklist.** The captures that need work are the
   *incomplete* set — every capture the ledger references whose closure the
   cache root does not yet hold. That is **closure-aware, not doc-presence**:
   both never-fetched captures and already-`cached` pages go on the list,
   because `ledger`'s `cached` verdict only means the *document* sidecar exists
   and never checks the asset closure. The list is written to
   `<root>/.refetch/worklist.jsonl` and **reused across runs** (no re-enumerate),
   so pacing and resume accumulate.

   The worklist is **bound to the ledger that built it**. Beside it,
   `worklist.ledger.json` holds a fingerprint of that ledger: a hash over
   every referenced capture's rank and replay URL. Each run fingerprints the
   ledger it was given. When the two differ, the run rebuilds the worklist and
   says why: `ledger-changed` (a source was added, removed, or re-picked, or
   this is a different ledger) or `unstamped` (a worklist written before
   stamps existed, which cannot say which ledger it answers). A rebuild is
   always safe, because the cache root is the done-truth and the worklist is
   derived from it. `--refresh` forces one.

   The list is ordered **pages first, then rank, then capture key**. A page
   is a capture named by a flagless replay URL (`/web/<timestamp>/<original>`),
   which is what a browser asks the archive for. A capture named with a replay
   flag (`id_` raw bytes, `im_`, `oe_`) is content, and every content capture
   comes after every page. The archive rate-limits and blocks by request form:
   a mirror that sent about 2,000 `id_` requests in three hours had that form
   refused with "suspected abusive bot traffic" while pages were still served.
   Pages first means the requests no human reader sends are the last ones a
   run makes, and a block on them stops a run that already holds every page.
   `--pages-only` attempts the pages and leaves the content pending; run it
   first, then run again without it for the content.

   Within each half, a capture list gives each row a `rank`. A capture a
   manifest names has rank 0. A whole-site ledger ranks one capture of every
   URL at 0, so a run cut short still holds one version of everything.

   (`interstitial`/`error` captures are excluded. A `wrapper-stub` interstitial
   is cured by [`cache remediate`](SITE.md#wrapper-stubs-and-cache-remediate),
   which refetches it raw. The rest need a re-*pick*: a different capture,
   not a refetch of the same URL.)

2. **Process the worklist, paced.** Each capture goes through `cacheCapture`
   in-process. A fully-closed page is a free skip (local sidecar reads, no
   network); a short one has its missing requisites fetched. `--delay-ms`
   (default 1500) paces successive **captures**, and `--max` caps **captures**
   per run — note a capture is a page *and its requisites*, fetched together in
   one `cacheCapture` (browser-style: a browser loads a page's assets in a
   burst too), so a single capture may issue several HTTP requests before the
   delay. Cached skips never spend the delay. `--request-delay-ms` paces the
   requisite **requests** inside one capture (default 0). `--no-requisites`
   stores only the named captures: each page's requisite edges are still
   recorded, none is fetched, and `cache verify` reports the closure as short
   until a later run without the flag completes it.

3. **Converge, don't hammer.**
   - **Transient** (498/429/5xx/timeout) → the capture is **deferred**: left
     pending so a later run retries it. This is what makes repeated runs
     converge instead of retry-storming.
   - **Connection failures** (refused/reset/DNS/timeout) → counted; a run of
     `--abort-after` (default 5) consecutive ones **aborts** the run, rather
     than firing hundreds of doomed requests while archive.org is down or
     blocking us.
   - **A throttle** → a capture that defers with nothing fetched is the
     archive answering 429 or 5xx. One is bad luck. `--throttle-after`
     (default 6) in a row is a rate-limit spell, and the run **stops** with
     reason `throttled` instead of deferring its way through the whole
     worklist. A capture that stores any bytes, or settles as gone, resets the
     count. `--throttle-after 0` never stops.
   - **After a stop**, the run writes `<root>/.refetch/cursor.json`. The next
     run starts *after* the capture it stopped on and wraps around, so the
     streak that stopped it is retried last. Six captures that always fail
     cannot pin every run to the top of the list. A run that walks the whole
     list removes the cursor.
   - **404** → the archive genuinely lacks that capture; it is recorded in
     `<root>/.refetch/gone.jsonl` and never retried.
   - **404 on a github.com deep link** → the engine probes the GitHub repo
     root first. When the root redirects to a renamed repo, the engine grafts
     the original path onto the new owner/name and re-verifies it. A grafted
     path that answers makes the capture a rewrite candidate. The engine
     records it in `<root>/.refetch/renamed.jsonl` and logs it as `rename`,
     never as gone. The engine probes an original with an explicit default
     port (`http://github.com:80/...`) like any other. A repo home page with
     only a query or a fragment is not a deep link. Neither is a GitHub route
     such as `/orgs/...` or `/login`. Nor is a path a fetch can move: a
     backslash, a tab, or a line break in the text, or a `.` or `..` segment.
     The engine never probes any of them. A grafted path that redirects to the
     renamed repo's root follows it, and the root's answer settles the link.
     GitHub can give an inconclusive reply: a 403, 408, 429, or 5xx, or a
     network error. A redirect off GitHub or without a Location, or a grafted
     path that redirects out of the renamed repo, is inconclusive too. Then
     the engine defers the capture, and it stays eligible for the next run.
     Only a 404 that survives the probe is gone.

4. **Resume by re-running.** The cache root is the done-truth. Kill it any time;
   a re-run skips what is already fully closed and finishes the rest. `--max N`
   caps the network attempts in a single run.

5. **Or let it converge.** `--converge` repeats passes until one fetches
   nothing and defers nothing. After a stop, or a pass that made no progress,
   it backs off `--backoff-s` (default 300), doubling to `--backoff-max-s`
   (default 1800). A pass that fetches resets the backoff. After `--max-stall`
   (default 6) passes in a row with no progress it gives up: what still defers
   after that many backoffs is not transient, and
   [`cache status`](../src/waybackify-cli/README.md) names it. The loop is the
   library's `backfill.js#converge`. A driver has no reason to write its own.
   A throttle stop that fetched nothing counts as a pass with no progress, so
   a block that outlasts the backoffs ends the loop. An outage does not count:
   the loop waits out an unreachable archive.

## Output & exit codes

Progress streams to **stderr**; one JSON summary line prints to **stdout**:

```json
{"root":"/var/cache/wayback","worklist":837,"pending":624,"dryRun":false,
 "fetched":610,"cached":12,"deferred":2,"gone":0,"attempts":624,"aborted":false}
```

A stopped run adds `"reason"`: `"unreachable"` or `"throttled"`. Under
`--converge` the counts are the last pass's, and the line adds the loop's
verdict:

```json
{"root":"/var/cache/wayback","worklist":837,"pending":0,"dryRun":false,
 "fetched":0,"cached":0,"deferred":0,"gone":0,"attempts":0,"aborted":false,
 "passes":4,"converged":true,"stalled":false,
 "totals":{"attempted":630,"fetched":622,"deferred":0,"gone":8}}
```

- **exit 0** — normal. Deferrals are expected convergence; re-run to finish.
  Under `--converge`: the worklist converged.
- **exit 1** — stopped (archive.org unreachable or throttling): the mirror is
  incomplete, re-run when it recovers. Under `--converge`: the worklist did
  not converge.
- **exit 2** — usage error (missing `<dir>` or `--root`).

## Durable state under `<root>/.refetch/`

| file | role |
|---|---|
| `worklist.jsonl` | the long-running base — the incomplete set, enumerated once per ledger (`--refresh` to rebuild) |
| `worklist.ledger.json` | the stamp: `{ledger, fingerprint}` of the ledger that built the worklist. A mismatch rebuilds it |
| `cursor.json` | present after a stopped run: `{after, reason}`. The next run starts after that capture |
| `gone.jsonl` | captures the archive 404'd — excluded from every future run |
| `renamed.jsonl` | captures of renamed GitHub repos: `{waybackUrl, from, to}` rewrite candidates, excluded from every future run |

## Examples

```sh
# Full corpus, defaults (pace 1.5s, abort after 5 connection failures):
waybackify cache fill path/to/your/posts --root /var/cache/wayback

# Preview the worklist without touching the network:
waybackify cache fill path/to/your/posts --root /var/cache/wayback --dry-run

# A bounded, brisk chunk (e.g. under a flaky connection):
waybackify cache fill path/to/your/posts --root /var/cache/wayback --delay-ms 500 --max 100

# The corpus changed: no flag needed, the run sees it and rebuilds the worklist.
waybackify cache fill path/to/your/posts --root /var/cache/wayback

# Run until done, backing off through outages and throttles:
waybackify cache fill path/to/your/posts --root /var/cache/wayback --converge
```

## Relationship to the rest of the pipeline

- [`cache add`](../src/waybackify-cli/README.md) — one capture; `cache fill` is the whole-ledger form.
- [`ledger --root`](../src/waybackify-cli/README.md) — the audit join `cache fill` builds its
  worklist from (the same rows `ledger --root` prints).
- [`cache status`](../src/waybackify-cli/README.md) — the summary of that join: how far the
  root is, and what no further pass will fix.
- [SITE.md](SITE.md) — a ledger built from the CDX index, not from markdown.
- [SYNC.md](SYNC.md) — projecting the populated cache root out to R2 / Fastly.
  `bucket push` pushes the bucket *out*; `cache fill` pulls it *in* from the archive.
