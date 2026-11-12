// The whole-site surface — `site enumerate`, `site export`, and the `cache`
// verbs a mirror leans on (`fill --converge`, `remediate`, `status`), plus
// the two flat verbs that grew a capture-level face (`search --match`,
// `ledger --captures`). Offline, zero network.
//
// The engines are tested where they live (src/waybackify/test,
// src/waybackify-site/test). This file pins the thin-wrapper contract: argv →
// library options, the stdout result, the exit code — and one pass through
// the REAL bin over the site package's fixture CDX pages, to prove the
// commands compose.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, run } from '../src/cli.js';
import { cacheFillHandler } from '../src/commands/cache-fill.js';
import { cacheRemediateHandler } from '../src/commands/cache-remediate.js';
import { cacheStatusHandler } from '../src/commands/cache-status.js';
import { ledgerHandler } from '../src/commands/ledger.js';
import { searchHandler } from '../src/commands/search.js';
import { siteEnumerateHandler } from '../src/commands/site-enumerate.js';
import { siteExportHandler } from '../src/commands/site-export.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', 'bin', 'waybackify.js');
const SITE_CDX = path.resolve(HERE, '..', '..', 'waybackify-site', 'test', 'fixtures', 'cdx');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-site-cli-'));

/** Run argv through run() with one injected handler; capture both streams. */
async function drive(argv, handlers) {
  const stdout = [];
  const stderr = [];
  const push = (o, m) => stderr.push(typeof o === 'string' ? o : m);
  const logger = { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
  const code = await run(argv, { handlers, logger, out: l => stdout.push(l), error: l => stderr.push(l) });
  return { code, stdout, stderr };
}

/** Run the real bin. */
function cli(...argv) {
  const r = spawnSync(process.execPath, [BIN, ...argv], { encoding: 'utf8' });
  assert.equal(r.error, undefined);
  return r;
}

// ---------------------------------------------------------------------------
// site enumerate
// ---------------------------------------------------------------------------

test('site enumerate: reads the config, maps argv → enumerate() options, prints one summary line', async () => {
  const calls = [];
  const handler = siteEnumerateHandler({
    readSiteConfig: file => ({ from: file }),
    enumerate: async (config, opts) => {
      calls.push({ config, opts });
      opts.onProgress({ type: 'site', site: 'a', okUrls: 3, versions: 4, maxVersionsPerUrl: 2 });
      return { ledger: '/l', sites: { a: { versions: 4 } } };
    }
  });
  const { code, stdout, stderr } = await drive(
    ['site', 'enumerate', 'sites.json', '--ledger', '/l', '--site', 'a', '--site', 'b', '--offline', '--no-redirects', '--repick-from', '/root'],
    { siteEnumerate: handler }
  );
  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls[0].config, { from: 'sites.json' });
  const { opts } = calls[0];
  assert.equal(opts.ledger, '/l');
  assert.deepEqual(opts.sites, ['a', 'b']);
  assert.equal(opts.offline, true);
  assert.equal(opts.redirects, false);
  assert.equal(opts.repickFrom, '/root');
  assert.deepEqual(stdout.map(l => JSON.parse(l)), [{ ledger: '/l', sites: { a: { versions: 4 } } }]);
  assert.deepEqual(stderr, ['a: 3 URLs · 4 versions (max 2 of one URL)']);
});

test('site enumerate: defaults — every site, online, redirects resolved', async () => {
  const calls = [];
  const handler = siteEnumerateHandler({ readSiteConfig: () => ({}), enumerate: async (c, opts) => { calls.push(opts); return {}; } });
  assert.equal((await drive(['site', 'enumerate', 's.json', '--ledger', 'l'], { siteEnumerate: handler })).code, EXIT.OK);
  assert.equal(calls[0].sites, undefined);
  assert.equal(calls[0].offline, false);
  assert.equal(calls[0].redirects, true);
  assert.equal(calls[0].repickFrom, undefined);
});

test('site enumerate: an index that stays offline is a domain failure (exit 1), not an empty ledger', async () => {
  const handler = siteEnumerateHandler({
    readSiteConfig: () => ({}),
    enumerate: async () => { throw new Error('HTTP 200 (HTML body — the index is offline) after 10 attempts: …'); }
  });
  const { code, stdout, stderr } = await drive(['site', 'enumerate', 's.json', '--ledger', 'l'], { siteEnumerate: handler });
  assert.equal(code, EXIT.DOMAIN);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join('\n'), /the index is offline/);
});

// ---------------------------------------------------------------------------
// site export
// ---------------------------------------------------------------------------

