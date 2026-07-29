# Populating a bucket from the cache root

The runbook for projecting a local cache root onto a remote bucket — the
deploy step for wayback.charlie.dev's remote backends (Cloudflare R2 and
Fastly Object Storage). The **projection contract** (what the object keys and
metadata are, and why) lives in [CACHE.md](./CACHE.md#bucket-projection); this
document is the **operational procedure** only.

The cache root is the **archive of record**; every bucket is a rebuildable
projection of it ([CACHE.md](./CACHE.md#bucket-projection)). Nothing here ever
deletes a remote object — deletion is GC's separate, audited job.

## Contents

- [The two passes](#the-two-passes)
- [Prerequisites](#prerequisites)
- [Pass 1 — `cap/` bodies + bodiless objects (s5cmd)](#pass-1--cap-bodies--bodiless-objects-s5cmd)
- [Pass 2 — `meta/` sidecars (rclone copy)](#pass-2--meta-sidecars-rclone-copy)
- [Cloudflare R2](#cloudflare-r2)
- [Fastly Object Storage](#fastly-object-storage)
- [Verification](#verification)
- [Cost](#cost)
- [Source pins](#source-pins)

## The two passes

One population is **two passes, treated as ONE operation** — running only one
leaves the `cap/` and `meta/` layers drift-inconsistent (a bodied object with
no sidecar, or vice versa):

1. **`cap/`** — [`bucket push`](../src/commands/bucket-push.js)
   lists `meta/` and emits `s5cmd run` `cp` lines (bodies + zero-byte bodiless
   objects), each carrying native `Content-Type` + `x-amz-meta-status`. Piped
   to `s5cmd run`.
2. **`meta/`** — `rclone copy <root>/meta remote:<bucket>/meta`. The sidecar
   objects upload verbatim.

The emitter walks **`meta/` only, never `cap/`**, so orphan `cap/` files (a
crash between the body and sidecar renames) are excluded from the batch by
construction ([CACHE.md](./CACHE.md#write--atomicity-protocol)).

`bucket push` never mutates anything and never talks to the network — it
prints command lines. Inspect them first with `--dry-run` (writes the batch +
a summary to **stderr**, nothing to stdout, so an accidental `| s5cmd run` is a
no-op):

```sh
waybackify bucket push \
  --root <cache-root> --bucket <bucket> --empty-file "$EMPTY" --dry-run
```

## Prerequisites

- [`s5cmd`](https://github.com/peak/s5cmd) and [`rclone`](https://rclone.org/)
  on `PATH`.
- **Credentials via environment or a secret store — NEVER in a committed file
  or a config checked into the repo.** Both tools read
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from the environment; export
  them from your secret manager for the shell session and let them expire with
  it. rclone remotes below are shown with `env_auth = true` so no key is ever
  written to `rclone.conf`.
- **`export AWS_REGION`** (`us-east-1` for Fastly, `auto` for R2). SigV4 puts
  the region in the credential scope; s5cmd does **not** infer it from
  `--endpoint-url`, so omitting it is an `InvalidRequest` 400 on Fastly. It must
  equal the region token in the Fastly endpoint host (below).
- **The empty-file for bodiless entries** — a single zero-byte scratch file
  created **outside the cache root** (the root contract is: only the writer
  puts files under it). `bucket push` emits `cp <empty-file> …` lines for
  every bodiless entry (`status` empty/redirect/error — 1,085 as of
  2026-07-13: 17 empty + 1,068 error, 0 redirect), so they become zero-byte
  objects carrying status metadata (known-bad ≠ miss):

  ```sh
  EMPTY="$(mktemp)"    # zero bytes, OUTSIDE the cache root
  trap 'rm -f "$EMPTY"' EXIT
  ```

## Pass 1 — `cap/` bodies + bodiless objects (s5cmd)

Each emitted line is a complete s5cmd `cp` command (the run-file format —
[source pin](#source-pins)):

```
cp --content-type 'text/html; charset=utf-8' --metadata 'status=body' <root>/cap/<aa>/<hash> s3://<bucket>/cap/<aa>/<hash>
```

- `--content-type` is the sidecar's `contentType` **verbatim** — and is
  **always** present. When the sidecar's `contentType` is `''` (or absent) the
  emitter fills in an explicit `application/octet-stream` (the settled
  normalization rule). The flag is **never omitted**: an omitted
  `--content-type` does **not** fall through to a target default — s5cmd sniffs
  the local file client-side (Go's `http.DetectContentType`) and sends whatever
  it guesses, which for a zero-byte body is `text/plain; charset=utf-8`. The
  target only ever stores what it is told, so omitting the flag lands the wrong
  native Content-Type (verified identically on Cloudflare R2 and Fastly Object
  Storage) and fails the bucket verify parity gate.
- `--metadata 'status=<status>'` sets `x-amz-meta-status` on the object
  (s5cmd's repeatable `key=value` metadata flag → S3 user metadata).
- Values containing spaces or semicolons (`text/html; charset=utf-8`) are
  single-quoted; s5cmd splits each run-file line with `kballard/go-shellquote`
  (POSIX word-splitting), so the quoted value stays one token.

Pipe the batch straight into `s5cmd run` (`--endpoint-url` per target below):

```sh
waybackify bucket push \
  --root <cache-root> --bucket <bucket> --empty-file "$EMPTY" \
  | s5cmd --endpoint-url <endpoint> run
```

Objects are **immutable** (the key is a content-pinning hash), so re-running is
overwrite-safe and idempotent. Cap Fastly's per-bucket write rate with
`--numworkers` if you hit its throttle ([Fastly](#fastly-object-storage)).

## Pass 2 — `meta/` sidecars (rclone copy)

```sh
rclone copy <cache-root>/meta <remote>:<bucket>/meta
```

**`copy`, NEVER `sync`.** `rclone sync` makes the destination identical to the
source, which means it **deletes remote objects absent from the local root** —
an unreviewed remote sweep that a partial or freshly-checked-out root would
turn into mass deletion of live bucket entries. `rclone copy` only
adds/overwrites, never deletes. Remote deletion is exclusively GC's job.

## Cloudflare R2

- **Endpoint:** `https://<account-id>.r2.cloudflarestorage.com`
- **Region:** `auto` (required by the SDK, unused by R2).
- **Addressing:** virtual-hosted (R2's default); no path-style flag needed.

```sh
export AWS_ACCESS_KEY_ID=…       # from the secret store, not a file
export AWS_SECRET_ACCESS_KEY=…
export AWS_REGION=auto           # R2 ignores the value but SigV4 still needs one
R2=https://<account-id>.r2.cloudflarestorage.com

# pass 1
waybackify bucket push \
  --root <cache-root> --bucket <bucket> --empty-file "$EMPTY" \
  | s5cmd --endpoint-url "$R2" run

# pass 2 — rclone remote 'r2' (see rclone.conf below)
rclone copy <cache-root>/meta r2:<bucket>/meta
```

```ini
# rclone.conf — no secrets in the file; keys come from the environment
[r2]
type = s3
provider = Cloudflare
env_auth = true
region = auto
endpoint = https://<account-id>.r2.cloudflarestorage.com
```

## Fastly Object Storage

- **Endpoint:** regional, `https://<region>.object.fastlystorage.app`.
- **Region:** the Object Storage region token (NOT an AWS region name) — it
  must match the SigV4 credential scope **and** the endpoint host, or requests
  fail `InvalidRequest`. The nine tokens are `us-east-1`, `us-central-1`,
  `us-west-1`, `uk-east-1`, `eu-west-1`, `eu-central`, `eu-south-1`,
  `jp-central-1`, `au-east-1` — all suffixed `-1` **except `eu-central`** (the
  lone exception that caused the earlier `us-east` vs `us-east-1` confusion).
  The examples below pin `us-east-1`.
- **Addressing:** **path-style REQUIRED** — Object Storage does not support the
  bucket name in the hostname. s5cmd derives path-style from a non-AWS
  endpoint; for rclone set `force_path_style = true`.
- **Uploads must complete within 120 s** (else HTTP 408); multipart is
  supported for large objects, but corpus bodies are small (single PUT).
  Object ETags are **not** MD5 digests, so disable any client-side ETag/MD5
  integrity check that assumes they are.

```sh
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export AWS_REGION=us-east-1       # MUST match the region token in the endpoint host
FASTLY=https://us-east-1.object.fastlystorage.app

# pass 1 — cap Fastly's ~100 req/s per-bucket rate with --numworkers if needed
waybackify bucket push \
  --root <cache-root> --bucket <bucket> --empty-file "$EMPTY" \
  | s5cmd --endpoint-url "$FASTLY" --numworkers 32 run

# pass 2
rclone copy <cache-root>/meta fastly:<bucket>/meta
```

```ini
[fastly]
type = s3
provider = Fastly
env_auth = true
region = us-east-1
endpoint = https://us-east-1.object.fastlystorage.app
force_path_style = true
```

## Verification

Both passes done, confirm the projection is complete and faithful:

```sh
# counts — local vs remote must match per layer
find <cache-root>/cap  -type f | wc -l
find <cache-root>/meta -type f | wc -l
s5cmd --endpoint-url <endpoint> ls "s3://<bucket>/cap/*"  | wc -l
s5cmd --endpoint-url <endpoint> ls "s3://<bucket>/meta/*" | wc -l

# spot-hash — a remote sidecar is byte-identical to the local one
KEY=meta/77/77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac.json
s5cmd --endpoint-url <endpoint> cat "s3://<bucket>/$KEY" | shasum -a 256
shasum -a 256 "<cache-root>/$KEY"

# spot-metadata — a bodied cap/ object carries Content-Type + x-amz-meta-status
s5cmd --endpoint-url <endpoint> ls "s3://<bucket>/cap/77/77c4b856…"   # HEAD-level listing
```

## Cost

Full population is ≈ **23.7k Class A (write) operations per target** (≈ 11.8k
`cap/` PUTs + ≈ 11.8k `meta/` PUTs). At Fastly Object Storage's Class A rate
($0.0025 per 1,000 ops) that is ≈ **$0.06**; on R2 it is **$0** (1M Class A
ops/month are free). Re-runs are pennies — never a reason to skip a re-sync
after the root changes.

## Source pins

The emitter's line format and the endpoint/config choices above are pinned to
these primary sources (researched before the format was frozen):

- **s5cmd run-file format** — [`command/run.go`](https://github.com/peak/s5cmd/blob/master/command/run.go):
  each line is a full command minus the `s5cmd` prefix, tokenized with
  `kballard/go-shellquote` and parsed by that subcommand's own flagset, so
  per-line `--content-type` / `--metadata` work exactly as on the standalone
  command. Lines beginning with `#` are comments. Confirmed: **s5cmd carries
  per-object metadata in run-files** — the `aws s3 cp` fallback is unnecessary.
- **s5cmd `cp` flags** — [`command/cp.go`](https://github.com/peak/s5cmd/blob/master/command/cp.go):
  `--content-type` sets the object's Content-Type; `--metadata` is a repeatable
  `key=value` map flag surfaced as S3 user metadata (`x-amz-meta-<key>`), e.g.
  `--metadata 'status=body'`.
- **s5cmd endpoint/creds** — [README](https://github.com/peak/s5cmd): global
  `--endpoint-url`; credentials from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  / profiles.
- **Cloudflare R2 S3 API** — [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/):
  endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`.
- **Fastly Object Storage** — [Working with Object Storage](https://www.fastly.com/documentation/guides/platform/object-storage/working-with-object-storage/):
  regional `*.object.fastlystorage.app` endpoint, **path-style required**
  ("Object Storage doesn't support using bucket names in the hostname"),
  non-AWS region token in the SigV4 scope, 120 s upload window, ETags that
  aren't MD5 digests. Class A ops include `CreateMultipartUpload` /
  `CompleteMultipartUpload` / `PutObject` / `UploadPart`.
- **rclone copy vs sync** — [`rclone copy`](https://rclone.org/commands/rclone_copy/)
  ("skipping already copied", never deletes dest) vs
  [`rclone sync`](https://rclone.org/commands/rclone_sync/) ("Make source and
  dest identical, modifying destination only" — deletes dest extras);
  [S3 backend](https://rclone.org/s3/) provider config and
  [`--s3-force-path-style`](https://rclone.org/s3/#s3-force-path-style).
- **`aws s3 cp` fallback** (unused; kept for the record) —
  [AWS CLI `s3 cp`](https://docs.aws.amazon.com/cli/latest/reference/s3/cp.html):
  `--content-type`, `--metadata` (comma-joined `k=v,k2=v2` map — note this
  differs from s5cmd's repeated-flag form), `--endpoint-url`.
