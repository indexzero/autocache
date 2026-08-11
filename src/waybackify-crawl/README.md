# waybackify-crawl

The completeness crawler for a wayback mirror. It closes the one
gap the static cache pipeline cannot: assets a **browser** discovers at runtime
— `@font-face`/`url()` inside CSS bodies, `@import` chains, `srcset`,
JS-initiated fetches — which never enter the statically-extracted `requisites[]`,
are never fetched, and under the deployed strict CSP turn a "byte-complete" doc
into a broken render.

Crawl does **not** reinvent the verifier. `remaster verify`'s dynamic tier — a
strict-serving browser render with the archive.org family abort-routed — IS the
probe; crawl drives it to a fixpoint.

## The pipeline

```
fetch (static bulk pass)                 # waybackify cacheCapture; frontier =
  → serve LOCALIZED, report-only         #   requisites ∪ dynamic (closes any
  → probe the dynamic tier               #   already-recorded dynamic children)
  → map leaks → captureKeys              # waybackify-serve serveCacheRoot
  → recordDynamic (BEFORE refetch)       # the dynamic[] sidecar v3 fact class
  → refetch exactly the new keys         # crash-resume via the frontier
repeat until a render makes ZERO unexpected web.archive.org requests
```

- The **probe** (`src/probe.js`) renders each doc through agent-browser against
  a server crawl boots with serve-time `localize` (so a held asset is served
  locally, not re-leaked every iteration — the floor the fixpoint stands on) and
  `cspMode: 'report-only'` (so a blocked cross-origin request is still
  *observable* in the network log; actual egress is stopped by the abort route,
  not the CSP).
- A leaked request is mapped to a durable `dynamic[]` requisite
  (`src/mapkeys.js`): a local `/web/` 404 via the serving parser
  (`parseWaybackPath`), a still-foreign `web.archive.org` ref via the foreign
  parser (`parseWaybackUrl`). Both are **missing assets** (the worklist). A leaked
  child's replay flag — a browser-only fact absent from the URL — is inferred
  from its resource type.
- `recordDynamic` writes the worklist to the sidecar **before** the refetch, so
  a crash resumes straight into the frontier. Convergence is one reference-depth
  per iteration (HTML→CSS→@import→font = depth 3); default cap 4 iterations,
  `--max-iterations` overridable.

## The zero-leak gate

A document is **complete** iff its rendered probe requests nothing off-host that
the allowed-escapes policy does not sanction — the exact thing the deployed
strict CSP enforces. Concretely, verification requires **all** of: no fresh
missing wayback asset to fetch; every child ever recorded for the doc (this run
or a prior one) now has a sidecar (nothing recorded-but-unfetched — a doc is not
complete while its own `dynamic[]` closure is open, even if the browser has since
stopped requesting the child); every residual non-local request is a
policy-matched `allowed-escape`; and no fail-closed residual. Keys with a
terminal `error`/`redirect`/`interstitial` sidecar are excluded from the
worklist forever (the archive lacks them; re-recording would loop).

**Fail-closed residuals** (never silently verified): a render that observed
**zero** requests (navigation/log failure — a real render always issues the
top-level document request) is `probe-error`; a non-`/web/` `archive.org` chrome
URL or an unparseable candidate is an actual/unprovable off-host request and is
ledgered `unexpected-archive-request`. A non-empty leak set that stops adding new
keys — nondeterministic JS, cache-busters, rotating banners — is `flaky`; genuine
work still pending at the depth cap is `unconverged`. All are *visible* residual
classes with their residual URLs, never chased, never mistaken for clean.

## The allowed-escapes policy

`policy/allowed-escapes.json` is committed source: host patterns + reason
strings for the third-party requests (analytics/trackers/CDNs) the strict CSP is
*supposed* to block — policy, not incompleteness. Host matching is suffix-aware
(an entry matches the host and its subdomains). Override per-run with
`--allow-escapes <file>`. A matched request is reported as `allowed-escape`
(visible, non-failing); an **unmatched** non-local request still fails the doc.
Missing wayback captures are NOT escapes — they are the fetch worklist.

## Ledgers (`<root>/.crawl/`)

Run ledgers, appended by crawl only, never committed to git, owner-deletable:

- `verified.jsonl` — one row per converged doc (`{key, at, iterations,
  dynamicCount, ruleVersion, sidecarV}`), read latest-row-wins. A CLAIM about
  {root, rules, browser}, not a sidecar fact. Invalidated by a
  `rewrite.js#RULE_VERSION` bump (a re-remaster changes what a correct render
  looks like), or by a `{verified:false}` tombstone the crawler writes **before**
  a `--force` re-probe of a previously-verified doc — so a re-probe that ends
  flaky/unconverged (or crashes mid-flight) can never leave the stale claim as
  the latest row.
- `flaky.jsonl` — one row per non-converged doc, with residual URLs.
- `har/` — per-doc request logs (`--har`).

Verified docs are skipped entirely on re-run (no probe, no network) unless
`--force`.

## Usage

This package is library-only (the standalone bin was dropped in #441); the
completeness crawl is driven through the waybackify CLI as `cache crawl` (put all
flags FIRST, before the positional URLs):

```sh
waybackify cache crawl --root <cache-root> <wayback-url> [<wayback-url> …]  # to fixpoint
waybackify cache crawl --root <cache-root> --ledger <dir>                   # every HTML doc in <dir>
  --max-iterations N   (default 4)      --force
  --static-only        (loud warning)   --allow-escapes <file>
  --max N              (archive.org request cap)   --delay-ms N   --har
```

`--ledger <dir>` crawls every `status:'body'` HTML document under `<dir>/meta`
(an `interstitial`-status doc is a refusal page, not a servable document, and is
skipped). The verified fast-path is truly free: a batch of already-verified docs
returns without booting a server, opening a browser, or touching the network —
so `--ledger` over a converged corpus is a cheap no-op. A browser is required
**only** when uncached work remains: agent-browser absence then fails **loud**
(hint: `--static-only`), never a silent no-op — incomplete-is-worse-than-useless
applies to the verifier too. `--static-only` skips the probe and only closes an
already-recorded `dynamic[]` frontier; it does NOT verify completeness and warns
so.

## Programmatic

```js
import { crawl } from '@autocache/waybackify-crawl';
await crawl(urls, { root, maxIterations, policy, maxRequests, deps });
```

`deps.{ serve, probe, cacheCapture, recordDynamic, readSidecar, loadCorpus }`
are injectable — the fixpoint unit-tests against a fake probe (findings
fixtures) + an in-memory store, with zero network and zero browser.

## Enforced-CSP spot-check (runbook, owner-run, post-deploy)

The probe renders with `cspMode: 'report-only'` so leaks stay observable. As
cheap insurance that report-only probing predicted enforce-mode behavior, after
a corpus crawl + deploy, spot-check a handful of verified docs against the LIVE
site under the deployed **enforce** CSP (browser devtools → Network/Console: no
blocked requests, no CSP violations). A discrepancy means an asset the probe saw
as local was served cross-origin in production — a serving-parity bug, not a
crawl bug, and the tripwire for it.

## Boundaries

- `spv/` package: depends **down** on `waybackify` (facts) + `waybackify-serve`
  (the shared serving core) only — never on `render/wayback`. Browser tooling
  stays a subprocess behind the probe.
- The probe driver (`src/probe.js`) is exported so T4's re-home of
  `remaster verify --tier dynamic` into this package is import-path churn only.
