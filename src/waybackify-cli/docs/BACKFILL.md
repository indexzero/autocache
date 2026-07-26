# backfill — drive a cache root to full asset closure

`waybackify backfill <dir> --root <root>` populates a local cache root (the
wayback.charlie.dev bucket image, see [CACHE.md](CACHE.md)) with **every capture
the ledger under `<dir>` references** — each referenced page **and its
requisites** (the `im_`/`cs_`/`js_`/`oe_` images, stylesheets, scripts), not just
the HTML. It is the bulk, resumable form of [`cache`](../README.md): where
`cache` fetches one capture, `backfill` walks a whole ledger to completion,
politely and convergently.

The load-bearing engine is the library's `spv/waybackify/backfill.js`; this
command is thin wiring over it. `series/run/bin/refetch` is a one-line shim:
`waybackify backfill words --root <root>`.

## What it does

```
waybackify backfill <dir> --root <root>
   [--delay-ms N] [--abort-after N] [--max N] [--refresh] [--dry-run]
```

1. **Enumerate once → a durable worklist.** The captures that need work are the
   *incomplete* set — every capture the ledger references whose closure the
   cache root does not yet hold. That is **closure-aware, not doc-presence**:
   both never-fetched captures and already-`cached` pages go on the list,
   because `ledger`'s `cached` verdict only means the *document* sidecar exists
   and never checks the asset closure. The list is written to
   `<root>/.refetch/worklist.jsonl` and **reused across runs** (no re-enumerate),
   so pacing and resume accumulate. `--refresh` rebuilds it.
   (`interstitial`/`error` captures are excluded — they need a re-*pick* via
   [`search`](../README.md) + `cache`, not a refetch of the same URL.)

2. **Process the worklist, paced.** Each capture goes through `cacheCapture`
   in-process. A fully-closed page is a free skip (local sidecar reads, no
   network); a short one has its missing requisites fetched. `--delay-ms`
   (default 1500) paces the network fetches; cached skips never spend it.

3. **Converge, don't hammer.**
   - **Transient** (498/429/5xx/timeout) → the capture is **deferred**: left
     pending so a later run retries it. This is what makes repeated runs
     converge instead of retry-storming.
   - **Connection failures** (refused/reset/DNS/timeout) → counted; a run of
     `--abort-after` (default 5) consecutive ones **aborts** the run, rather
     than firing hundreds of doomed requests while archive.org is down or
     blocking us.
   - **404** → the archive genuinely lacks that capture; it is recorded in
     `<root>/.refetch/gone.jsonl` and never retried.

4. **Resume by re-running.** The cache root is the done-truth. Kill it any time;
   a re-run skips what is already fully closed and finishes the rest. `--max N`
   caps the network attempts in a single run.

## Output & exit codes

Progress streams to **stderr**; one JSON summary line prints to **stdout**:

```json
{"root":"/var/cache/wayback","worklist":837,"pending":624,"dryRun":false,
 "fetched":610,"cached":12,"deferred":2,"gone":0,"attempts":624,"aborted":false}
```

- **exit 0** — normal. Deferrals are expected convergence; re-run to finish.
- **exit 1** — aborted (archive.org unreachable): the mirror is incomplete,
  re-run when it recovers.
- **exit 2** — usage error (missing `<dir>` or `--root`).

## Durable state under `<root>/.refetch/`

| file | role |
|---|---|
| `worklist.jsonl` | the long-running base — the incomplete set, enumerated once (`--refresh` to rebuild) |
| `gone.jsonl` | captures the archive 404'd — excluded from every future run |

## Examples

```sh
# Full corpus, defaults (pace 1.5s, abort after 5 connection failures):
waybackify backfill words --root /var/cache/wayback

# Preview the worklist without touching the network:
waybackify backfill words --root /var/cache/wayback --dry-run

# A bounded, brisk chunk (e.g. under a flaky connection):
waybackify backfill words --root /var/cache/wayback --delay-ms 500 --max 100

# Re-enumerate after the corpus changed, then run:
waybackify backfill words --root /var/cache/wayback --refresh
```

## Relationship to the rest of the pipeline

- [`cache`](../README.md) — one capture; `backfill` is the whole-ledger form.
- [`ledger --root`](../README.md) — the audit join `backfill` builds its
  worklist from (the `series/run/bin/audit` shim surfaces it).
- [SYNC.md](SYNC.md) — projecting the populated cache root out to R2 / Fastly.
  `sync` pushes the bucket *out*; `backfill` pulls it *in* from the archive.