test('site export: maps argv → exportTree(root, out, { ledger, dryRun }) and prints its summary', async () => {
  const calls = [];
  const handler = siteExportHandler({ exportTree: (...a) => { calls.push(a); return { exported: 7, collisions: 1 }; } });
  const { code, stdout } = await drive(['site', 'export', 'ledger', '-r', '/root', '--out', '/tree', '--dry-run'], { siteExport: handler });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls, [['/root', '/tree', { ledger: 'ledger', dryRun: true }]]);
  assert.deepEqual(JSON.parse(stdout[0]), { exported: 7, collisions: 1 });
});

// ---------------------------------------------------------------------------
// cache remediate
// ---------------------------------------------------------------------------

const remediated = (tally, throttled = false) => async (root, opts) => {
  for (const [outcome, n] of Object.entries(tally)) for (let i = 0; i < n; i++) opts.onEntry({ key: `k${i}`, outcome });
  return { interstitials: Object.values(tally).reduce((a, b) => a + b, 0), tally, throttled, dryRun: Boolean(opts.dryRun) };
};

test('cache remediate: one JSONL row per interstitial on stdout, a tally on stderr, exit 0 when nothing deferred', async () => {
  const seen = [];
  const handler = cacheRemediateHandler({
    remediate: async (root, opts) => { seen.push({ root, opts }); return remediated({ fixed: 2, repick: 1 })(root, opts); }
  });
  const { code, stdout, stderr } = await drive(['cache', 'remediate', '-r', '/root', '--delay-ms', '250', '--max', '9', '--throttle-after', '4'], { cacheRemediate: handler });
  assert.equal(code, EXIT.OK);
  assert.equal(seen[0].root, '/root');
  assert.equal(seen[0].opts.delayMs, 250);
  assert.equal(seen[0].opts.max, 9);
  assert.equal(seen[0].opts.throttleAfter, 4);
  assert.equal(seen[0].opts.dryRun, false);
  assert.deepEqual(stdout.map(l => JSON.parse(l).outcome), ['fixed', 'fixed', 'repick']);
  assert.deepEqual(stderr, ['3 interstitial sidecar(s): 2 fixed · 1 repick']);
});

test('cache remediate: defaults, and a deferral or a throttle stop is exit 1 (re-run has work left)', async () => {
  const seen = [];
  const dflt = cacheRemediateHandler({ remediate: async (root, opts) => { seen.push(opts); return remediated({})(root, opts); } });
  assert.equal((await drive(['cache', 'remediate', '-r', '/root'], { cacheRemediate: dflt })).code, EXIT.OK);
  assert.deepEqual([seen[0].delayMs, seen[0].throttleAfter, seen[0].max], [3000, 6, Infinity]);

  const deferred = await drive(['cache', 'remediate', '-r', '/root'], { cacheRemediate: cacheRemediateHandler({ remediate: remediated({ fixed: 1, deferred: 2 }) }) });
  assert.equal(deferred.code, EXIT.DOMAIN);
  assert.match(deferred.stderr.at(-1), /2 refetch\(es\) deferred — re-run to resume/);

  const throttled = await drive(['cache', 'remediate', '-r', '/root'], { cacheRemediate: cacheRemediateHandler({ remediate: remediated({ deferred: 6 }, true) }) });
  assert.equal(throttled.code, EXIT.DOMAIN);
  assert.match(throttled.stderr.at(-1), /archive\.org is throttling/);
});

// ---------------------------------------------------------------------------
// cache status
// ---------------------------------------------------------------------------

const REPORT = {
  root: '/root', ledger: 'ledger', captures: 10,
  states: { cached: 6, unfetched: 2, interstitial: 1, error: 1 },
  groups: { 'a.org': { cached: 6, unfetched: 0, interstitial: 1, error: 0 }, 'b.org': { cached: 0, unfetched: 2, interstitial: 0, error: 1 } },
  unfetched: { gone: 1, pending: 1 },
  attention: [
    { state: 'interstitial', key: '2002/http://a.org/x.gif', signature: 'wrapper-stub', remedy: 'remediate' },
    { state: 'error', key: '2003/http://b.org/y', remedy: 'repick' }
  ],
  store: { sidecars: 30, documents: 8, requisites: 22, bytes: 2048 },
  complete: false
};

