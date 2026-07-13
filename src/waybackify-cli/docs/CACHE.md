# The cache root — on-disk data structure

Living documentation for the directory `waybackify cache <wayback-url> -o <root>`
writes. This root is not a scratch cache: it is the **local mirror image
that IS the deploy artifact** for wayback.charlie.dev — syncing it to
S3-shaped Object Storage (Cloudflare R2, Fastly Object Storage) is deployment,
and the mirror server reads it directly.

The layout is the outcome of a five-voice design debate — **position E**:
identity-keyed body + authoritative sidecar recording a content hash
("Nix store-realization + containerd ingest-commit + cacache's
record-on-write integrity, minus cacache's authoritative index"). The
decisions, dissents, and edge cases that debate produced are reproduced in
full throughout this document. Implementation:
[`spv/waybackify/cache.js`](../../waybackify/cache.js). Consumer contract:
[SERVE.md](./SERVE.md).

## Contents

- [Layout](#layout)
- [Identity: captureKey → hash](#identity-capturekey--hash)
- [The sidecar, field by field](#the-sidecar-field-by-field)
- [Canonical JSON form](#canonical-json-form)
- [Write / atomicity protocol](#write--atomicity-protocol)
- [Resume semantics](#resume-semantics)
- [The requisite DAG](#the-requisite-dag)
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
  cap/<aa>/<hash>          body bytes, verbatim, NO extension
  meta/<aa>/<hash>.json    sidecar — AUTHORITATIVE (canonical JSON, one line)
  tmp/                     ingest scratch — MUST stay on the same filesystem
                           as cap/ and meta/ (atomic rename cannot cross
                           filesystems: rename(2) fails EXDEV)

hash = sha256hex(captureKey)
captureKey = `${timestamp}/${originalUrl}`
aa = hash[0:2]                       (256-way shard)
```

Rationale, per path:

- **`cap/<aa>/<hash>` — no extension.** Content-type lives ONLY in the
  sidecar; the filename is pure identity. The bytes are **exactly what
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

Derived by ONE shared module — [`spv/waybackify/key.js`](../../waybackify/key.js),
extracted from `render/wayback/src/key.ts` (now a re-export shim), so
the writer (this CLI) and the server derive **byte-identical** names. The
pinned digest `sha256('20140403040000/http://example.com/') = 77c4b856…` is
tested on both sides as the cross-package tripwire.

The `<aa>`-sharded layout itself is derived by the same module:
`capturePath(key) → cap/<aa>/<hash>` and `metaPath(key) → meta/<aa>/<hash>.json`
return **rootless, `/`-joined object keys** — the one source of truth the
cache writer (`cache.js#entryPaths`, which `path.join`s them under the root),
the mirror server's `FsStore`, and the [bucket sync](#bucket-projection) all
share. These object keys ARE the bucket keys, verbatim; `path.join`'s OS
separators live only in the local paths, never in a returned key.

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

`meta/<aa>/<hash>.json`, schema version `v: 1`:

| field | type | presence | rationale |
|---|---|---|---|
| `v` | int | always | Schema version. Bump on any incompatible change, coordinated across every consumer (mirror server, sync tooling, this CLI). |
| `key` | string | always | **Verbatim** captureKey, UTF-8. The sole authoritative record of identity — unrecoverable from the hash. Byte-exact round-trip is acceptance criterion EC-2. |
| `contentType` | string | always (`''` when the archive sent none) | Rides each bucket object's native `Content-Type` header. Write-time enforced (key.js `assertMetadataSafe`): no CR/LF (the value rides an HTTP header — a raw newline is header injection), ≤ 1000 encoded bytes (the sync targets' object-metadata cap). |
| `status` | `body \| redirect \| error \| empty` | always | The **hasBody discriminator**. Bodiless captures (redirects, errors, zero-byte 200s — ~149 in the measured corpus) still get a sidecar; without `status`, a complete bodiless entry would be indistinguishable from a crash between the body and sidecar renames (a point hardened in the design debate). |
| `contentHash` | string | iff `status == "body"` | SRI form `sha256-<base64>` over the stored bytes ([W3C SRI: "hash-algo, a dash, and the base64-encoded digest"](https://www.w3.org/TR/sri-1/#integrity-metadata-description); [MDN SRI](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)). Computed **during the streaming write** — fsync guarantees durability of what was written, not that the right bytes were written; only record-at-write enables verify-on-read (a non-negotiable from the design debate). **Integrity, not addressing**: the filename stays the identity hash. |
| `contentLength` | int | iff `status == "body"` | Byte count, counted during the same streaming write. |
| `requisites` | string[] | always (`[]` for non-documents) | The authoritative DAG edge list: each entry a child's **verbatim captureKey**. Keys, not hashes — `sha256hex` is a pure function of the key, so a key edge is already a verifiable pointer, and storing the derived hash as data is the derived-as-authoritative anti-pattern. Verbatim child keys also make one document sidecar self-sufficient for subtree R2 sync. |
| `flag` | `im_ \| cs_ \| js_ \| oe_ \| null` | always | Requisite-type tag when this entry is itself a requisite (image / stylesheet / script / object-embed replay flags); `null` for operator-named documents. |
| `fetchedAt` | string | always | ISO-8601 fetch time. Provenance only — identity is entirely in `key`. |

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
[`cache.js`](../../waybackify/cache.js) is the only writer:

```
1. stream body → tmp/<hash>.<pid>-<rand>.part      hashing as bytes flow
2. fsync the temp file
3. atomic rename → cap/<aa>/<hash>                 (bytes visible, entry NOT complete)
4. build sidecar (with step 1's hash) → tmp/<hash>.<pid>-<rand>.json.part, fsync
5. atomic rename → meta/<aa>/<hash>.json           ← LAST. The completion token.
```

Bodiless entries (`status != "body"`) skip steps 1–3; the sidecar rename is
still the completion act. A zero-byte 200 body is demoted to `status:
"empty"` and its temp file discarded — empty entries own no `cap/` file.

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
implementation fsyncs `cap/<aa>` before writing the sidecar. A process crash
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

Concurrency: **no locks.** Same-key writers use distinct temp names
(`<pid>-<rand>`) and both rename onto the same final name — last-writer-wins
on identical bytes (the wayback timestamp pins capture content). Distinct
keys never share paths. Acceptance criterion EC-3 pins this.

## Resume semantics

- **Completion signal = the sidecar exists.** Nothing else. No done-markers,
  no journals.
- **Orphan-body rule:** `cap/` file present + sidecar absent (crash between
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
([`requisites.js`](../../waybackify/requisites.js); `if_`/`id_` frame the
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
  it's framed, per `render/wayback/src/path.ts`). On resume the flags are
  recovered by re-extracting from the stored document body — the normative
  edge list stays flagless.

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
- **No dedupe at write time.** Byte-identical bodies under distinct keys are
  stored independently (EC-3). `contentHash` makes a future GC pass —
  group sidecars by hash, hardlink the identity-named bodies — cheap and
  safe, but GC is **explicitly out of scope**: see the GC-leases dissent.

## Bucket projection

The cache root is the archive of record; every remote bucket (Cloudflare R2,
Fastly Object Storage) is a **rebuildable projection** of it. The projection
is deliberately trivial — the bucket object keys ARE the local layout,
verbatim:

```
cap/<aa>/<hash>          body object (the local cap/ file, byte-for-byte)
meta/<aa>/<hash>.json    sidecar object (the local meta/ file, byte-for-byte)

hash = sha256hex(captureKey)          (capturePath/metaPath in key.js)
aa   = hash[0:2]
```

No key rewriting on the way up: `capturePath()`/`metaPath()` already return
rootless `/`-joined object keys, so an object key is just the local relative
path. Every corpus key is POSIX-impossible raw (`# ; ? ^ |`, 2000+ bytes,
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
  excluded by construction) and hands the body-object set to
  [`s5cmd`](https://github.com/peak/s5cmd) for parallel copy.
- `meta/` — `rclone copy`, **never `rclone sync`**: `sync` deletes remote
  objects absent from the source, which would let a partial local root reap
  live bucket entries. The cache root is the archive of record, not a mirror
  to converge the bucket toward; deletion is a separate, audited GC concern
  (see the GC-leases dissent).

**Bodiless entries** (`status != "body"` — redirects, errors, empty 200s)
become **zero-byte `cap/` objects** carrying the same `x-amz-meta-status`
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

**A store root contains ONLY `cap/`, `meta/`, and `tmp/`.** Nothing else
belongs inside it. The root is a *rebuildable projection* — the archive of
record that syncs verbatim to R2 / Fastly Object Storage (bucket object keys
ARE the local layout: `cap/<aa>/<hash>`, `meta/<aa>/<hash>.json`) — so any
foreign entry is either uploaded as a junk object or silently dropped by the
sync. **Operational artifacts live OUTSIDE the root**: run reports, audit
checkpoints, driver logs, and any `.runs/`-style scratch belong to an
operational home alongside the store, never within it. The contract is exactly
three names so "what is the deploy artifact?" has one answer — walk the root,
everything you see is `cap/` + `meta/` + `tmp/`.

`fsck` is the verify-on-read command the design debate deferred (see the
Verification dissent below): a store without a verify pass rots silently,
because `contentHash` recorded at write only pays off when something later
re-checks it. Implementation:
[`spv/waybackify/fsck.js`](../../waybackify/fsck.js) (library) +
[`spv/waybackify/bin/fsck.js`](../../waybackify/bin/fsck.js) (thin CLI).

```
node spv/waybackify/bin/fsck.js --root <store> [--fix] [--json] [--quiet]
```

It walks `meta/` (the authority) and `cap/`, deriving paths exactly as
`cache.js` does, and reports — **report-only by default**, non-zero exit on any
discrepancy:

| category | severity | meaning |
|---|---|---|
| `hashMismatch` | corruption | `status: "body"` whose `contentHash` ≠ the SRI of the `cap/` bytes — the one failure `fsync` cannot catch (it persists *what* was written, not *that the right bytes* were). |
| `keyMismatch` | corruption | sidecar filed under a hash ≠ `sha256hex(sidecar.key)` — misfiled or tampered (the `readSidecar` authenticity check). |
| `missingBody` | corruption | `status: "body"` with no `cap/` file — an incomplete entry (the body rename was lost, or a body was deleted under a complete sidecar). |
| `malformed` | corruption | a sidecar that will not parse — disk rot, not absence (the rename published a whole fsync'd file or nothing). |
| `schemaVersion` | advisory | a sidecar whose `v` differs from the current schema — a migration flag. |
| `foreignRoot` | advisory | a root entry outside `cap/` `meta/` `tmp/` — the check that catches a contract violation like a stray `.runs/`. |
| `orphanCap` | reapable | a `cap/` file with no sidecar — ingest garbage from a crash between the body and sidecar renames (never served: no completion token). |
| `staleTmp` | reapable | leftover `tmp/` scratch from an interrupted write. |

`--fix` reaps **only** the two reapable classes — `orphanCap` and `staleTmp` —
neither of which is reachable by any reader (an orphan has no completion token;
a `tmp/` file was never renamed into place). It **never** touches a valid entry
and **refuses** to "fix" corruption: a `hashMismatch` / `keyMismatch` /
`missingBody` / `malformed` finding is evidence to investigate, not garbage to
sweep. It also never deletes a `foreignRoot` entry — that could be precious
operational data; relocating it is the operator's call.

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
└── tmp/                                            (empty after a clean run)
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
 "v":1}
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
 "v":1}
```

## Sources

- Node.js: [`fsPromises.rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath) · [`filehandle.sync`](https://nodejs.org/api/fs.html#filehandlesync) · [`crypto.createHash`](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options) · [`hash.update`](https://nodejs.org/api/crypto.html#hashupdatedata-inputencoding) · [global WebCrypto](https://nodejs.org/api/globals.html#crypto).
- POSIX: [rename(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html) · [fsync(2)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/fsync.html).
- W3C/MDN: [Subresource Integrity §integrity metadata](https://www.w3.org/TR/sri-1/#integrity-metadata-description) · [MDN SRI](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) · [MDN `Object.keys` ordering](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys#description).
- Fastly: [Object Storage](https://docs.fastly.com/products/object-storage) · [Compute resource limits](https://docs.fastly.com/products/compute-resource-limits).
- Cloudflare: [R2 limits (object key ≤ 1,024 bytes)](https://developers.cloudflare.com/r2/reference/limits/).
