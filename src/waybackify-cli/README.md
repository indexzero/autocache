# @autocache/waybackify-cli

`waybackify` — the human-operable, `xargs`-composable front door over the
[`waybackify`](../waybackify) library.

**Status: surface v2 pinned; all commands implemented.**
Five flat verbs — `manifest`, `rewrite`, `ledger`, `check`, `search` — plus the
`cache` command group (`add` · `fill` · `verify` · `remaster` · `sync`) for the
cache-store operations. The full command/option surface below is fixed (names,
args, flags, help text, exit codes — snapshot-tested). Surface v2 speaks the settled
vocabulary: a `wayback.json` is a **Manifest** (one source file's standalone
rewrite program), the **Universe** is compile-time policy, and the **Ledger**
is the collection of manifests under a tree. The v1 per-file
markdown-extraction `manifest` command and its `--ledger` flag are gone —
their meanings were inverted from these concepts.

## Commands

```
waybackify manifest <source.md> -u universe.json [-s seen.json] -o wayback.json [--offline]
waybackify rewrite  <source.md> -m wayback.json -o <out.md>
waybackify ledger   <dir> [--flatten] [--root <cache-root>]
waybackify check    <wayback-url>
waybackify search   <original-url> [--near <ts>] [--limit <n>]

# cache — the cache-store command group
waybackify cache add      <wayback-url> --root <root> [--no-requisites]
waybackify cache fill     <dir> --root <root> [--delay-ms N] [--abort-after N] [--max N] [--refresh] [--dry-run]
waybackify cache verify   --root <root> [--fix] [--json] [--quiet]
waybackify remaster build <hermetic-root> <remastered-root> [--json]
waybackify bucket push      --root <root> --bucket <name> [--empty-file <path>] [--dry-run]
```

`waybackify cache` with no verb prints the group's help. The cache root is
spelled `--root|-r` on every command that reads or writes one (`cache add`,
`cache fill`, `cache verify`, `bucket push`, `ledger`). `-o/--output` is reserved
for commands that emit a single file (`manifest`, `rewrite`). The old spellings
— `cache add -o` and `ledger --against` — still parse as deprecated aliases.

