# The remaster build — hermetic in, remastered out

Living documentation for `remaster <hermetic-root> <remastered-root>`
(bin: [`spv/waybackify/bin/remaster.js`](../../waybackify/bin/remaster.js);
engine: [`spv/waybackify/rewrite.js`](../../waybackify/rewrite.js);
build: [`spv/waybackify/remaster.js`](../../waybackify/remaster.js)).

This is the heart of **standalone**. The #292 milestone proved the buckets
faithfully mirror the corpus; a browser sweep then proved the mirror is a
facade — zero pages were self-contained, ~90% of page requisites were quietly
served by live `web.archive.org`, and some captures are stored wayback error
pages. Remaster closes that gap by producing a tier that stands alone.

## The two tiers

- **Hermetic** — the sealed originals, exactly as archive.org's replay
  returned them. Never rewritten. Written by `waybackify cache` (see
  [CACHE.md](./CACHE.md)); it is the truth the record is re-derivable from.
- **Remastered** — the same [layout](./CACHE.md#layout) with text-bearing
  bodies rewritten for standalone serving: chrome stripped, wayback references
  localized. An [FsStore](./SERVE.md) serves it byte-for-byte with no
  serve-time transform required.

Storage is cheap; serve-time compute is the expensive, latency-adding,
forever-verified path. So the rewrite is a **build**, not a per-request
transform. The rules stay pure functions, so the same rules can also run
per-request in a `serve.js --root` dev mode (iterating on a rule never needs a
rebuild) — but production serves pre-rewritten bytes.

Rewriting the *hermetic* bytes is rejected on purpose: the record stays
sealed, and rules will evolve and must be able to re-derive from truth. One
bucket per env holds both tiers — the hermetic tier under an `orig/` prefix,
the remastered tier owning the naked `cap/`/`meta/` paths.

## What the engine rewrites

Keyed by the capture's sidecar content type. Everything not HTML/CSS/JS
(images, fonts, `application/octet-stream`, empty) is copied byte-identical.

| Type | Rewritten references |
|------|----------------------|
| HTML | wayback refs in URL attributes (`href`, `src`, `srcset`, `action`, `poster`, `data-*`) and in `style` attrs; inline `<style>` (as CSS) and inline `<script>` (as JS). Plus the **toolbar strip**. |
| CSS  | wayback refs in `url()`, `@import`, and `@font-face { src }`. |
| JS   | **exact** `https://web.archive.org/web/…` string literals only — nothing clever (no concatenation, no host-relative). |

Mechanism classes (from the sweep):

- **B1** — absolute `https://web.archive.org/web/…` refs in attributes, CSS
  `url()`, and JS literals. Rewritten: the host is stripped, leaving the
  root-relative form.
- **B2** — host-relative `/web/…` refs. Already the target form; recognized
  and preserved (the rewrite is a no-op, and serving the document from our
  own host is what makes them resolve).

Every rewrite targets the **root-relative `/web/<ts><flag>/<orig>` form** —
the one shape that resolves against any host, because the serving path parser
([`render/wayback/src/path.ts`](../../../render/wayback/src/path.ts)) accepts
the optional `/web` prefix as a first-class capture request. A reference is
rewritten **only when its capture exists in the corpus**; anything
unsatisfiable is left byte-for-byte **foreign**, so a strict serve or rmfsck
can surface it.

The **corpus map** is `captureKey → true`, keyed exactly as the sidecar stores
it (`${timestamp}/${originalUrl}`). A reference's candidate key is derived the
*same way the serving parser derives it* (scheme repair mirrors
`path.ts#repairUrl`), so "in the corpus" means "the server can actually serve
it" — the tightest possible coupling between what we rewrite to and what
resolves.

The **toolbar strip** is a faithful port of the serve-time transform
([`render/wayback/src/html.ts#stripWaybackChrome`](../../../render/wayback/src/html.ts)):
the comment-delimited toolbar block, the `_static` script/CSS includes, the
`__wm` / analytics / Ruffle bootstrap, and the injector's marker comment. The
one intentional difference: **no attribution banner is injected**. Capture
bytes carry nothing of ours — attribution is the serving chrome's job.

Bytes are processed as **latin1** (a lossless byte↔char mapping), so a
capture's non-UTF-8 bytes round-trip untouched while the ASCII-only wayback
references are rewritten.

## Carry-over rules

- **Bodied text entry, rewritten** — new bytes at `cap/<aa>/<hash>` (the
  filename is unchanged: it is content-addressed by capture *key*, not body
  bytes); the sidecar's `contentHash` + `contentLength` are updated to
  describe the new bytes.
- **Bodied entry, unchanged** (binary, or text with no satisfiable ref) —
  bytes and sidecar copied byte-identical.
- **Bodiless entry** (`empty` / `redirect` / `error`, and any future status
  such as an interstitial) — sidecar carried through unchanged; there is no
  body to rewrite.
- **Orphan `cap/` body** (no sidecar) — dropped. The authority is `meta/`; an
  orphan is ingest garbage that is never served.

## The build manifest

Written at `<remastered-root>/remaster.manifest.json` — **outside** `cap/` and
`meta/`. An FsStore only ever reads `cap/<aa>/<hash>` and
`meta/<aa>/<hash>.json`, so a root-level file is invisible to serving and never
collides with the capture namespace. It is a build artifact:

```json
{
  "engineVersion": 1,
  "entries": [
    { "contentType": "text/html", "inputHash": "sha256-…", "key": "…",
      "outputHash": "sha256-…", "rewritten": true, "status": "body" }
  ],
  "ruleVersion": 1,
  "v": 1
}
```

Entries are sorted by key; body hashes are `null` for bodiless entries; no
absolute paths ever enter the manifest (the tree is portable). `ruleVersion`
tracks the reference-rewriting behavior; `engineVersion` tracks the build's
output contract. rmfsck reads this manifest to prove a remastered tree is a
current, faithful derivation of its hermetic source.

## Determinism

A hard requirement: the same hermetic tree yields a **byte-identical**
remastered tree *and* manifest. Every step is a pure function of the input
bytes plus the corpus — sidecars re-emit through canonical JSON, bodies through
the deterministic rewrite engine, the manifest sorts its entries. Proven in
`test/remaster.test.js` by running twice and comparing tree hashes.

## Not done here (recorded, not oversights)

- **B6** — bare original-site root-relative paths (`/logo.png`) that 404.
  Localizing those needs the containing document's own capture base URL and
  risks re-pointing genuinely-relative app routes; it is a separate,
  base-aware pass.
- **Serve-time `--root` dev mode** wiring reuses this same engine and lands
  with the serving issue.
- **Re-tiering / bucket layout** (the `orig/` prefix) is the driver issue's
  work.

## Sources

- Engine: [`spv/waybackify/rewrite.js`](../../waybackify/rewrite.js),
  strip port: [`spv/waybackify/strip.js`](../../waybackify/strip.js)
- Build: [`spv/waybackify/remaster.js`](../../waybackify/remaster.js),
  bin: [`spv/waybackify/bin/remaster.js`](../../waybackify/bin/remaster.js)
- Serving contract: [SERVE.md](./SERVE.md) · store: [CACHE.md](./CACHE.md)
