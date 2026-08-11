# Publish-readiness — where the two packages stand

The decouple's goal was always open-sourceability: `spv/waybackify` (the
library) and `spv/waybackify-cli` (the CLI) with ZERO knowledge of the repo
around them. This records where that stands as of 2026-07-24 — what is ready,
what is checked, and what remains an operator decision. **Nothing here is a
publish**; it is the pre-flight.

## Names and scope

| package | `name` | version | `private` | bin |
|---|---|---|---|---|
| `spv/waybackify` | `waybackify` | 0.0.0 | `true` | — |
| `spv/waybackify-cli` | `@autocache/waybackify-cli` | 0.0.0 | `true` | `waybackify` |

Registry availability, checked 2026-07-24 with `npm view <name> name`:

- `waybackify` — **404 (unpublished; available)**
- `@autocache/waybackify-cli` — **404 (unpublished)**; a scoped name is
  claimable only by the scope's owner. `@autocache` (no dot) is a valid npm
  scope and is the chosen home for these packages.
- `waybackify-cli` (the plain fallback if the scope is dropped) —
  **404 (unpublished; available)**

The library keeps the plain `waybackify` name. The CLI's **bin** is also
`waybackify` — installing the CLI is what puts a `waybackify` command on PATH,
while the library package of the same name ships no bin, so the two do not
collide.

Both packages are `"private": true` at version `0.0.0`: publishing requires
flipping the flag and choosing a real version — deliberate, operator-run
steps, not something CI should ever do implicitly.

## License

Both packages declare `"license": "MIT"` and now carry a matching `LICENSE`
file (MIT, same copyright holder as the `author` field). The repo's root
`LICENSE` is CC BY-NC-ND 4.0 — that is the **content** license for the site
this repo publishes, and it does not govern these packages; each package's own
MIT file is what travels with a tarball (`npm pack` includes a package-level
`LICENSE` automatically).

## READMEs stand alone

Both READMEs read correctly outside this repo:

- [`spv/waybackify/README.md`](../../waybackify/README.md) — API usage, the
  Manifest / Universe / Ledger model, schema v2. No repo paths.
- [`spv/waybackify-cli/README.md`](../README.md) — the pinned surface-v2
  command table, exit codes, the thin-wrapper rule. References the library as
  `waybackify` (a sibling-relative link that survives extraction), not by this
  repo's `spv/` layout.

The living docs in this directory (CACHE / REMASTER / SERVE / SYNC / GC)
still cross-link `render/wayback` sources for context; they document the
serving system as much as the packages and are expected to be re-homed or
trimmed at extraction time.

## The boundary proof

The decoupling is enforced structurally, not by review: CI's
**Waybackify decouple gate** (`.github/workflows/ci.yml`, job
`waybackify-decouple`) greps everything under `spv/waybackify` and
`spv/waybackify-cli` for the surrounding repo's corpus-tree layout, its
identifier conventions for posts, and its repo paths, and fails the build on
any hit — the boundary cannot erode one helpful comment at a time. (The exact
patterns live in the workflow, not here: this file sits inside the scanned
tree, so spelling them out would trip the gate on itself.) A green gate on
`main` is the standing proof that both packages know nothing about this repo.

## What publishing would still need (operator decisions)

1. Settle the CLI's published name: `@autocache/waybackify-cli` (requires
   the npm scope) or plain `waybackify-cli`.
2. Flip `"private": true` → publishable, pick initial versions.
3. `npm publish --dry-run` both packages and review the tarball file lists
   (no `files` allowlist exists yet — everything not npm-defaulted ships).
