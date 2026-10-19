# The cache root — on-disk data structure

Living documentation for the directory `waybackify cache add <wayback-url> --root <root>`
(and its bulk sibling `waybackify cache fill`) writes. This root is not a scratch cache: it is the **local mirror image
that IS the deploy artifact** for a wayback mirror — syncing it to
S3-shaped Object Storage (Cloudflare R2, Fastly Object Storage) is deployment,
and the mirror server reads it directly.

The layout began as the outcome of a five-voice design debate — **position E**:
identity-keyed body + authoritative sidecar recording a content hash
("Nix store-realization + containerd ingest-commit + cacache's
record-on-write integrity, minus cacache's authoritative index"). The
decisions, dissents, and edge cases that debate produced are reproduced in
full throughout this document. One decision has since changed: bodies are
now **content-addressed** by that recorded hash, so byte-identical
captures share one `cap/` file. Implementation:
[`src/waybackify/cache.js`](../src/waybackify/cache.js). Consumer contract:
[SERVE.md](./SERVE.md).

## Contents

- [Layout](#layout)
- [Identity: captureKey → hash](#identity-capturekey--hash)
- [The sidecar, field by field](#the-sidecar-field-by-field)
- [Canonical JSON form](#canonical-json-form)
- [Write / atomicity protocol](#write--atomicity-protocol)
- [Resume semantics](#resume-semantics)
- [The requisite DAG](#the-requisite-dag)
- [Browser-discovered requisites (v3)](#browser-discovered-requisites-v3)
- [Failure policy](#failure-policy)
- [Integrity and dedupe stance](#integrity-and-dedupe-stance)
- [Bucket projection](#bucket-projection)
- [The root contract and `fsck`](#the-root-contract-and-fsck)
- [Recorded dissents (design notes, not implemented)](#recorded-dissents-design-notes-not-implemented)
- [Worked example](#worked-example)
- [Sources](#sources)

## Layout

```
<root>/
  cap/<dd>/<digest>        body bytes, verbatim, NO extension, one file per
                           distinct body (content-addressed)
  meta/<aa>/<hash>.json    sidecar — AUTHORITATIVE (canonical JSON, one line)
  tmp/                     ingest scratch — MUST stay on the same filesystem
                           as cap/ and meta/ (atomic rename cannot cross
                           filesystems: rename(2) fails EXDEV)
  trash/<run>/cap/<dd>/<digest>
                           fsck's quarantine: an orphan body `cache verify
                           --fix` moved out of cap/, under its own relative
                           path. Never scanned as live content, never synced.

hash = sha256hex(captureKey)
captureKey = `${timestamp}/${originalUrl}`
aa = hash[0:2]                       (256-way shard)
digest = sha256hex(body bytes)       (the digest sidecar.contentHash records)
dd = digest[0:2]                     (256-way shard)
```

Rationale, per path:

- **`cap/<dd>/<digest>` — no extension, content-addressed.** Content-type
  lives ONLY in the sidecar. The filename is the digest of the bytes. The
  sidecar's `contentHash` names the body (`key.js#bodyPath`), so N captures
  with equal bytes (shared page chrome at N snapshot timestamps) are N
  sidecars and one body. Capture identity stays per `(timestamp, url)`: only
  the storage of equal bytes collapses. The bytes are **exactly what
  archive.org returned** — no toolbar stripping, no URL rewriting. Serve-time
  transforms are the mirror server's job; store-time transforms would make
  the mirror unable to reproduce the archive (the "verbatim bytes" decision).
- **`meta/<aa>/<hash>.json` — the sole authority.** The verbatim captureKey
  is unrecoverable from the hash, and R2 needs it verbatim, so the sidecar is
  mandatory — and given a mandatory authoritative sidecar, any second index
  is pure liability (the debate's "no authoritative index anywhere"
  conclusion). Name→content maps, contentHash→entries groupings, reverse
  requisite edges: all DERIVED by scanning `meta/`, never stored as truth.
- **`tmp/` inside the root.** POSIX `rename()` is atomic only within one
  filesystem; a cross-device rename fails `EXDEV`
  ([rename(2)/POSIX](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html);
  [Node `fsPromises.rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath)
  is a thin wrapper over it). Putting scratch anywhere else (e.g. `os.tmpdir()`)
  would silently turn the commit step into a non-atomic copy.
- **`aa` shard.** 256-way fan-out of directory entries, matching
  cacache/Nix practice. Flat would work at this corpus size (~12k entries) —
  see [the shard-sizing dissent](#recorded-dissents-design-notes-not-implemented).

## Identity: captureKey → hash

```
captureKey  = `${timestamp}/${originalUrl}`      (verbatim, UTF-8)
hash        = sha256hex(captureKey)              (64 lowercase hex chars)
```

Derived by ONE shared module — [`spv/waybackify/key.js`](../src/waybackify/key.js),
so the writer (this CLI) and the server derive **byte-identical** names. The
pinned digest `sha256('20140403040000/http://example.com/') = 77c4b856…` is
tested on both sides as the cross-package tripwire.

The sharded layout itself is derived by the same module, as **rootless,
`/`-joined keys**:

- `metaPath(key) → meta/<aa>/<hash>.json`, the local and the bucket sidecar key.
- `bodyPath(contentHash) → cap/<dd>/<digest>`, the local body key.
- `capturePath(key) → cap/<aa>/<hash>`, the per-capture bucket body object key
  (see [Bucket projection](#bucket-projection)).

The cache writer (`cache.js#entryPaths`/`#bodyFile`, which `path.join` them
under the root), the mirror server's `FsStore`, and the bucket sync all share
them. `path.join`'s OS separators live only in the local paths, never in a
returned key.

Identity-hashing is *forced*, not chosen — three independent constraints
converge on it:

1. The hash **is the bucket object key's `<hash>`** — every S3-shaped
   backend (Cloudflare R2, Fastly Object Storage, AWS S3) caps object keys at
   1,024 bytes and real archived originals run well past that, so a raw key
   is not a legal object key. The fixed-length hash is.
2. It is the only filesystem-safe encoding of the key space: components cap
   at 255 bytes (`NAME_MAX`), keys run past 2000 chars, and APFS is
   case- and unicode-normalization-insensitive by default — raw keys as
   paths would silently collide NFC/NFD variants.
3. It is the same operation the mirror server's FsStore performs to resolve an incoming
   request key.

The verbatim key survives ONLY in `sidecar.key` — which is why the sidecar is
authoritative and mandatory.

## The sidecar, field by field

`meta/<aa>/<hash>.json`, schema version `v: 3`:

> **Schema version.** Writers stamp `v: 3`. It carries the `interstitial`
> status with its `signature`/`target` fields and the optional
> `dynamic[]` array (below). Every consumer (mirror server `FsStore`, sync
> emitter, `fsck`, `remaster`, this CLI) accepts **only** `v: 3`. Any other
> version fails loud. No tool reads or upgrades an older sidecar. Rebuild an
> older root with `cache add` or `cache fill`.

| field | type | presence | rationale |
|---|---|---|---|
| `v` | int | always | Schema version (`3`). Bump on any incompatible change — an added enum value IS incompatible for an old reader — coordinated across every consumer (mirror server, sync tooling, this CLI). Readers accept only `3`. |
| `key` | string | always | **Verbatim** captureKey, UTF-8. The sole authoritative record of identity — unrecoverable from the hash. Byte-exact round-trip is acceptance criterion EC-2. |
| `contentType` | string | always (`''` when the archive sent none) | Rides each bucket object's native `Content-Type` header. Write-time enforced (key.js `assertMetadataSafe`): no CR/LF (the value rides an HTTP header — a raw newline is header injection), ≤ 1000 encoded bytes (the sync targets' object-metadata cap). |
| `status` | `body \| redirect \| error \| empty \| interstitial` | always | The **hasBody discriminator**. Bodiless captures (redirects, errors, zero-byte 200s — ~149 in the measured corpus — and `interstitial`) still get a sidecar; without `status`, a complete bodiless entry would be indistinguishable from a crash between the body and sidecar renames (a point hardened in the design debate). |
| `contentHash` | string | iff `status == "body"` | SRI form `sha256-<base64>` over the stored bytes ([W3C SRI: "hash-algo, a dash, and the base64-encoded digest"](https://www.w3.org/TR/sri-1/#integrity-metadata-description); [MDN SRI](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)). Computed **during the streaming write** — fsync guarantees durability of what was written, not that the right bytes were written. Only record-at-write enables verify-on-read (a non-negotiable from the design debate). The same digest is the body's **address**: `bodyPath(contentHash)` is `cap/<dd>/<digest>`. |
| `contentLength` | int | iff `status == "body"` | Byte count, counted during the same streaming write. |
| `signature` | string | iff `status == "interstitial"` | Which interstitial signature fired: `wrapper-stub`, `redirect-interstitial`, `extension-mismatch`, or `archived-error` (#363). The audit trail for why the capture was refused, and the key the #364 remediation sweep dispatches on. |
| `target` | `{ url, timestamp }` | iff `signature == "redirect-interstitial"` (when decodable) | The decoded destination of a redirect interstitial — the only content that page carried. Absent when the stub had no parseable `/web/…` reference. |
| `requisites` | string[] | always (`[]` for non-documents) | The authoritative DAG edge list: each entry a child's **verbatim captureKey**. Keys, not hashes — `sha256hex` is a pure function of the key, so a key edge is already a verifiable pointer, and storing the derived hash as data is the derived-as-authoritative anti-pattern. Verbatim child keys also make one document sidecar self-sufficient for subtree R2 sync. |
| `flag` | `im_ \| cs_ \| js_ \| oe_ \| null` | always | Requisite-type tag when this entry is itself a requisite (image / stylesheet / script / object-embed replay flags); `null` for operator-named documents. |
| `dynamic` | array of `{ key, flag, via, firstSeen? }` | optional (present only when a browser probe recorded runtime-discovered requisites; **absent** otherwise) | Browser-discovered requisites (v3). `key` is a child's verbatim captureKey (same identity rules as `requisites[]`); `flag` (`im_`/`cs_`/`js_`/`oe_`/`null`) is the replay flag for the raw-byte fetch, **persisted because it is unrecoverable from the stored bytes** — a runtime-leaked asset never appears in the captured HTML; `via` is the provenance enum (`remaster-verify` for probe-discovered, `manual` reserved); `firstSeen` is an optional ISO-8601 audit field. See [Browser-discovered requisites](#browser-discovered-requisites-v3). |
| `fetchedAt` | string | always | ISO-8601 fetch time. Provenance only — identity is entirely in `key`. |

### Interstitial captures (#363)

Some captures are not content — they are the Wayback Machine talking ABOUT
content: a **wrapper stub** (a `<title>Wayback Machine</title>` shell with an
`id="playback"` iframe, stored where a PDF/.txt should be and served as
text/html), a **redirect interstitial** (archive navbar chrome plus a
`setTimeout(go, 5000)` bounce), a raw asset (`.pdf`/`.txt`) stored as
`text/html`, or a capture the CDX index records as an archived 4xx/5xx while the
replay lies with a 200. `commitEntry` **refuses** to store any of these as a
body: the signature fires, and the entry commits `interstitial` — bodiless,
recording `signature` (and a redirect's `target`). The detection lives in
[`spv/waybackify/interstitial.js`](../src/waybackify/interstitial.js); the
`archived-error` signature is network-derived and arrives INJECTED (`cdxStatus`),
so detection itself never touches the wire. Wrapper-stub remediation refetches
the raw bytes with wayback's `id_` flag (`refetchRaw`); the corpus-wide run is
issue #364.

## Canonical JSON form

Sidecars are **canonical JSON**: recursively sorted keys, no insignificant
whitespace, single line, **no CR/LF anywhere** (not even a trailing newline —
the normative schema says "no CR/LF"; the canonicalization dissent's
dissent is adopted minus its trailing-newline detail). Two writers producing
the same logical entry produce byte-identical files, so rsync/diff/dedupe
tooling sees stability, not JSON key-order noise.

Implementation note: `JSON.stringify` emits string-keyed properties in
insertion order ([MDN, `Object.keys` ordering](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys#description);
ECMA-262 `OrdinaryOwnPropertyKeys`), so `canonicalJSON()` builds objects
sorted and stringifies; control characters in strings are escaped by
`JSON.stringify`, so raw CR/LF cannot appear. Pinned by test:
`raw === canonicalJSON(JSON.parse(raw))`.

## Write / atomicity protocol

Per entry — this is normative; `commitEntry()` in
[`cache.js`](../src/waybackify/cache.js) is the only writer:

```
1. stream body → tmp/<hash>.<pid>-<rand>.part      hashing as bytes flow
2. fsync the temp file
3. atomic rename → cap/<dd>/<digest>               (bytes visible, entry NOT complete)
4. build sidecar (with step 1's hash) → tmp/<hash>.<pid>-<rand>.json.part, fsync
5. atomic rename → meta/<aa>/<hash>.json           ← LAST. The completion token.
```

Bodiless entries (`status != "body"`) skip steps 1–3; the sidecar rename is
still the completion act. A zero-byte 200 body is demoted to `status:
"empty"` and its temp file discarded — empty entries own no `cap/` file. A body
whose bytes trip an [interstitial signature](#interstitial-captures-363) is
likewise refused before step 1 — the entry commits `interstitial` (bodiless),
never the junk page.

Citations for each primitive:

- **fsync** — [`filehandle.sync()`](https://nodejs.org/api/fs.html#filehandlesync):
  "Request that all data for the open file descriptor is flushed to the
  storage device", per [POSIX fsync(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/fsync.html).
- **atomic rename** — [`fsPromises.rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath)
  over [POSIX rename(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html):
  "if the link named by the new argument exists, it shall be removed and old
  renamed to new … the link named new shall remain visible to other threads
  throughout the renaming operation" — no observer ever sees a missing or
  partial final name. Same-filesystem only (`EXDEV` otherwise), hence
  `tmp/` inside the root.
- **streaming hash** — [`crypto.createHash`](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)
  with incremental [`hash.update()`](https://nodejs.org/api/crypto.html#hashupdatedata-inputencoding)
  per written chunk.

Directory fsyncs (a doubt-cycle hardening): after the **body** rename, the
implementation fsyncs `cap/<dd>` before writing the sidecar. A process crash
cannot reorder the two renames, but a power cut can persist the sidecar
rename while losing the body rename ([fsync(2) NOTES](https://man7.org/linux/man-pages/man2/fsync.2.html):
"Calling fsync() does not necessarily ensure that the entry in the directory
containing the file has also reached disk. For that an explicit fsync() on a
file descriptor for the directory is also needed") — which would fabricate a
complete-looking bodied entry with no body. The directory fsync pins the
ordering. The FINAL (meta) directory fsync is deliberately omitted: losing
the sidecar rename to a power cut merely re-exposes the entry as absent —
exactly the resume path. The protocol needs commit *ordering*, not commit
*durability*.

Concurrency: **no locks.** Writers use distinct temp names
(`<pid>-<rand>`). Two writers of equal bytes, under the same key or not, both
rename onto the one digest-named body. Both renames publish identical bytes,
so every sidecar that names the body stays true. Distinct keys never share a
sidecar path. Acceptance criterion EC-3 pins this.

## Resume semantics

- **Completion signal = the sidecar exists.** Nothing else. No done-markers,
  no journals.
- **Orphan-body rule:** `cap/` file present + no sidecar names it (crash between
  steps 3 and 5) ⇒ **ingest garbage**: the entry reports absent, resume
  re-fetches it to completion, and it is never served. There is NO ordering
  in which a partial entry is observable as complete, because the last
  atomic act publishes the only completion token. Acceptance criterion EC-1
  pins this with a real SIGKILL in the window.
- **The `status` field keeps orphans honest:** an intentionally bodiless
  entry is sidecar-present/body-absent (complete); an orphan is
  body-present/sidecar-absent (garbage). Opposite parities — they cannot be
  confused.
- **Fetch frontier on re-run** = for the document's sidecar, the entries in
  `requisites[]` whose own sidecar is missing. Complete entries are skipped
  **without a fetch** (the double-run no-op is pinned by test and was
  demonstrated live — see the PR).
- Corrupt sidecar JSON **throws** rather than silently re-fetching: the
  rename either published a whole fsync'd file or nothing, so a parse
  failure is disk rot — evidence to investigate (see the `fsck` dissent),
  not to overwrite.

## The requisite DAG

For an HTML document, every `im_`/`cs_`/`js_`/`oe_`-flagged wayback ref in
the replayed body is a **page requisite** — the asset URLs the replay itself
rewrote to point back into the archive
([`requisites.js`](../src/waybackify/requisites.js); `if_`/`id_` frame the
page and are not requisites).

- Edges live in the document sidecar's `requisites[]` — written atomically
  with the document entry, so the frontier is recomputable on every resume
  (an absent edge list would make resume silently under-fetch — a DAG-integrity
  point in the debate).
- Edges are **always recorded** for HTML documents, even under
  `--no-requisites`: the edges are facts of the captured page and the bytes
  are in hand. `--no-requisites` opts out of *fetching* children ("stores
  exactly one entry"), and a later default run resumes straight into the
  recorded frontier.
- **Closure is a query, never a write barrier** (the read-path-pragmatics argument): each
  entry (document or requisite) completes on its own body+sidecar. "Is this
  document requisite-complete?" = stat each child's sidecar. This keeps
  independent concurrent invocations from coupling through shared requisites
  (requisites ARE shared — the measured corpus had ~11k unique refs across
  869 documents).
- Requisite *fetch* URLs keep the replay flag (`…/web/<ts>im_/<original>` —
  the flagged replay serves the raw asset bytes); requisite *identity* is
  flagless (`key = <ts>/<original>` — one body per (timestamp, url) however
  it's framed, per `src/waybackify-serve/src/path.ts`). On resume the flags are
  recovered by re-extracting from the stored document body — the normative
  edge list stays flagless.

## Browser-discovered requisites (v3)

A static parse of the captured HTML finds the `requisites[]` above, but a real
browser render can pull in assets that never appear in those bytes — a font
`@import`-ed from a child stylesheet, an image a script injects at runtime. Those
are **dynamic requisites**, recorded in the sidecar's optional `dynamic[]` array
(schema v3).

- **Source.** Entries are written by `recordDynamic(root, docKey, entries)` from
  the `remaster verify` dynamic probe: a browser renders the served-localized doc
  and every request that still escapes to `web.archive.org` is a missing dynamic
  child. Each is recorded with `via: "remaster-verify"` (`manual` is reserved).
- **The persisted `flag`.** Unlike a requisite — whose replay flag is
  re-extractable from the stored document body — a dynamic child *never appears
  in the captured bytes*, so its `flag` (`im_`/`cs_`/`js_`/`oe_`/`null`) is stored
  in the entry. It is the only place that flag survives; the raw-byte fetch URL
  (`…/web/<ts><flag>/<original>`) is built from it, never re-extracted.
- **The frontier closes over `requisites ∪ dynamic`.** `cacheCapture` fans out to
  the union of static requisites and well-formed dynamic keys, so a run after
  `recordDynamic` fetches exactly the newly-recorded children (idempotent/resumable
  as ever — recorded-and-fetched children are skipped). `fsck`'s `incompleteClosure`
  likewise unions the two: a recorded-but-unfetched dynamic child keeps the store
  dirty exactly like a missing requisite, and a malformed `dynamic[]` entry is a
  `malformed` finding on the same trust boundary as a malformed requisite.
- **Merge is deterministic.** `recordDynamic` merges new entries onto any existing
  `dynamic[]`, de-duplicating by `key` (**existing wins** — first-seen provenance
  is never overwritten) and sorting by `key`, then re-commits the meta via the
  same tmp-write + atomic-rename path (the body is untouched;
  `contentHash`/`contentLength` and every other field carry over). Recording the
  same entries twice yields byte-identical meta. Attribution is **doc-level** —
  a dynamic child is recorded as "needed to render this document" even when its
  true parent is a child stylesheet.

## Failure policy

Per entry class (implementation-defined within the command's decided
semantics; recorded here as the contract):

| event | outcome | why |
|---|---|---|
| document fetch throw / replay non-200 | `cacheCapture` **throws**; nothing written | The operator named this capture; its absence is command failure. No partial entry exists to confuse a later run. |
| requisite replay **404/410** | `status: "error"` sidecar **committed** | The archive permanently lacks the asset (replay 404 = "capture missing from the archive", audit.js). Recording it keeps every future resume from re-hammering a known hole. |
| requisite fetch throw / **5xx** / other | recorded in `summary.failures`, **NOT committed** | Presumed transient (archive.org throttling); the next run retries — exactly the resume path. CLI exits 1 (`cache incomplete … rerun to resume`). |

## Integrity and dedupe stance

- `contentHash` is recorded at write for every bodied entry and is intended
  to be verified on read and on sync (verify-on-read is only possible
  because we recorded-on-write — the cacache lesson that generalizes).
- **Dedupe at write time.** Byte-identical bodies under distinct keys
  are stored ONCE, at the digest their shared `contentHash` records (EC-3).
  Each capture keeps its own sidecar, so replay stays byte-exact and the
  `(timestamp, url) → body` mapping is intact. The refetch is not avoided:
  the digest is unknown until the bytes arrive, so each capture key is still
  fetched once. GC is still **out of scope**. A body is garbage only when no
  sidecar names it: see the GC-leases dissent.

## Bucket projection

The cache root is the archive of record; every remote bucket (Cloudflare R2,
Fastly Object Storage) is a **rebuildable projection** of it:

```
cap/<aa>/<hash>          body object, ONE PER CAPTURE (the local
                         cap/<dd>/<digest> file its sidecar names, byte-for-byte)
meta/<aa>/<hash>.json    sidecar object (the local meta/ file, byte-for-byte)

hash = sha256hex(captureKey)          (capturePath/metaPath in key.js)
aa   = hash[0:2]
```

The sidecar keys are the local keys, verbatim. The body objects are NOT
content-addressed in the bucket: each one carries its own capture's
content-type and status as native metadata (below), so the mirror server
serves a capture in one GET by key. Two captures with equal bytes can still
differ in content-type, so they need two objects. The dedupe saves local
storage. The bucket keeps one object per capture. Every corpus key is POSIX-impossible raw (`# ; ? ^ |`, 2000+ bytes,
mixed unicode normalization), but the hashed layout is legal everywhere — R2
and S3-compatible object keys cap at 1,024 bytes, which a fixed `<hash>` never
approaches.

**Hybrid metadata carriage.** Content-type and status ride the object *twice*,
on purpose:

- `cap/` objects carry the sidecar's essentials as **native object metadata** —
  `Content-Type` from `sidecar.contentType`, plus `x-amz-meta-status` (the
  S3 user-metadata convention) from `sidecar.status` — so the mirror server
  serves a bodied entry in a **single GET**, no sidecar round-trip.
- `meta/` sidecars upload **verbatim as their own objects**, the canonical
  JSON unchanged. This is deliberate redundancy: the sidecar object is the
  authoritative, self-describing record the DAG walk and a future GC pass read
  (requisite edges, `contentHash`, provenance) — durable independently of any
  one `cap/` object's metadata, which a re-`PUT` could clobber.

**Copy-only sync.** The projection is add/overwrite, never delete-to-match:

- `cap/` — a batch emitter lists `meta/` (never `cap/`, so orphans are
  excluded by construction), maps each sidecar's shared local body to its
  per-capture object key, and hands the body-object set to
  [`s5cmd`](https://github.com/peak/s5cmd) for parallel copy.
- `meta/` — `rclone copy`, **never `rclone sync`**: `sync` deletes remote
  objects absent from the source, which would let a partial local root reap
  live bucket entries. The cache root is the archive of record, not a mirror
  to converge the bucket toward; deletion is a separate, audited GC concern
  (see the GC-leases dissent).

**Bodiless entries** (`status != "body"` — redirects, errors, empty 200s,
interstitials) become **zero-byte `cap/` objects** carrying the same `x-amz-meta-status`
(and `Content-Type` when present). A known-bad capture is thus distinguishable
from a miss at the object level — a `head` on the object returns status
metadata, the server answers per the [status discriminators](./SERVE.md#status-discriminators),
and a true miss (no object) stays a 302-to-archive.org.

The step-by-step population runbook (both passes, both targets, creds,
verification, cost) is [SYNC.md](./SYNC.md).

The consumer-side read contract is [SERVE.md §Bucket sync](./SERVE.md#bucket-sync).

> Historical note: Fastly originally served from a KV Store (hashed item
> names, content-type in the item metadata field). That path was deleted
> outright when Fastly serving moved to Object Storage (#288); the KV-era
> projection lives only in git history.

## The root contract and `fsck`

**A store root contains ONLY `cap/`, `meta/`, `tmp/`, and `trash/`.** Nothing
else belongs inside it. `trash/` is the quarantine `cache verify --fix` fills
(below). It is part of the contract so that a quarantined body is never a
foreign entry, and it is never live content. The root is a *rebuildable projection* — the archive of
record that projects onto R2 / Fastly Object Storage (see
[Bucket projection](#bucket-projection)) — so any
foreign entry is either uploaded as a junk object or silently dropped by the
sync. **Operational artifacts live OUTSIDE the root**: run reports, audit
checkpoints, driver logs, and any `.runs/`-style scratch belong to an
operational home alongside the store, never within it. The contract is exactly
four names so "what is the deploy artifact?" has one answer — walk the root,
everything you see is `cap/` + `meta/` + `tmp/` + `trash/`, and only the first
two project onto a bucket.

`fsck` is the verify-on-read command the design debate deferred (see the
Verification dissent below): a store without a verify pass rots silently,
because `contentHash` recorded at write only pays off when something later
re-checks it. It is exposed as **`waybackify cache verify`** (handler:
[`spv/waybackify-cli/src/commands/cache-verify.js`](../src/waybackify-cli/src/commands/cache-verify.js);
engine: [`spv/waybackify/fsck.js`](../src/waybackify/fsck.js)).

```
waybackify cache verify --root <store> [--fix] [--json] [--quiet]
```

It walks `meta/` (the authority) and `cap/`, locating each body through its
sidecar's `contentHash` exactly as `cache.js` does, and reports — **report-only by default**, non-zero exit on any
discrepancy:

| category | severity | meaning |
|---|---|---|
| `hashMismatch` | corruption | `status: "body"` whose `contentHash` ≠ the SRI of the `cap/` bytes — the one failure `fsync` cannot catch (it persists *what* was written, not *that the right bytes* were). |
| `sizeMismatch` | corruption | `status: "body"` whose `contentLength` ≠ the size of the `cap/` file its `contentHash` names. A sidecar that names another capture's body passes the hash check by construction (the digest is the file name), and this check catches it. |
| `keyMismatch` | corruption | sidecar filed under a hash ≠ `sha256hex(sidecar.key)` — misfiled or tampered (the `readSidecar` authenticity check). |
| `missingBody` | corruption | `status: "body"` with no `cap/` file at its `contentHash` (or with a `contentHash` that is not a sha256 SRI) — an incomplete entry (the body rename was lost, or a body was deleted under a complete sidecar). |
| `incompleteClosure` | incomplete | a `status: "body"` doc that references a page requisite (`im_`/`cs_`/`js_`/`oe_` captureKey in its `requisites[]`) **or** a well-formed browser-discovered dynamic child (a `dynamic[].key`, v3 — findings marked `dynamic: true`) whose own sidecar is absent from this store. The frontier is `requisites ∪ dynamic`. Store-relative (the doc's own edge list; no ledger, no network). **Report only** — a short closure is filled by re-running `cache add`/`cache fill`, never by reaping — but it keeps the store dirty (nonzero exit) until complete. |
| `malformed` | corruption | a sidecar that will not parse — disk rot, not absence (the rename published a whole fsync'd file or nothing) — **or** a structurally-bad `dynamic[]` entry (v3): `dynamic` present but not an array, or an entry that is not an object / has a non-string or separatorless `key` / a `flag` outside `{im_,cs_,js_,oe_,null}`. Same trust boundary as a malformed requisite. A `status` outside `{body, empty, redirect, error, interstitial}` is malformed too: such a sidecar cannot say whether it owns a body. So is a bodiless status that carries `contentHash` or `contentLength` (present iff `status: "body"`): that is a body sidecar whose status rotted, and its body sits in `cap/` unnamed. |
| `interstitialAsBody` | advisory | a `status: "body"` entry whose stored bytes are a wayback interstitial (#363) — a pre-schema capture that predates cache-time refusal. **Report only**: the corpus-wide re-commit is the #364 remediation sweep, not fsck's to perform. |
| `schemaVersion` | advisory | a sidecar whose `v` is not `3`, the one version every reader accepts. Rebuild the root. |
| `foreignRoot` | advisory | a root entry outside `cap/` `meta/` `tmp/` `trash/` — the check that catches a contract violation like a stray `.runs/`. |
| `orphanCap` | reapable | a `cap/` file that no sidecar's `contentHash` names — ingest garbage from a crash between the body and sidecar renames (never served: no completion token). A body shared by many sidecars is an orphan only when none names it. fsck reports an orphan only when every sidecar proves its ownership: it parses, carries a known status, and (for `status: "body"`) names a `cap/` file whose bytes match its `contentHash` and whose size equals its `contentLength`. While a `malformed`, `missingBody`, `hashMismatch`, `sizeMismatch`, or `schemaVersion` finding stands, no `cap/` file is reported orphan and `--fix` moves nothing. The report says so with `reapSuspended: true`. `--fix` **moves** an orphan to the `trash/` quarantine, it never deletes one (below). |
| `staleTmp` | reapable | leftover `tmp/` scratch from an interrupted write. `--fix` deletes it: a `tmp/` file was never renamed into place, so nothing can name it. |

`--fix` acts **only** on the two reapable classes — `orphanCap` and `staleTmp` —
neither of which is reachable by any reader (an orphan has no completion token;
a `tmp/` file was never renamed into place). It **never** touches a valid entry
and **refuses** to "fix" corruption: a `hashMismatch` / `sizeMismatch` /
`keyMismatch` / `missingBody` / `malformed` finding is evidence to investigate,
not garbage to sweep. It also never deletes a `foreignRoot` entry. The entry is
operational data, possibly precious, and the operator relocates it.

### Two rot shapes the proof cannot see

The ownership proof trusts every sidecar that passes it, and two shapes of rot
pass it while they leave a body unnamed:

1. **A `contentHash` rotted to another live body of the same size.** The
   digest is the file name, so the hash check passes by construction, and the
   size check passes because the sizes are equal. The sidecar's own body now
   has no referrer.
2. **A `status` rotted to a bodiless value that also drops `contentHash` and
   `contentLength`.** The result is a well-formed bodiless sidecar. Nothing in
   it says a body ever existed, so nothing names the body still in `cap/`.

A sidecar records only the hash and the length of its bytes, so no check can
tell either shape from a legitimate store. Both make the unnamed body an
`orphanCap` finding. The quarantine below is the protection: `--fix` moves
such a body out of `cap/` and never deletes it, so an operator who later finds
the rot restores the bytes with `--restore <run>`.

### Quarantine: `--fix` never deletes a body

`--fix` does not delete an orphan body. It moves the file into a quarantine
directory inside the root, `trash/<run>/cap/<dd>/<digest>`, with one `rename`
on the same filesystem. `<run>` is the ISO timestamp of the verify run, so
every run has its own directory. The body keeps its relative path, and the
report lists each move (`reaped.moves`, `reaped.trash`). A later `cache verify`
inventories `trash/` (`counts.trashFiles`) and never scans it as live content:
a quarantined body is not a `cap/` file, not an orphan, and not a finding. The
sync never uploads it, because `bucket push` walks `meta/` only.

To **restore** a run, use the restore action. It moves each body of that run
back to `cap/<dd>/<digest>` **only when no live file exists at that path**.
A body whose live path is occupied (a refetch already repaired it) is skipped,
reported, and left in the quarantine, so a restore never replaces a live body.
Do not restore with a bare `mv`: it replaces a repaired body with stale
evidence. The library exposes the same action as `fsck.js#restoreTrash(root, run)`.

```sh
waybackify cache verify --root <root> --restore <run>
```

To **empty** the quarantine, run the explicit, separate action. It is the only
path that deletes a body file, and it runs before the verify so that the run's
own moves survive it:

```sh
waybackify cache verify --root <root> --empty-trash
```

The library exposes the same action as `fsck.js#emptyTrash(root)`, which
returns the path, file count, and byte total it removed.

## Recorded dissents (design notes, not implemented)

Preserved verbatim from the debate so future work starts from the residue,
not from scratch:

- **Verification:** ship a first-class `waybackify fsck` — scan `meta/`,
  re-verify every `contentHash`, reap orphan `tmp/`/`cap/` files. "A store
  without a verify command rots silently." *(Shipped — see
  [The root contract and `fsck`](#the-root-contract-and-fsck); the CLI
  subcommand front-end is the outstanding piece.)*
- **DAG integrity:** requisite edges could carry the child's `contentHash`
  alongside its key, so a requisite whose bytes ever change under a shared
  timestamp is detectable — "you're trusting the timestamp to pin content;
  I'd rather the graph SAY it."
- **Shard sizing:** the 2-char shard is unjustified until directory-size
  measurements exist — "flat `cap/` is one fewer directory op on the read
  path; add shards when you measure a problem." *(Shard kept: changing it
  later is a straight re-shard of derivable paths.)*
- **Canonical serialization:** canonicalize sidecars (sorted keys, newline-terminated)
  — adopted, except newline-termination lost to the schema's "no CR/LF".
- **GC safety:** add explicit leases/refcounts before ANY GC ships —
  "GC without leases will race a concurrent writer and delete a live
  requisite."

## Worked example

A real run against the test fixture (`test/fixtures/replay/requisites-page.html`
served through a canned fetch; 1 document + 8 requisites), summary line then
tree:

```json
{"key":"20111011002337/http://example.com/post/scaling-isomorphic-javascript-code","hash":"e38115d15f830d2b6cd3fefccb61b72d7953b90ae9ed68650c4cd0a7257abfe7","root":"/tmp/cache-root-demo","entries":9,"fetched":9,"skipped":0,"failed":0}
```

```
<root>
├── cap
│   ├── 0d/0d5b217972e06b4f9563973bc374ca22e037d2eabfc8764f966c94a8d3c33bd9
│   ├── 0e/0efaebc74281aef44a7532d1517882394809946a3f68e75969d8ae0d0330d9f8
│   ├── 33/33e7f1b360a407626825c9e8cb1f3dc92bd2168f4d20548ac2cc9f152596c834
│   ├── 74/741a81c4c12277668c2218fd97791a08b9f165fd91f1155337cc7766c68b2d10
│   ├── 76/76afe6b87f4a0706a6ce19b3d4a02f40a3a7edc8e6027686b993fa3c75f1e0f8
│   ├── 89/89427493533e39df854efedd20e67bb5e72d6442613cf3b98beaed17e625e271
│   ├── e3/e38115d15f830d2b6cd3fefccb61b72d7953b90ae9ed68650c4cd0a7257abfe7   ← the document
│   ├── f3/f31e6afe498a4be7bc021c2ada0df23c7c61686ce027cd053f81d8641bfa447b
│   └── f6/f6209b3334a90a0a99a605f9afd1cfa0a05bfe3b5516386d3c04bf87b7994e8a
├── meta
│   ├── 0d/0d5b21…bd9.json  … 89/894274…271.json   (one sidecar per cap file)
│   ├── e3/e38115d15f830d2b6cd3fefccb61b72d7953b90ae9ed68650c4cd0a7257abfe7.json
│   └── f3/… f6/…
├── tmp/                                            (empty after a clean run)
└── trash/                                          (absent until a --fix moves an orphan)
```

The document's sidecar (one line on disk; wrapped here for reading):

```json
{"contentHash":"sha256-VE/tUYSKIZno5SlD9dQPr/EnwZ9TbGT/MN7W2fWyXks=",
 "contentLength":2322,
 "contentType":"text/html; charset=utf-8",
 "fetchedAt":"2026-07-12T03:42:06.450Z",
 "flag":null,
 "key":"20111011002337/http://example.com/post/scaling-isomorphic-javascript-code",
 "requisites":["20111011002337/http://example.com/css/screen.css",
   "20111011002337/http://example.com/css/print.css",
   "20111011002337/http://example.com/js/jquery-1.4.2.min.js",
   "20111011002337/http://ajax.googleapis.com/ajax/libs/jquery/1.4/jquery.min.js",
   "20111011002337/http://example.com/images/diagram.png",
   "20111011002337/http://static.example.com/avatar.gif?s=48&d=identicon",
   "20111011002337/http://example.com/media/demo.swf",
   "20111011002337/http://example.com/images/collapsed-scheme.jpg"],
 "status":"body",
 "v":3}
```

…and one requisite's (`oe_`-flagged flash embed):

```json
{"contentHash":"sha256-H/aMovig05N2yTHAO8cHyTjwUBjzTfc08lPGAo4PCsQ=",
 "contentLength":14,
 "contentType":"application/x-shockwave-flash",
 "fetchedAt":"2026-07-12T03:42:06.535Z",
 "flag":"oe_",
 "key":"20111011002337/http://example.com/media/demo.swf",
 "requisites":[],
 "status":"body",
 "v":3}
```

## Sources

- Node.js: [`fsPromises.rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath) · [`filehandle.sync`](https://nodejs.org/api/fs.html#filehandlesync) · [`crypto.createHash`](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options) · [`hash.update`](https://nodejs.org/api/crypto.html#hashupdatedata-inputencoding) · [global WebCrypto](https://nodejs.org/api/globals.html#crypto).
- POSIX: [rename(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html) · [fsync(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/fsync.html).
- W3C/MDN: [Subresource Integrity §integrity metadata](https://www.w3.org/TR/sri-1/#integrity-metadata-description) · [MDN SRI](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) · [MDN `Object.keys` ordering](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys#description).
- Fastly: [Object Storage](https://docs.fastly.com/products/object-storage) · [Compute resource limits](https://docs.fastly.com/products/compute-resource-limits).
- Cloudflare: [R2 limits (object key ≤ 1,024 bytes)](https://developers.cloudflare.com/r2/reference/limits/).
