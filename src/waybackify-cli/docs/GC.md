# Garbage collection — the bucket-projection sweep (design)

**Design only. No implementation exists, and none ships from this document.**
This is the mark-and-sweep the hybrid bucket layout was built to enable, plus
the hard precondition that gates any sweep. It is a sibling to
[CACHE.md](./CACHE.md) (the on-disk store) and [SERVE.md](./SERVE.md) (the
consumer contract); a cross-reference from those files lands with the
docs-home / sync work ([#284](https://github.com/indexzero/charlie.dev/issues/284),
[#291](https://github.com/indexzero/charlie.dev/issues/291)), not here.

## Contents

- [Why GC exists](#why-gc-exists)
- [Mark and sweep](#mark-and-sweep)
- [The hard precondition: lease/refcount discipline](#the-hard-precondition-leaserefcount-discipline)
- [Orphan taxonomy](#orphan-taxonomy)
- [Failure modes](#failure-modes)
- [Follow-up implementation issue (stub)](#follow-up-implementation-issue-stub)
- [Sources](#sources)

## Why GC exists

The local cache-root is the **archive of record**; every bucket (Cloudflare
R2, Fastly Object Storage) is a **rebuildable projection** of it — the settled
bucket-sync architecture. GC never touches the root. GC prunes projections.

Without reachability data, a bucket grows unbounded. The population runbook is
**copy-only by design** (`s5cmd cp` for `cap/`, `rclone copy` — never `sync` —
for `meta/`; [#291](https://github.com/indexzero/charlie.dev/issues/291)):
remote deletion is exclusively GC's job, so a copy-only sync can only ever add
objects. Re-pointed captures, de-waybacked posts, and extraction-rule churn
each strand `cap/`+`meta/` object pairs that no reader will ever request and
that no copy pass will ever remove. Something has to reclaim them, and it has
to be the one tool allowed to delete remotely.

The hybrid layout makes that tool possible. `cap/` objects carry native
metadata for single-GET serving; `meta/` sidecars are uploaded **verbatim as
objects** — deliberate redundancy, whose GC payoff is precisely this: the
`requisites[]` DAG (the reachability graph, [CACHE.md §The requisite DAG](./CACHE.md#the-requisite-dag))
is durable **in the bucket**. Reachability is answerable against the bucket
alone, without the root mounted. Ship `meta/` as data, and GC has its edges.

## Mark and sweep

Standard tri-color reachability over the capture DAG.

- **Roots — the corpus ledger, enumerated from git.** The inline
  `web.archive.org/web/…` references in the content tree's published sources
  plus the `wayback.json` manifest entries — all committed — are the set of
  captures the site actually points at
  ([`ledger.js`](../../waybackify/ledger.js) discovery ∪ the project's own
  inline enumeration; [#255](https://github.com/indexzero/charlie.dev/issues/255) /
  [#385](https://github.com/indexzero/charlie.dev/issues/385)). Each root
  reference is a `(timestamp, originalUrl)` pair → a `captureKey` →
  `hash = sha256hex(captureKey)`
  ([`key.js`](../../waybackify/key.js)). The root set is a set of hashes.
- **Edges — sidecar `requisites[]`.** For a marked hash, read
  `meta/<aa>/<hash>.json`; each entry of its `requisites[]` is a child's
  **verbatim captureKey**; hash it to get the child's object pair. This is the
  authoritative DAG — the same edge list `commitEntry` writes and resume reads.
- **Mark.** From each root hash, transitively add every `requisites[]` child.
  Fixpoint = the reachable hash set. The corpus DAG is shallow in practice
  (document → its requisites, which carry `requisites: []`), but the walk is
  general and must be, since requisites are **shared** across documents by
  `(timestamp, url)`.
- **Sweep.** Any hash NOT in the reachable set is garbage. Delete its
  `cap/`+`meta/` **PAIR** — never one half without the other. A lone `meta/`
  is still a DAG node other sidecars may reach through a shared requisite; a
  lone `cap/` is an unservable orphan
  ([SERVE.md §The orphan-body rule](./SERVE.md#the-orphan-body-rule)). The two
  layers move together, the same "treated as ONE operation" rule the
  population runbook applies to cap↔meta
  ([#291](https://github.com/indexzero/charlie.dev/issues/291)).
- **Bodiless entries** (`status != "body"`: redirect/error/empty) own no `cap/`
  object — the sidecar is the entire entry. They are marked and swept by
  `meta/` alone.

Reachability is computed by scanning `meta/`, never from a stored index —
consistent with the store's "no authoritative index anywhere" stance
([CACHE.md §Layout](./CACHE.md#layout)). The refcount is *derived*: a hash's
in-degree is the count of reachable sidecars whose `requisites[]` names it,
plus root membership. It reaches zero only when no root and no sidecar points
at it. No counter is stored.

## The hard precondition: lease/refcount discipline

**No sweep ships until lease/refcount discipline exists. This is a blocking
precondition, stated as such — not a nice-to-have.**

The store has **no locks** (concurrency is last-writer-wins on identical bytes,
[CACHE.md §Write / atomicity protocol](./CACHE.md#write--atomicity-protocol)),
population can run **concurrently** with anything, and a naive mark-and-sweep
will race a writer and delete a live requisite — the store's own recorded
GC-safety dissent, verbatim: *"GC without leases will race a concurrent writer
and delete a live requisite."* Compounding this: GC introduces the **first and
only** remote delete in the whole system. Every other path is copy-only by
construction. The destructive verb must be gated before it exists.

What a lease looks like (a sketch — enough to be safe, not over-designed):

- **Sweep manifest, computed then reviewed then executed.** Mark and sweep are
  two phases with a gate between. The mark phase writes the candidate-delete
  list — hash, both object keys, and the orphan reason — as a reviewable
  artifact. Execution consumes a reviewed manifest; it never re-derives its own
  targets inline.
- **Generation counter.** A monotone marker binds a manifest to the state it
  was computed against — e.g. the git commit of the corpus ledger the mark ran
  over, plus a bucket generation/epoch. A sweep is valid only for its
  generation; any population landing between mark and sweep bumps the
  generation and **invalidates the manifest** — recompute, re-review.
- **Grace window.** Never delete an object younger than a grace period.
  Recently-populated objects are presumed possibly-referenced by an in-flight
  ledger change not yet marked. Objects are immutable and re-population is
  overwrite-safe, so a conservative grace costs nothing.

The manifest is the lease; the generation is what makes the lease
non-forgeable; the grace window is slack for the races the generation can't
see. Refcounting itself needs no new storage — reachability *is* the refcount.

## Orphan taxonomy

The mark decides reachability. The taxonomy exists to name the cases and — more
importantly — to fence the one that **looks** like an orphan but is reachable.

- **Re-pointed capture (true orphan).** A post's `wayback.json` entry (or inline
  ref) is updated to a different timestamp. The old timestamp's document hash
  and any requisite subtree unique to it lose all roots → unreachable → swept.
  Only the *unshared* subtree goes: a requisite still named by any reachable
  sidecar stays marked. The walk handles this with no special case.
- **De-waybacked post (true orphan).** A `wayback.json` entry removed or set
  null, or an inline ref deleted from prose. The root disappears; its unshared
  subtree becomes unreachable. Same shared-requisite caveat.
- **Extraction-rule evolution (FALSE orphan — reachable, NOT swept).** The
  requisite extractor ([`requisites.js`](../../waybackify/requisites.js):
  `im_`/`cs_`/`js_`/`oe_`) changes such that today's rules would no longer
  extract some ref that an **old** document sidecar still lists in
  `requisites[]`. That requisite is **still reachable**, because reachability is
  defined by the **recorded edge list**, not by re-deriving edges from stored
  bodies under current rules. **Re-derivation from bodies is not ground truth:**
  the sidecar's `requisites[]` was written atomically with the document from the
  bytes in hand and is the authoritative DAG; re-running extraction is a *newer,
  different* function that says nothing about what the still-served historical
  capture actually needs. GC that re-derived would (a) delete assets a live
  capture still references and (b) couple GC correctness to extractor version
  drift. **Rule: GC reads edges; it never recomputes them.** Pruning stale
  edges from a sidecar is a deliberate sidecar rewrite (a re-population / `fsck`
  concern), never a GC inference.

## Failure modes

- **Partial sweep (crash mid-delete).** The bucket is left missing some dead
  objects, possibly with a pair half-deleted. Every delete target was already
  unreachable garbage, so no reader regresses; re-running the sweep finishes
  the job, and a half-deleted pair's survivor is still garbage on the next
  pass. The root is untouched — anything deleted in error is restored by
  re-running the copy-only population runbook.
- **Concurrent population during sweep.** The defense is the generation gate: a
  population between mark and sweep invalidates the manifest. Without the gate,
  a writer could publish a newly-reachable object whose hash the stale mark set
  lacks, and the sweep would delete a live object. This is the exact race the
  blocking precondition exists to prevent — which is why no sweep ships without
  it.
- **meta/cap divergence.** A sweep that deletes one layer but not the other
  yields a lone `cap/` (unservable) or a lone `meta/` (a DAG node with no body).
  The pairing rule plus treating both deletes as one operation prevents it;
  divergence that does occur is repaired by the next sweep or by re-copy from
  the root.
- **Blast radius is bounded by the archive of record.** Every bucket object is
  reproducible from the local cache-root. The worst case for *any* GC bug —
  over-deletion, divergence, partial sweep — is: re-run the population runbook
  (copy-only, ~pennies at this corpus size,
  [#291](https://github.com/indexzero/charlie.dev/issues/291) /
  [#292](https://github.com/indexzero/charlie.dev/issues/292)). GC can never
  destroy the only copy, because it never runs against the root. It deletes
  remote projections only.

## Follow-up implementation issue (stub)

*Design note, not filed. The acceptance criteria an implementation issue would
carry:*

- Lease primitives — sweep manifest, generation counter, grace window —
  implemented and unit-tested **before any delete path exists**.
- `--plan` / emit-sweep-manifest: mark phase only. Writes a reviewable
  candidate-delete manifest (hash, both object keys, orphan reason:
  re-pointed / de-waybacked), deterministic order, **no deletes**.
- `--sweep <manifest>`: executes a reviewed manifest; **refuses** if the
  corpus-ledger generation or the bucket generation has moved since the
  manifest was computed; honors the min-age grace window; deletes `cap/`+`meta/`
  as an atomic pair per hash.
- Roots from ledger discovery ([`ledger.js`](../../waybackify/ledger.js))
  joined with the project's inline-reference enumeration
  ([#255](https://github.com/indexzero/charlie.dev/issues/255) /
  [#385](https://github.com/indexzero/charlie.dev/issues/385)).
- Reachability defined **solely** by roots + sidecar `requisites[]`. A test
  pins that an extraction-rule change does **not** orphan a still-referenced
  requisite (the false-orphan fence).
- Idempotent re-runs; a partial sweep is resumable.
- Post-sweep verification: a fresh mark reports zero reachable objects missing
  (no live object was deleted) — pairs with the parity gate
  ([#292](https://github.com/indexzero/charlie.dev/issues/292)).
- No code path deletes the local root. GC targets a bucket only.

## Sources

- Store: [CACHE.md](./CACHE.md) (layout, sidecar schema, requisite DAG, the
  GC-safety dissent) · [SERVE.md](./SERVE.md) (orphans, copy-only sync loops).
- Code: [`cache.js`](../../waybackify/cache.js) (`commitEntry`, `requisites[]`)
  · [`key.js`](../../waybackify/key.js) (`captureKey` → `hash`) ·
  [`ledger.js`](../../waybackify/ledger.js) (corpus ledger roots) ·
  [`requisites.js`](../../waybackify/requisites.js) (extraction rules).
- Bucket-sync milestone: shared layout contract
  [#284](https://github.com/indexzero/charlie.dev/issues/284) · sync emitter +
  copy-only runbook [#291](https://github.com/indexzero/charlie.dev/issues/291)
  · population + parity gate
  [#292](https://github.com/indexzero/charlie.dev/issues/292) · this spec
  [#293](https://github.com/indexzero/charlie.dev/issues/293).
