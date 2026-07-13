# @charlie.dev/waybackify-cli

`waybackify` — the human-operable, `xargs`-composable front door over the
[`spv/waybackify`](../waybackify) library.

**Status: surface pinned; handlers landing one command at a time.**
The full command/option surface below is fixed (names, args, flags, help
text, exit codes — snapshot-tested). `check`, `search`, and `cache` are
implemented (`cache`: see [docs/CACHE.md](./docs/CACHE.md) and
[docs/SERVE.md](./docs/SERVE.md)); `manifest` currently exits `70` (not
implemented) until its handler lands.

## Commands

```
waybackify check <wayback-url>
waybackify search <original-url> [--near <ts>] [--limit <n>]
waybackify manifest <file.md> [--ledger]
waybackify cache <wayback-url> -o <root> [--no-requisites]
```

| command | does | output |
|---|---|---|
| `check` | Full **wayback-404 verdict** for the exact capture: CDX `statuscode` + soft-404 content heuristics on the replay body — the corpus audit primitive | JSON verdict on stdout (`{verdict: good\|wayback404\|suspect, statuscode, reason, snippet}`); exit 0 = verified good, nonzero = bad/suspect |
| `search` | CDX capture query (the library's `getSnapshot`/`getSnapshots` face) — for re-picking a better capture when `check` flags one bad. No date-anchoring cleverness: `--near` passes through, default is CDX's own ordering | JSONL: `{timestamp, statuscode, mimetype, waybackUrl}` per capture |
| `manifest` | Per-file enumeration of wayback refs. **Inline links only by default**; `--ledger` folds in the sibling `wayback.json` entries. Corpus scope is deliberately NOT built in — that's `find words -name index.md \| xargs waybackify manifest` | JSONL: `{post, source: inline\|ledger, timestamp, originalUrl, waybackUrl}` |
| `cache` | Fetch the capture into a **local bucket image** at `<root>` — the wayback.charlie.dev mirror's population path. Syncing that dir to R2 / Fastly KV (rclone/wrangler/fastly tooling) IS deployment | files written under the shared key scheme; summary line on stdout |

Composability is the design goal:

```sh
find words -name index.md | xargs waybackify manifest | jq -r .waybackUrl | xargs -n1 waybackify check
```

## Exit codes

| code | meaning |
|---|---|
| `0` | success (and `--help`) — `check`: verified **good** |
| `1` | domain failure — bad verdict (`check`: **wayback404**), not found, fetch failure |
| `2` | usage error — unknown flag/command, missing required arg/flag (paparam strict mode) |
| `3` | `check`: **suspect** verdict — uncertain; nonzero **on purpose** (conservative composition — `manifest \| xargs check` must not silently pass junk) |
| `70` | not implemented — **temporary**, removed as handlers land (BSD sysexits `EX_SOFTWARE`) |

## Architecture (hard rule)

This package stays a **thin CLI wrapper**: argv parsing
([paparam](https://github.com/holepunchto/paparam), v1.10.x — see the
source-driven notes at the top of [`src/cli.js`](./src/cli.js)), output
formatting, exit codes. Nothing else. All verification plumbing, fetch/CDX
logic, and the cache key scheme live in `spv/waybackify`; this scaffold
imports nothing from it (test-enforced).

## Development

```sh
pnpm --filter @charlie.dev/waybackify-cli run test   # offline, zero network
pnpm --filter @charlie.dev/waybackify-cli exec waybackify --help
```

Help output is snapshot-tested (`test/fixtures/help/*.txt`). When the surface
changes deliberately, regenerate with `node test/regen-help-fixtures.js` and
review the diff as a contract change.
