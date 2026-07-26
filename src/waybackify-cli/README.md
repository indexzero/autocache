# @charlie.dev/waybackify-cli

`waybackify` — the human-operable, `xargs`-composable front door over the
[`waybackify`](../waybackify) library.

**Status: surface v2 pinned; all six commands implemented.**
The full command/option surface below is fixed (names, args, flags, help
text, exit codes — snapshot-tested). Surface v2 speaks the settled
vocabulary: a `wayback.json` is a **Manifest** (one source file's standalone
rewrite program), the **Universe** is compile-time policy, and the **Ledger**
is the collection of manifests under a tree. The v1 per-file
markdown-extraction `manifest` command and its `--ledger` flag are gone —
their meanings were inverted from these concepts.

## Commands

```
waybackify manifest <source.md> -u universe.json [-s seen.json] -o wayback.json [--offline]
waybackify rewrite  <source.md> -m wayback.json -o <out.md>
waybackify ledger   <dir> [--flatten] [--against <cache-root>]
waybackify check    <wayback-url>
waybackify search   <original-url> [--near <ts>] [--limit <n>]
waybackify cache    <wayback-url> -o <root> [--no-requisites]
```

| command | does | output |
|---|---|---|
| `manifest` | **Generate** the manifest for one markdown source: extract live links, bake the Universe subset (`-u`, policy), copy verdicts from the seen union (`-s`, **read-write**, Manifest-shaped — bootstrap it with `ledger --flatten`), resolve only never-seen urls against the archive. **Idempotent**: a rerun with the same seen file makes zero network calls and writes byte-identical output. `--offline` fails on urls the universe + seen cannot answer instead of querying | canonical manifest at `-o`; seen file extended in place; one JSON stats line (`{output, urls, fromUniverse, fromSeen, resolved, deferred}`) on stdout; unresolved urls → stderr + exit 1, rerun to resume |
| `rewrite` | **Apply** a manifest to a markdown source (the library's `manifest.js#apply`): precedence `exclude → rewrites → entries → untouched + warn`; fenced code and link text never touched; already-archived links pass through | the published form at `-o`; a url with no verdict warns on stderr and exits 1 (written anyway, untouched — surfaced, never guessed) |
| `ledger` | Survey the **collection**: every `wayback.json` under `<dir>`, file paths as identity. `--flatten` unions the ledger into ONE canonical manifest (the seen-file bootstrap); `--against <cache-root>` joins referenced captures against the cache's sidecars | default: JSONL `{file, entries, rewrites, exclude}` (counts); `--flatten`: one canonical manifest JSON; `--against`: JSONL `{state: unfetched\|cached\|interstitial\|error, key, waybackUrl, timestamp, originalUrl, files, status}` |
| `check` | Full **wayback-404 verdict** for the exact capture: CDX `statuscode` + soft-404 content heuristics on the replay body — the corpus audit primitive | JSON verdict on stdout (`{verdict: good\|wayback404\|suspect, statuscode, reason, snippet}`); exit 0 = verified good, nonzero = bad/suspect |
| `search` | CDX capture query (the library's `getSnapshot`/`getSnapshots` face) — for re-picking a better capture when `check` flags one bad. No date-anchoring cleverness: `--near` passes through, default is CDX's own ordering | JSONL: `{timestamp, statuscode, mimetype, waybackUrl}` per capture |
| `cache` | Fetch the capture into a **local bucket image** at `<root>` — the wayback.charlie.dev mirror's population path. Syncing that dir to R2 / Fastly KV (rclone/wrangler/fastly tooling) IS deployment | files written under the shared key scheme; summary line on stdout |

Composability is the design goal:

```sh
# Populate a cache root with everything a ledger references but the cache lacks:
waybackify ledger docs --against /var/cache/wayback \
  | jq -r 'select(.state == "unfetched") | .waybackUrl' \
  | xargs -n1 waybackify cache -o /var/cache/wayback

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
| `70` | internal — a command handler is missing from the bin wiring (defensive only; all six are wired; BSD sysexits `EX_SOFTWARE`) |

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
pnpm --filter @charlie.dev/waybackify-cli run test   # offline, zero network
pnpm --filter @charlie.dev/waybackify-cli exec waybackify --help
```

Help output is snapshot-tested (`test/fixtures/help/*.txt`). When the surface
changes deliberately, regenerate with `node test/regen-help-fixtures.js` and
review the diff as a contract change.