| command | does | output |
|---|---|---|
| `manifest` | **Generate** the manifest for one markdown source: extract live links, bake the Universe subset (`-u`, policy), copy verdicts from the seen union (`-s`, **read-write**, Manifest-shaped — bootstrap it with `ledger --flatten`), resolve only never-seen urls against the archive. **Idempotent**: a rerun with the same seen file makes zero network calls and writes byte-identical output. `--offline` fails on urls the universe + seen cannot answer instead of querying | canonical manifest at `-o`; seen file extended in place; one JSON stats line (`{output, urls, fromUniverse, fromSeen, resolved, deferred}`) on stdout; unresolved urls → stderr + exit 1, rerun to resume |
| `rewrite` | **Apply** a manifest to a markdown source (the library's `manifest.js#apply`): precedence `exclude → rewrites → entries → untouched + warn`; fenced code and link text never touched; already-archived links pass through | the published form at `-o`; a url with no verdict warns on stderr and exits 1 (written anyway, untouched — surfaced, never guessed) |
| `ledger` | Survey the **collection**: every `wayback.json` under `<dir>`, file paths as identity. `--flatten` unions the ledger into ONE canonical manifest (the seen-file bootstrap); `--root <cache-root>` joins referenced captures against the cache's sidecars | default: JSONL `{file, entries, rewrites, exclude}` (counts); `--flatten`: one canonical manifest JSON; `--root`: JSONL `{state: unfetched\|cached\|interstitial\|error, key, waybackUrl, timestamp, originalUrl, files, status}` |
| `check` | Full **wayback-404 verdict** for the exact capture: CDX `statuscode` + soft-404 content heuristics on the replay body — the corpus audit primitive | JSON verdict on stdout (`{verdict: good\|wayback404\|suspect, statuscode, reason, snippet}`); exit 0 = verified good, nonzero = bad/suspect |
| `search` | CDX capture query (the library's `getSnapshot`/`getSnapshots` face) — for re-picking a better capture when `check` flags one bad. No date-anchoring cleverness: `--near` passes through, default is CDX's own ordering | JSONL: `{timestamp, statuscode, mimetype, waybackUrl}` per capture |
| `cache add` | Fetch ONE capture into a **local bucket image** at `<root>` — the wayback mirror's population path. Syncing that dir to R2 / Fastly KV (rclone/wrangler/fastly tooling) IS deployment. See [docs/CACHE.md](../../docs/CACHE.md) | files written under the shared key scheme; summary line on stdout |
| `cache fill` | The **bulk, resumable** form of `cache add`: drive `<root>` to a COMPLETE asset closure of every capture the ledger under `<dir>` references (page + its requisites). A durable worklist is enumerated once and reused; transient trouble DEFERS, connection failures ABORT, a 404 is recorded gone. Killable + resumable. See [docs/BACKFILL.md](../../docs/BACKFILL.md) | progress on stderr; one JSON summary line on stdout; exit 1 on abort |
| `cache verify` | **fsck** a cache root against its own sidecars: re-hash bodies, re-derive paths, and flag corruption, orphans, stale scratch, and any page whose **requisite closure is short** (a referenced `im_`/`cs_`/`js_`/`oe_` capture with no sidecar in the store — store-relative, no ledger, no network). Report-only unless `--fix` (reaps only orphan `cap/` + stale `tmp/`). See [docs/CACHE.md](../../docs/CACHE.md) | a per-category report on stdout (`--json` for the raw record); exit 1 while any discrepancy remains |
| `remaster build` | Build a **standalone remastered root** from a hermetic one — chrome stripped, wayback references localized, sidecars carried, a content-addressed build record written. Deterministic. See [docs/REMASTER.md](../../docs/REMASTER.md) | a summary line on stdout (`--json` for the run record) |
| `bucket push` | Emit the **bucket-population batch** — one `s5cmd run` cp line per `cap/` object, ready to pipe into `s5cmd … run`. Never mutates, never talks to the network. See [docs/SYNC.md](../../docs/SYNC.md) | the batch on stdout (stderr under `--dry-run`); a summary on stderr |

Composability is the design goal:

```sh
# Drive a cache root to full closure of everything a ledger references —
# paced, resumable, self-limiting (the durable bulk form; re-run to converge):
waybackify cache fill docs --root /var/cache/wayback

# …or one capture at a time, composed by hand (what cache fill does in-process):
waybackify ledger docs --root /var/cache/wayback \
  | jq -r 'select(.state == "unfetched") | .waybackUrl' \
  | xargs -n1 -I{} waybackify cache add {} --root /var/cache/wayback

# Bootstrap a seen file from an existing corpus, then generate a new manifest offline-first:
waybackify ledger docs --flatten > seen.json
waybackify manifest docs/post/README.md -u universe.json -s seen.json -o docs/post/wayback.json
```

## Exit codes

| code | meaning |
|---|---|
| `0` | success (and `--help`) — `check`: verified **good** |
| `1` | domain failure — bad verdict (`check`: **wayback404**), not found, fetch failure, unresolved/no-verdict urls (`manifest`/`rewrite`) |
| `2` | usage error — unknown flag/command, missing required arg/flag (paparam strict mode) |
| `3` | `check`: **suspect** verdict — uncertain; nonzero **on purpose** (conservative composition must not silently pass junk) |
| `70` | internal — a command handler is missing from the bin wiring (defensive only; every handler is wired; BSD sysexits `EX_SOFTWARE`) |

## Architecture (hard rule)

This package stays a **thin CLI wrapper**: argv parsing
([paparam](https://github.com/holepunchto/paparam), v1.10.x — see the
source-driven notes at the top of [`src/cli.js`](./src/cli.js)), output
formatting, exit codes. Nothing else. Generation, application, the ledger
operations, verification plumbing, fetch/CDX logic, and the cache key scheme
live in the [`waybackify`](../waybackify) library (`manifest.js#generate`, `manifest.js#apply`,
`ledger.js`, `universe.js`); the parsing layer (`src/cli.js`) imports nothing
from it (test-enforced), and each command handler lazily imports exactly its
library entry points. (`src/commands/rewrite.js` is the CLI command; the
library's `rewrite.js` is the unrelated remaster capture-body rewriter — the
manifest applier is `manifest.js#apply`.)

## Development

```sh
pnpm --filter @autocache/waybackify-cli run test   # offline, zero network
pnpm --filter @autocache/waybackify-cli exec waybackify --help
```

Help output is snapshot-tested (`test/fixtures/help/*.txt`). When the surface
changes deliberately, regenerate with `node test/regen-help-fixtures.js` and
review the diff as a contract change.
