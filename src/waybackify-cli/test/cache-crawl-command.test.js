// `waybackify cache crawl` handler — thin front-door wiring test. The crawl
// engine (waybackify-crawl) has its own suite; here we prove the handler
// translates the parsed surface into a crawl() call, assembles the doc set from
// positionals + --ledger, maps the run verdict to an exit code, and prints the
// JSON summary — OFFLINE, via an injected fake engine (no crawl load, no browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { cacheCrawlHandler } from '../src/commands/cache-crawl.js';

const WB1 = 'https://web.archive.org/web/20140403040000/http://example.com/a';
const WB2 = 'https://web.archive.org/web/20140403040000/http://example.com/b';

/**
 * Build a cache-crawl handler over a fake crawl engine + policy loaders,
 * capturing the urls/options it receives and the stdout it writes.
 *
 * @param {Object} [opts]
 * @param {Object[]} [opts.results] - the fake crawl()'s per-doc results
 * @param {string[]} [opts.ledgerKeys] - keys the fake enumerateHtmlDocKeys returns
 */
function handlerFor({ results = [], ledgerKeys = [] } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const handler = cacheCrawlHandler({
    crawl: async (urls, options) => {
      calls.push({ urls, options });
      return { requestCount: 7, cap: options.maxRequests, results };
    },
    enumerateHtmlDocKeys: async dir => { calls.push({ ledgerDir: dir }); return ledgerKeys; },
    loadPolicy: async file => ({ kind: 'loaded', file }),
    compilePolicy: doc => ({ kind: 'compiled', doc }),
    DEFAULT_POLICY_URL: new URL('file:///default/policy.json')
  });
  // Route the structured logger's human message (or a bare string) into `err`
  // so the STDERR-seam assertions see the same lines as before. `out` is wired
  // as run()'s STDOUT result sink; both seams belong to run(), not deps.
  const push = (o, m) => err.push(typeof o === 'string' ? o : m);
  const logger = { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
  /** Drive `run()` with the fake handler injected as the cacheCrawl handler. */
  const invoke = argv =>
    run(argv, { handlers: { cacheCrawl: handler }, logger, out: l => out.push(l), error: () => {} });
  return { handler, calls, out, err, invoke };
}

test('missing --root is a usage error (exit 2)', async () => {
  const { invoke } = handlerFor();
  assert.equal(await invoke(['cache', 'crawl', WB1]), EXIT.USAGE);
});

test('no documents (no URL, no --ledger) is a usage error (exit 2)', async () => {
  const { invoke, calls } = handlerFor();
  assert.equal(await invoke(['cache', 'crawl', '-r', '/root']), EXIT.USAGE);
  // crawl() must not run when there is nothing to crawl.
  assert.equal(calls.filter(c => c.urls).length, 0);
});

test('all-verified crawl exits 0 and prints the JSON summary to stdout', async () => {
  const { invoke, calls, out } = handlerFor({
    results: [{ status: 'verified' }, { status: 'verified-cached' }, { status: 'static' }]
  });
  const code = await invoke(['cache', 'crawl', '-r', '/root', WB1]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls[0].urls, [WB1]);
  assert.equal(calls[0].options.root, '/root');
  const summary = JSON.parse(out[0]);
  assert.equal(summary.root, '/root');
  assert.equal(summary.docs, 3);
  assert.deepEqual(summary.tally, { verified: 1, 'verified-cached': 1, static: 1 });
});

test('an unconverged/flaky/errored doc is a domain failure (exit 1)', async () => {
  const { invoke } = handlerFor({ results: [{ status: 'verified' }, { status: 'flaky' }] });
  assert.equal(await invoke(['cache', 'crawl', '-r', '/root', WB1]), EXIT.DOMAIN);
});

test('trailing positionals + --ledger keys are unioned into the doc set', async () => {
  const { invoke, calls } = handlerFor({ results: [{ status: 'verified' }], ledgerKeys: ['k1', 'k2'] });
  await invoke(['cache', 'crawl', '-r', '/root', '--ledger', '/l', WB1, WB2]);
  const crawlCall = calls.find(c => c.urls);
  assert.deepEqual(crawlCall.urls, [WB1, WB2, 'k1', 'k2']);
});

test('flag defaults match the retired bin (max-iterations 4, delay-ms 1500, unlimited --max, agent-browser)', async () => {
  const { invoke, calls } = handlerFor({ results: [{ status: 'verified' }] });
  await invoke(['cache', 'crawl', '-r', '/root', WB1]);
  const { options } = calls.find(c => c.urls);
  assert.equal(options.maxIterations, 4);
  assert.equal(options.delayMs, 1500);
  assert.equal(options.maxRequests, Infinity);
  assert.equal(options.browserCmd, 'agent-browser');
  assert.equal(options.force, false);
  assert.equal(options.staticOnly, false);
});

test('supplied flags thread through, and cap is nulled in the summary when unlimited', async () => {
  const { invoke, calls, out } = handlerFor({ results: [{ status: 'verified' }] });
  await invoke(['cache', 'crawl', '-r', '/root', '--max-iterations', '2', '--delay-ms', '10', '--force', '--browser-cmd', 'ab', WB1]);
  const { options } = calls.find(c => c.urls);
  assert.equal(options.maxIterations, 2);
  assert.equal(options.delayMs, 10);
  assert.equal(options.force, true);
  assert.equal(options.browserCmd, 'ab');
  // maxRequests defaulted to Infinity → summary cap is null (JSON-safe).
  assert.equal(JSON.parse(out[0]).cap, null);
});

test('--static-only warns LOUD and compiles an empty-escapes policy (no browser)', async () => {
  const { invoke, calls, err } = handlerFor({ results: [{ status: 'static' }] });
  const code = await invoke(['cache', 'crawl', '-r', '/root', '--static-only', WB1]);
  assert.equal(code, EXIT.OK);
  assert.ok(err.some(l => /--static-only/.test(l) && /NOT verify completeness/.test(l)), 'loud warning emitted');
  assert.equal(calls.find(c => c.urls).options.staticOnly, true);
  assert.equal(calls.find(c => c.urls).options.policy.kind, 'compiled');
});

test('--dry-run threads through, prints the frontier summary, and exits 0 (never a domain failure)', async () => {
  const { invoke, calls, out } = handlerFor({
    results: [{ key: 'k', status: 'dry-run', frontier: 5, wouldFetch: 3, keys: ['a', 'b', 'c'] }]
  });
  const code = await invoke(['cache', 'crawl', '-r', '/root', '--dry-run', WB1]);
  // A dry-run fetches nothing, so `status: 'dry-run'` must NOT read as an
  // unconverged doc (which would be exit 1) — the handler short-circuits to 0.
  assert.equal(code, EXIT.OK);
  assert.equal(calls.find(c => c.urls).options.dryRun, true);
  assert.deepEqual(JSON.parse(out[0]).tally, { 'dry-run': 1 });
});

test('a flag placed AFTER a positional URL is rejected loud (exit 2), never swallowed', async () => {
  // paparam's rest is greedy: `WB --force` lands `--force` in rest. The handler
  // must reject it (usage) rather than crawl the literal string '--force'.
  const { invoke, calls } = handlerFor({ results: [{ status: 'verified' }] });
  assert.equal(await invoke(['cache', 'crawl', '-r', '/root', WB1, '--force']), EXIT.USAGE);
  assert.equal(calls.filter(c => c.urls).length, 0, 'crawl() must not run on a misplaced-flag error');
});

test('a supplied Infinity/NaN/negative --max is rejected as a usage error (exit 2)', async () => {
  for (const bad of ['Infinity', 'NaN', '-1', '1.5']) {
    const { invoke } = handlerFor({ results: [{ status: 'verified' }] });
    assert.equal(
      await invoke(['cache', 'crawl', '-r', '/root', '--max', bad, WB1]),
      EXIT.USAGE,
      `--max ${bad}`
    );
  }
});