test('cache status: a readable report; exit 1 while anything is pending or needs attention', async () => {
  const calls = [];
  const handler = cacheStatusHandler({ status: async (...a) => { calls.push(a); return REPORT; } });
  const { code, stdout, stderr } = await drive(['cache', 'status', 'ledger', '-r', '/root'], { cacheStatus: handler });
  assert.equal(code, EXIT.DOMAIN);
  assert.deepEqual(calls, [['ledger', '/root']]);
  assert.deepEqual(stdout, [
    '/root ← ledger',
    '        6 cached · 2 unfetched · 1 interstitial · 1 error  (10 captures)',
    '  a.org       6 cached · 0 unfetched · 1 interstitial · 0 error',
    '  b.org       0 cached · 2 unfetched · 0 interstitial · 1 error',
    '  unfetched: 1 pending · 1 gone',
    '  needs attention (no further fill pass will fix these):',
    '    remediate interstitial (wrapper-stub)  2002/http://a.org/x.gif',
    '    repick    error  2003/http://b.org/y',
    '  1 remediate → waybackify cache remediate --root <root> · 1 repick → choose another capture',
    '  store: 30 sidecars (8 ledger captures + 22 requisites) · 2.0KB in cap/'
  ]);
  assert.match(stderr.at(-1), /1 capture\(s\) pending, 2 need attention/);
});

test('cache status: --json is the raw record; a complete root exits 0; a long attention list is elided', async () => {
  const complete = { ...REPORT, unfetched: { gone: 1, pending: 0 }, attention: [], complete: true };
  const ok = await drive(['cache', 'status', 'ledger', '-r', '/root', '--json'], { cacheStatus: cacheStatusHandler({ status: async () => complete }) });
  assert.equal(ok.code, EXIT.OK);
  assert.deepEqual(JSON.parse(ok.stdout[0]), complete);

  const many = { ...REPORT, attention: Array.from({ length: 25 }, (_, i) => ({ state: 'error', key: `k${i}`, remedy: 'repick' })) };
  const long = await drive(['cache', 'status', 'ledger', '-r', '/root'], { cacheStatus: cacheStatusHandler({ status: async () => many }) });
  assert.equal(long.stdout.filter(l => l.startsWith('    repick')).length, 20);
  assert.ok(long.stdout.includes('    … 5 more (--json lists every one)'));
});

// ---------------------------------------------------------------------------
// cache fill — the new knobs and --converge
// ---------------------------------------------------------------------------

const PASS = {
  worklist: { built: false, reason: null, count: 5, path: '/c/.refetch/worklist.jsonl' },
  pending: 5, gone: 0, dryRun: false, aborted: false, reason: null,
  stats: { attempted: 1, fetched: 1, cached: 4, deferred: 0, gone: 0 }
};

test('cache fill: throttle / request-pacing / requisite knobs reach backfill()', async () => {
  const calls = [];
  const handler = cacheFillHandler({ backfill: async opts => { calls.push(opts); return PASS; } });
  const { code } = await drive(['cache', 'fill', 'l', '-r', '/c', '--throttle-after', '3', '--request-delay-ms', '400', '--no-requisites'], { cacheFill: handler });
  assert.equal(code, EXIT.OK);
  assert.deepEqual([calls[0].throttleAfter, calls[0].requestDelayMs, calls[0].requisites], [3, 400, false]);
  const dflt = [];
  await drive(['cache', 'fill', 'l', '-r', '/c'], { cacheFill: cacheFillHandler({ backfill: async opts => { dflt.push(opts); return PASS; } }) });
  assert.deepEqual([dflt[0].throttleAfter, dflt[0].requestDelayMs, dflt[0].requisites], [6, 0, true]);
});

test('cache fill --pages-only reaches backfill(); off by default', async () => {
  const calls = [];
  const handler = () => cacheFillHandler({ backfill: async opts => { calls.push(opts); return PASS; } });
  assert.equal((await drive(['cache', 'fill', 'l', '-r', '/c', '--pages-only'], { cacheFill: handler() })).code, EXIT.OK);
  await drive(['cache', 'fill', 'l', '-r', '/c'], { cacheFill: handler() });
  assert.deepEqual(calls.map(c => c.pagesOnly), [true, false]);
});

test('cache fill: a throttle stop is exit 1 and says so in the summary', async () => {
  const stopped = { ...PASS, aborted: true, reason: 'throttled', stats: { attempted: 6, fetched: 0, cached: 0, deferred: 6, gone: 0 } };
  const { code, stdout, stderr } = await drive(['cache', 'fill', 'l', '-r', '/c'], { cacheFill: cacheFillHandler({ backfill: async () => stopped }) });
  assert.equal(code, EXIT.DOMAIN);
  assert.deepEqual([JSON.parse(stdout[0]).aborted, JSON.parse(stdout[0]).reason], [true, 'throttled']);
  assert.match(stderr.at(-1), /archive\.org is throttling/);
});

