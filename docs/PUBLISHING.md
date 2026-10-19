# Publish-readiness — where the two packages stand

The goal was always open-sourceability: `src/waybackify` (the library) and
`src/waybackify-cli` (the CLI) with zero knowledge of any site that embeds
them. This records where that stands as of 2026-07-24 — what is
ready, what is checked, and what remains an operator decision. **Nothing here
is a publish**. It is the pre-flight.

## Names and scope

| package | `name` | version | `private` | bin |
|---|---|---|---|---|
| `src/waybackify` | `@autocache/waybackify` | 0.0.0 | unset | — |
| `src/waybackify-cli` | `@autocache/waybackify-cli` | 0.0.0 | unset | `waybackify` |

Registry availability, checked 2026-07-24 with `npm view <name> name`:

- `@autocache/waybackify-cli` — **404 (unpublished)**. A scoped name is
  claimable only by the scope's owner, and `@autocache` (no dot) is a valid
  npm scope.
- `@autocache/waybackify` was not checked on that date. The library was
  then named plain `waybackify`, which was unpublished and available.

Both packages sit under the `@autocache` scope. The CLI's **bin** is
`waybackify` — installing the CLI is what puts a `waybackify` command on PATH,
while the library package ships no bin, so the two do not collide.

Neither package sets `"private"`, and both sit at version `0.0.0`. The
`Publish` workflow (`.github/workflows/publish.yml`) runs `pnpm -r publish`
when a GitHub release is published. Choosing a real version and cutting that
release stay deliberate, operator-run steps.

## License

Both packages declare `"license": "Apache-2.0"`, and the repo's root `LICENSE`
is Apache License 2.0, so the package fields and the repository agree. Neither
package carries its own `LICENSE` file yet. `npm pack` includes only a
package-level `LICENSE`, so a tarball ships no license text until each package
gets one. That is an operator item below.

## READMEs stand alone

Both READMEs read correctly outside this repo:

- [`src/waybackify/README.md`](../src/waybackify/README.md) — API usage, the
  Manifest / Universe / Ledger model, schema v2. No repo paths.
- [`src/waybackify-cli/README.md`](../src/waybackify-cli/README.md) — the pinned surface-v2
  command table, exit codes, the thin-wrapper rule. References the library as
  `waybackify` (a sibling-relative link), not by a path.

The living docs in this directory (CACHE / REMASTER / SERVE / SYNC / GC)
cross-link `src/waybackify-serve` sources for context. They document the
serving system as much as the packages.

## The boundary proof

The rule is simple: nothing under `src/waybackify` or `src/waybackify-cli`
names a site layout, a site's identifier conventions, or a site's paths. No
CI job greps for the boundary in this repository. Review enforces it, so every
change to either package carries that check.

## What publishing would still need (operator decisions)

1. Claim the `@autocache` scope on the registry, and check
   `@autocache/waybackify` the same way.
2. Pick initial versions and cut the GitHub release that triggers `Publish`.
3. Add a package-level `LICENSE` file to each package so the tarball carries
   the license text.
4. `npm publish --dry-run` both packages and review the tarball file lists
   (no `files` allowlist exists yet — everything not npm-defaulted ships).
