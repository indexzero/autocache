# Reading the cache root — the consumer contract

How anything that CONSUMES a `waybackify cache` root reads it: the mirror
server's FsStore (Hono on Node) and the bucket sync loop that projects it to
S3-shaped Object Storage (Cloudflare R2, Fastly Object Storage — syncing IS
deployment). Written so the FsStore's implementer needs
nothing else; the producer-side story (write protocol, resume, schema
rationale) is [CACHE.md](./CACHE.md).

The one-sentence version: **hash the key, stat one sidecar, trust only the
sidecar** — the root has no index to consult, no lock to take, and no state
to rebuild.

## Contents

- [Key → path derivation](#key--path-derivation)
- [`head(key)` / `get(key)`](#headkey--getkey)
- [Sidecar-presence semantics](#sidecar-presence-semantics)
- [Status discriminators](#status-discriminators)
- [The orphan-body rule](#the-orphan-body-rule)
- [Serving a document with its requisites](#serving-a-document-with-its-requisites)
- [Bucket sync](#bucket-sync)
- [Integrity verification](#integrity-verification)
- [Reading a root that is being written](#reading-a-root-that-is-being-written)
- [Sources](#sources)

## Key → path derivation

Given a capture key `key = ${timestamp}/${originalUrl}` (what
`render/wayback/src/path.ts` parses out of a request path — flagless: one
body per (timestamp, url) however the replay framed it):

```js
import { capturePath, metaPath } from 'spv/waybackify/key.js'; // or the render/wayback/src/key.ts shim

const meta = `${root}/${await metaPath(key)}`;    // <root>/meta/<aa>/<hash>.json
const body = `${root}/${await capturePath(key)}`; // <root>/cap/<aa>/<hash>
```

`capturePath()`/`metaPath()` return **rootless, `/`-joined object keys**
(`cap/<aa>/<hash>`, `meta/<aa>/<hash>.json`) — the shared source of truth for
the `<aa>`-sharded layout, and the bucket object keys verbatim (see
[CACHE.md §Bucket projection](./CACHE.md#bucket-projection)). A local consumer
joins them under its root itself. Always derive through `key.js`
(`capturePath`/`metaPath`/`captureHash`) — never hand-roll the
digest or the shard. The pinned test digest
`sha256('20140403040000/http://example.com/') = 77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac`
exists in BOTH packages' suites precisely to catch a consumer deriving its
own variant. The raw `key` must never be used as a path component (2000+
char keys with `# ? | ^` and mixed-normalization unicode are real — edge
case EC-2).

## `head(key)` / `get(key)`

O(1), one or two syscalls, zero index — this satisfies the
`Store` interface in `render/wayback/src/store.ts`
(`head(key) → CaptureMeta | null`, `get(key) → Capture | null`):

```
head(key):
  hash the key → read meta/<aa>/<hash>.json
  ENOENT            → null                       (entry absent — including orphans)
  parse the sidecar → { contentType, size: contentLength, ... }

get(key):
  head(key); null → null
  status == "body" → open cap/<aa>/<hash> as a stream, return meta + body
  otherwise        → return meta with NO body (see status table)
```

Notes:

- `stat`/`open` on the sidecar path is the ONLY existence check. Do not
  probe `cap/` first (see the orphan rule).
- `contentType` may be `''` (archive sent none); serve
  `application/octet-stream` in that case (the same default the R2Store
  applies today).
- Parse failure of an existing sidecar is disk rot, not absence — fail loud
  (500), don't mask as a miss. (A future `waybackify fsck` is the recorded
  remediation tool.)

## Sidecar-presence semantics

**The sidecar is the entry.** Its presence is the single completion token
the writer publishes (atomic rename, last step of the write protocol —
CACHE.md §Write / atomicity protocol):

| on disk | meaning | consumer behavior |
|---|---|---|
| sidecar present, `cap/` present | complete bodied entry | serve it |
| sidecar present (`status != "body"`), `cap/` absent | complete BODILESS entry | serve status-appropriately, no body |
| sidecar absent, `cap/` present | **orphan** — crash between renames | absent: `null` / miss / do not sync |
| sidecar absent, `cap/` absent | never cached | absent |

## Status discriminators

`sidecar.status` tells a server what kind of capture this is; `contentHash`
and `contentLength` exist **iff** `status == "body"`:

| `status` | body file? | suggested serving |
|---|---|---|
| `body` | yes | stream `cap/<aa>/<hash>` with `sidecar.contentType` |
| `empty` | no | the capture replayed 200 with zero bytes: serve 200, empty body |
| `redirect` | no | the capture is an archived redirect (only recorded when the populating fetch didn't follow it); a server may 404 or proxy-redirect to the archive — its call, but it MUST NOT treat the entry as missing (that would trigger endless re-fetch attempts upstream) |
| `error` | no | the archive permanently lacks this asset (replay 404/410 at population time): serve 404. Its existence is the signal "don't try to populate this again" |
| `interstitial` | no | a wayback fluff page refused at cache time (#363: a wrapper stub, a redirect interstitial, a raw asset served as text/html, or an archived-error capture). We hold no servable content — the mirror server 302s to the archive replay (graceful degradation, like a miss), never serving the junk. The sidecar's `signature`/`target` are for the #364 remediation sweep, not for serving. It is NOT a miss (never re-fetched). |

## The orphan-body rule

A `cap/` file with no sidecar is **ingest garbage** from a crash between the
body rename and the sidecar rename. Rules:

1. **Never serve it.** `head`/`get` consult only the sidecar, so an orphan is
   naturally invisible — keep it that way.
2. **Never sync it.** Both sync loops iterate `meta/`, not `cap/` (below), so
   orphans are naturally excluded — keep it that way.
3. **Don't delete it either** (as a consumer): reaping is the writer's/GC's
   job, and deletion races a concurrent `waybackify cache` that may be about
   to publish that entry's sidecar.

The `status` field is what makes this rule sound: a legitimate bodiless
entry is sidecar-present/body-absent — the opposite parity of an orphan —
so the two states can never be confused (edge case EC-1).

## Serving a document with its requisites

A mirrored HTML page references its assets via wayback-shaped paths; after
the mirror's host-swap the server receives those requests as ordinary
capture keys. Requisite closure is a **derived query, not a serving precondition**:

- To serve page + assets, just serve each `get(key)` independently. A
  missing requisite 404s exactly like the live web — graceful degradation
  (a deliberate debate decision).
- To ANSWER "is this document requisite-complete?" (a health/verify view,
  or a sync pre-check): read the document sidecar's `requisites[]` (verbatim
  child keys) and `head()` each. That's the entire DAG walk — edges are only
  ever document→child, one level, stored on the document.
- Reverse edges ("which documents need this asset?") are derived by scanning
  `meta/` — never stored.

## Bucket sync

The bucket object keys ARE this local layout, verbatim (`cap/<aa>/<hash>`,
`meta/<aa>/<hash>.json`), so sync is a copy, not a mapping. Content-type rides
each `cap/` object's native `Content-Type` and status rides `x-amz-meta-status`
(one hybrid-metadata projection for every S3-shaped backend — Cloudflare R2,
Fastly Object Storage, AWS S3). The full projection + the operational runbook
(both passes, both targets, creds, cost) live in
[CACHE.md §Bucket projection](./CACHE.md#bucket-projection) and
[SYNC.md](./SYNC.md).

> Historical note: Fastly originally served from a KV Store (per-hash item
> names, content-type in the item's metadata field). That path was deleted
> outright when Fastly serving moved to Object Storage (#288); the KV-era sync
> mapping lives only in git history.

## Integrity verification

`sidecar.contentHash` is W3C SRI `sha256-<base64>` over the stored bytes
([SRI spec §3.1](https://www.w3.org/TR/sri-1/#integrity-metadata-description)),
recorded during the write. Consumers SHOULD verify it:

- **on sync** (cheap, sequential): hash `cap/<aa>/<hash>` while uploading;
  abort the object on mismatch.
- **on read** (optional — the server's latency call): a Node FsStore can hash the
  stream as it serves and log mismatches after the fact.

A mismatch means disk rot or a torn write that somehow survived fsync —
either way: do not serve/sync the entry, report it, leave remediation to
the (future) `fsck`.

## Reading a root that is being written

Safe by construction — this is the debate's composability constraint:

- Every visible file is complete (temp files live in `tmp/` and arrive by
  atomic rename; POSIX guarantees the new name is continuously visible —
  [rename(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html)).
- A sidecar you can read is an entry you can serve; its cap/ file (if
  `status == "body"`) was published BEFORE it, in the same filesystem.
- Same-key rewrites replace bytes with identical bytes (timestamp-pinned
  content), so an open file handle across a concurrent rename still reads a
  coherent body (the old inode).
- Never enumerate `tmp/`, never take locks, never cache negative results
  longer than your own request (an entry may complete at any moment).

## Sources

- [CACHE.md](./CACHE.md) — producer-side data structure (layout, schema, write protocol, dissents).
- Contracts in code: `render/wayback/src/store.ts` (Store/R2Store shapes) · `render/wayback/src/s3store.ts` (the S3 remote read path) · `render/wayback/src/path.ts` (request → capture key) · `spv/waybackify/key.js` (key/hash derivation).
- External: [Cloudflare R2 limits](https://developers.cloudflare.com/r2/reference/limits/) · [Fastly Compute resource limits](https://docs.fastly.com/products/compute-resource-limits) · [W3C SRI](https://www.w3.org/TR/sri-1/#integrity-metadata-description) · [POSIX rename(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html).
