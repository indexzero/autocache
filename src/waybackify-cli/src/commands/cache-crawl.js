// `waybackify cache crawl` handler — home for the completeness crawler that used
// to ship as the standalone `waybackify-crawl` bin (dropped when #441 made the
// crawl package library-only). It drives the `remaster verify` DYNAMIC probe to
// a fixpoint, recording browser-discovered dynamic[] requisites until a render
// makes zero unexpected web.archive.org requests. The retired bin's contract is
// preserved — the same flags, defaults, JSON summary, and exit codes (0 = every
// doc verified / nothing to do, 1 = any flaky/unconverged/errored, 2 = usage).
// The one homing-imposed change: paparam's positional `rest` is greedy, so FLAGS
// MUST PRECEDE the positional URLs; a flag placed after a URL is rejected LOUD,
// never silently swallowed.
//
// The crawl engine drags in hono + a headless browser + the network, so it is
// imported LAZILY (by workspace specifier) inside the runner — merely loading
// the CLI surface, or running any OTHER command, never pays for it. Tests inject
// `deps.crawl` (+ the policy loaders) to exercise the wiring + exit codes fully
// offline, browser-free.

import { EXIT } from '../cli.js';

/**
 * Parse a supplied numeric flag as a non-negative safe integer; `fail` (exit 2)
 * on anything else. `Number('Infinity')` is a real, finite-LOOKING number, so a
 * bare NaN check would let `--max-iterations Infinity` remove the termination
 * bound and spin forever — Number.isSafeInteger rejects it explicitly.
 */
function parseNonNegInt(raw, name, fail) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) fail(`${name} must be a non-negative integer`);
  return n;
}

/**
 * Build the `cache crawl` handler. Dependency-injectable for tests; the bin
 * wires the default (a real, lazy import of the crawl package).
 *
 * @param {Object} [deps]
 * @param {Function} [deps.crawl] - the crawl engine (injected → no library load)
 * @param {Function} [deps.enumerateHtmlDocKeys] - corpus HTML-doc enumerator (injected)
 * @param {Function} [deps.loadPolicy] - allowed-escapes policy loader (injected)
 * @param {Function} [deps.compilePolicy] - in-memory policy compiler (injected)
 * @param {URL} [deps.DEFAULT_POLICY_URL] - the committed default policy file URL (injected)
 * @param {Function} [deps.log] - stdout line sink (the JSON summary)
 * @param {Function} [deps.error] - stderr line sink (progress + warnings)
 * @returns {Function} paparam runner: ({ args, flags, rest }) => Promise<void>
 */
export function cacheCrawlHandler(deps = {}) {
  return async ({ args, flags, rest }) => {
    const { log = console.log, error = console.error } = deps;

    /** A usage error (exit 2) the root bail handler honors via .exitCode. */
    const fail = message => {
      const e = new Error(`waybackify cache crawl: ${message}`);
      e.exitCode = EXIT.USAGE;
      throw e;
    };

    const root = flags.root ?? flags.output;
    // --root is validated in the surface, but guard defensively so a missing
    // value is a usage error, never a crawl over `undefined`.
    if (!root) fail('missing required flag: --root|-r <root>');

    const staticOnly = Boolean(flags.staticOnly);
    if (staticOnly) {
      // LOUD: --static-only closes already-recorded dynamic[] but discovers NO
      // new runtime requisites and does NOT verify completeness — surface it so
      // a green run is never mistaken for a verified one.
      error(
        'waybackify cache crawl: WARNING --static-only — the browser probe is SKIPPED. ' +
          'This closes already-recorded dynamic[] but discovers NO new runtime ' +
          'requisites and does NOT verify completeness.'
      );
    }

    const maxIterations = flags.maxIterations === undefined ? 4 : parseNonNegInt(flags.maxIterations, '--max-iterations', fail);
    const delayMs = flags.delayMs === undefined ? 1500 : parseNonNegInt(flags.delayMs, '--delay-ms', fail);
    // --max OMITTED means unlimited (the Infinity sentinel) — the common case,
    // and NOT a validation error. Only a value the operator actually typed is
    // range-checked (rejecting Infinity/NaN/negative — see parseNonNegInt).
    const maxRequests = flags.max === undefined ? Infinity : parseNonNegInt(flags.max, '--max', fail);
    const browserCmd = flags.browserCmd ?? 'agent-browser';

    // The engine + policy loaders: injected fakes (tests) or the crawl package
    // (lazy — hono + browser + network never load until we crawl for real).
    const engine = deps.crawl ? deps : await import('@charlie.dev/waybackify-crawl');
    const { crawl, enumerateHtmlDocKeys } = engine;
    const policyMod = deps.loadPolicy ? deps : await import('@charlie.dev/waybackify-crawl/policy');
    const { loadPolicy, compilePolicy, DEFAULT_POLICY_URL } = policyMod;

    // paparam's `rest` is greedy: once the first positional URL is consumed,
    // EVERY remaining token — flags included — lands in `rest` (unlike the retired
    // bin's order-independent parseArgs). A real replay URL never starts with '-',
    // so a '-'-prefixed rest token is a flag the operator put AFTER a URL. Reject
    // it LOUD (exit 2) rather than silently crawl the literal string '--force':
    // flags must precede the URLs.
    const misplaced = (rest ?? []).find(token => token.startsWith('-'));
    if (misplaced) {
      fail(`unexpected ${misplaced} after a wayback URL — put all flags BEFORE the URLs`);
    }

    // Assemble the doc set: the positional URL(s) plus every HTML document under
    // the --ledger tree.
    let urls = [args.waybackUrl, ...(rest ?? [])].filter(Boolean);
    if (flags.ledger) {
      const keys = await enumerateHtmlDocKeys(flags.ledger);
      urls = urls.concat(keys);
    }
    if (urls.length === 0) fail('no documents: pass wayback URL(s) or --ledger <dir>');

    // --static-only compiles an EMPTY-escapes policy (no probe, no allowlist);
    // otherwise load the override or the committed default policy file.
    let policy;
    if (staticOnly) {
      policy = compilePolicy({ escapes: [] });
    } else if (flags.allowEscapes) {
      policy = await loadPolicy(flags.allowEscapes);
    } else {
      const { fileURLToPath } = await import('node:url');
      policy = await loadPolicy(fileURLToPath(DEFAULT_POLICY_URL));
    }

    const { requestCount, cap, results } = await crawl(urls, {
      root,
      maxIterations,
      force: Boolean(flags.force),
      staticOnly,
      policy,
      maxRequests,
      delayMs,
      browserCmd,
      har: Boolean(flags.har),
      onProgress: e => {
        if (e.type === 'capture') error(`  capture ${e.key} iter=${e.iter} fetched=${e.fetched}`);
        else if (e.type === 'probe') error(`  ${e.line}`);
        else if (e.type === 'drop') error(`  drop ${e.line}`);
      }
    });

    const tally = {};
    for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
    log(
      JSON.stringify(
        {
          root,
          requestCount,
          cap: cap === Infinity ? null : cap,
          docs: results.length,
          tally,
          results
        },
        null,
        2
      )
    );

    // A doc that is neither freshly verified, verified-from-cache, nor closed by
    // the static-only pass is a domain failure — the crawl did not converge.
    const bad = results.filter(r => r.status !== 'verified' && r.status !== 'verified-cached' && r.status !== 'static');
    if (bad.length > 0) {
      const e = new Error(`waybackify cache crawl: ${bad.length} of ${results.length} document(s) did not verify`);
      e.exitCode = EXIT.DOMAIN;
      throw e;
    }
  };
}
