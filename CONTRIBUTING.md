# Contributing to autocache

This guide explains how to contribute code and documentation to autocache.

autocache is a public, Apache-2.0 project. Contributions of any size are welcome.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before you take part.

## Project layout

autocache is a pnpm monorepo. Four packages live under `src/*`.

| package | what it does |
|---|---|
| `@autocache/waybackify` | core library — manifests, link rewriting, the cache store, key derivation |
| `@autocache/waybackify-cli` | the CLI — `manifest`, `rewrite`, `cache`, `remaster`, `bucket` |
| `@autocache/waybackify-crawl` | the crawl engine and remaster-verify |
| `@autocache/waybackify-serve` | the edge server — Node, Cloudflare Workers, and Fastly Compute |

The project requires Node 24 or later and pnpm 10.

## Set up your environment

1. Fork the repository on GitHub.
2. Clone your fork.
3. Run `pnpm install` at the repository root.

```sh
git clone git@github.com:<your-user>/autocache.git
cd autocache
pnpm install
```

## Run the tests

Run every package test from the repository root.

```sh
pnpm -r test
```

Run the typecheck across every package.

```sh
pnpm -r typecheck
```

Run the tests for one package with a filter.

```sh
pnpm --filter @autocache/waybackify test
```

All tests must pass before you open a pull request.

## Branch and pull request flow

1. Create a branch from `main` for your change.
2. Make your change in small, focused commits.
3. Run `pnpm -r test` and `pnpm -r typecheck`.
4. Push your branch to your fork.
5. Open a pull request against `main`.

Keep each pull request focused on one topic. Small pull requests merge faster.

Continuous integration must pass on your pull request. A maintainer reviews the
change after CI is green.

## Commit message convention

autocache follows the Rob Pike and Plan 9 commit style.

Write the title as `area: what changed`. Use a lowercase title. Keep it short.

```text
serve: retry transient broken-body responses in bucket verify
```

Write the body in Simplified Technical English. Use short sentences. Use the
active voice. Explain what the change does and why it matters.

Add a `Co-Authored-By` trailer for any AI-assisted commit.

```text
serve: retry transient broken-body responses in bucket verify

The bucket verify step failed on a truncated response body. The server now
retries the request up to three times before it reports an error.

Co-Authored-By: Ada Lovelace <ada@example.com>
```

## License and sign-off

autocache is licensed under [Apache-2.0](LICENSE).

Your contribution enters the project under the same Apache-2.0 license. Inbound
contributions match the outbound license. This is the common inbound-equals-
outbound stance.

You do not need a separate contributor agreement. When you open a pull request,
you confirm that you wrote the change or have the right to submit it.