test('cache fill --converge: hands the loop to the library, in seconds → ms, and prints one summary', async () => {
  const calls = [];
  const handler = cacheFillHandler({
    backfill: async () => assert.fail('--converge never calls backfill() directly'),
    converge: async opts => {
      calls.push(opts);
      opts.onProgress({ type: 'backoff', reason: 'throttled', ms: 60000, pass: 1 });
      return { converged: true, stalled: false, passes: 3, totals: { attempted: 9, fetched: 8, deferred: 0, gone: 1 }, last: PASS };
    }
  });
  const { code, stdout, stderr } = await drive(
    ['cache', 'fill', 'l', '-r', '/c', '--converge', '--backoff-s', '60', '--backoff-max-s', '600', '--max-stall', '2'],
    { cacheFill: handler }
  );
  assert.equal(code, EXIT.OK);
  assert.deepEqual([calls[0].backoffMs, calls[0].backoffMaxMs, calls[0].maxStall, calls[0].ledgerDir], [60000, 600000, 2, 'l']);
  assert.equal(stdout.length, 1);
  const line = JSON.parse(stdout[0]);
  assert.deepEqual([line.passes, line.converged, line.stalled], [3, true, false]);
  assert.deepEqual(line.totals, { attempted: 9, fetched: 8, deferred: 0, gone: 1 });
  assert.ok(stderr.includes('backing off 60s (throttled)'));
});

test('cache fill --converge: a worklist that does not converge is exit 1', async () => {
  const last = { ...PASS, stats: { attempted: 2, fetched: 0, cached: 0, deferred: 2, gone: 0 } };
  const handler = cacheFillHandler({ converge: async () => ({ converged: false, stalled: true, passes: 6, totals: { attempted: 12, fetched: 0, deferred: 2, gone: 0 }, last }) });
  const { code, stderr } = await drive(['cache', 'fill', 'l', '-r', '/c', '--converge'], { cacheFill: handler });
  assert.equal(code, EXIT.DOMAIN);
  assert.match(stderr.at(-1), /2 capture\(s\) still deferred after 6 passes — they are not transient/);
});

// ---------------------------------------------------------------------------
// search --match / ledger --captures
// ---------------------------------------------------------------------------

test('search --match: enumerates through cdxPages, adds the index fields, honors --limit across pages', async () => {
  const queries = [];
  const row = (timestamp, statuscode) => ({ urlkey: 'org,example)/', timestamp, original: 'http://example.org/', mimetype: 'text/html', statuscode, digest: 'D', length: '9' });
  const handler = searchHandler({
    getSnapshots: async () => assert.fail('enumeration never uses the exact-url face'),
    cdxPages: async function* (query) {
      queries.push(query);
      yield { page: 0, rows: [row('20020101000000', '200'), row('20030101000000', '404')] };
      yield { page: 1, rows: [row('20040101000000', '200'), row('20050101000000', '200')] };
    }
  });
  const { code, stdout } = await drive(['search', 'example.org', '--match', 'domain', '--from', '2002', '--to', '2007', '--limit', '3'], { search: handler });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(queries, [{ url: 'example.org', matchType: 'domain', from: '2002', to: '2007' }]);
  assert.equal(stdout.length, 3);
  assert.deepEqual(JSON.parse(stdout[1]), {
    timestamp: '20030101000000', statuscode: '404', mimetype: 'text/html',
    waybackUrl: 'https://web.archive.org/web/20030101000000/http://example.org/',
    original: 'http://example.org/', digest: 'D', length: '9', urlkey: 'org,example)/'
  });
});

test('search --match: an outage is exit 1, never an empty result', async () => {
  const handler = searchHandler({ cdxPages: async function* () { throw new Error('HTTP 503 after 10 attempts'); } });
  const { code, stdout } = await drive(['search', 'example.org', '--match', 'host'], { search: handler });
  assert.equal(code, EXIT.DOMAIN);
  assert.deepEqual(stdout, []);
});

test('ledger: a capture list is a row of its own, and --captures keeps every version of a url', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'site'));
  const wb = ts => `https://web.archive.org/web/${ts}/http://example.org/a`;
  fs.writeFileSync(path.join(dir, 'site', 'captures.jsonl'), [{ wayback: wb('20020101000000'), rank: 0 }, { wayback: wb('20030101000000'), rank: 1 }].map(r => JSON.stringify(r)).join('\n'));
  const survey = await drive(['ledger', dir], { ledger: ledgerHandler() });
  assert.deepEqual(survey.stdout.map(l => JSON.parse(l)), [{ file: 'site/captures.jsonl', captures: 2 }]);
  const rows = await drive(['ledger', dir, '--captures'], { ledger: ledgerHandler() });
  assert.equal(rows.code, EXIT.OK);
  assert.deepEqual(rows.stdout.map(l => JSON.parse(l)), [
    { key: '20020101000000/http://example.org/a', waybackUrl: wb('20020101000000'), timestamp: '20020101000000', originalUrl: 'http://example.org/a', files: ['site/captures.jsonl'], rank: 0 },
    { key: '20030101000000/http://example.org/a', waybackUrl: wb('20030101000000'), timestamp: '20030101000000', originalUrl: 'http://example.org/a', files: ['site/captures.jsonl'], rank: 1 }
  ]);
});

// ---------------------------------------------------------------------------
// usage errors + the real bin, end to end
// ---------------------------------------------------------------------------

test('usage errors exit 2 through the real bin', () => {
  for (const argv of [
    ['site', 'enumerate', 's.json'],
    ['site', 'enumerate', '--ledger', 'l'],
    ['site', 'export', 'l', '-r', '/r'],
    ['site', 'export', 'l', '--out', '/o'],
    ['cache', 'remediate'],
    ['cache', 'remediate', '-r', '/r', '--delay-ms', 'fast'],
    ['cache', 'status', 'l'],
    ['cache', 'status', '-r', '/r'],
    ['cache', 'fill', 'l', '-r', '/r', '--converge', '--dry-run'],
    ['cache', 'fill', 'l', '-r', '/r', '--backoff-s', 'soon'],
    ['search', 'example.org', '--match', 'glob'],
    ['search', 'example.org', '--from', 'last-year'],
    ['ledger', 'l', '--captures', '--flatten']
  ]) {
    assert.equal(cli(...argv).status, EXIT.USAGE, argv.join(' '));
  }
  assert.equal(cli('site').status, EXIT.USAGE, 'a bare group prints its help and exits 2');
});

test('real bin: enumerate offline → ledger → fill --dry-run → status → export, over the fixture CDX pages', () => {
  const work = tmp();
  const ledger = path.join(work, 'ledger');
  const root = path.join(work, 'root');
  const config = path.join(work, 'sites.json');
  fs.writeFileSync(config, JSON.stringify({
    window: { from: '2002', to: '2007' },
    sites: [{ name: 'jefraskin.com', queries: [{ url: 'jefraskin.com', matchType: 'domain' }] }]
  }));
  fs.mkdirSync(path.join(ledger, 'jefraskin.com', 'cdx'), { recursive: true });
  for (const f of fs.readdirSync(SITE_CDX).filter(f => f.startsWith('jefraskin.com_'))) {
    fs.copyFileSync(path.join(SITE_CDX, f), path.join(ledger, 'jefraskin.com', 'cdx', f));
  }

  const enumerated = cli('site', 'enumerate', config, '--ledger', ledger, '--offline', '-q');
  assert.equal(enumerated.status, EXIT.OK, enumerated.stderr);
  assert.equal(JSON.parse(enumerated.stdout).sites['jefraskin.com'].versions, 4);

  const captures = cli('ledger', ledger, '--captures').stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(captures.length, 4);

  const fill = cli('cache', 'fill', ledger, '--root', root, '--dry-run', '-q');
  assert.equal(fill.status, EXIT.OK, fill.stderr);
  assert.deepEqual(JSON.parse(fill.stdout), { root, worklist: 4, pending: 4, dryRun: true, aborted: false });
  // Pages come before content. Within the pages, rank 0 — one capture of
  // every URL — comes first, so the rank-1 page is the last page.
  const worklist = fs.readFileSync(path.join(root, '.refetch', 'worklist.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).waybackUrl);
  const flagged = worklist.map(u => /\/web\/\d+[a-z]{2}_\//.test(u));
  assert.ok(flagged.includes(true) && flagged.includes(false), 'the fixture holds both pages and raw captures');
  assert.equal(flagged.indexOf(true), flagged.lastIndexOf(false) + 1, 'every page precedes every flagged capture');
  assert.equal(worklist[flagged.lastIndexOf(false)], 'https://web.archive.org/web/20030224204757/http://www.jefraskin.com:80/forjef2/jefweb-compiled/pictures/');

  const status = cli('cache', 'status', ledger, '--root', root, '--json');
  assert.equal(status.status, EXIT.DOMAIN, 'four captures are still pending');
  assert.deepEqual(JSON.parse(status.stdout).unfetched, { gone: 0, pending: 4 });

  // Nothing is stored yet, so there is no meta/ to export: a loud failure.
  const exported = cli('site', 'export', ledger, '--root', root, '--out', path.join(work, 'tree'));
  assert.equal(exported.status, EXIT.DOMAIN);
  assert.match(exported.stderr, /not a cache root/);
});
