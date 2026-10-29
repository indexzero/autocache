// `waybackify cache fill` handler — thin-wrapper wiring test. The load-bearing
// engine (src/waybackify/backfill.js) is covered by its own unit + e2e suites.
// Here we prove the handler maps argv → backfill() options, prints the one
// summary line, and turns an abort into a domain-failure throw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheFillHandler } from '../src/commands/cache-fill.js';

/** Run the handler with an injected library backfill(); capture its call + io. */
function run({ args, flags, result }) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const handler = cacheFillHandler({
    backfill: async opts => { calls.push(opts); return result; }
  });
  const push = (o, m) => stderr.push(typeof o === 'string' ? o : m);
  const logger = { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
  return { promise: handler({ args, flags, logger, out: l => stdout.push(l) }), calls, stdout, stderr };
}

const okResult = {
  worklist: { built: true, count: 3, path: '/c/.refetch/worklist.jsonl' },
  pending: 3, gone: 0, dryRun: false, aborted: false,
  stats: { attempted: 2, fetched: 2, cached: 1, deferred: 0, gone: 0 }
};

test('maps argv → backfill() options (numbers coerced, booleans set)', async () => {
  const { promise, calls } = run({
    args: { dir: 'words' },
    flags: { root: '/cache', delayMs: '250', abortAfter: '3', max: '10', refresh: true, dryRun: false },
    result: okResult
  });
  await promise;
  assert.equal(calls.length, 1);
  const o = calls[0];
  assert.equal(o.ledgerDir, 'words');
  assert.equal(o.root, '/cache');
  assert.equal(o.delayMs, 250);
  assert.equal(o.abortAfter, 3);
  assert.equal(o.max, 10);
  assert.equal(o.refresh, true);
  assert.equal(o.dryRun, false);
});

test('absent numeric flags fall back to the engine defaults', async () => {
  const { promise, calls } = run({ args: { dir: 'w' }, flags: { root: '/c' }, result: okResult });
  await promise;
  assert.equal(calls[0].delayMs, 1500);
  assert.equal(calls[0].abortAfter, 5);
  assert.equal(calls[0].max, Infinity);
});

test('prints exactly one JSON summary line on stdout', async () => {
  const { promise, stdout } = run({ args: { dir: 'w' }, flags: { root: '/c' }, result: okResult });
  await promise;
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    root: '/c', worklist: 3, pending: 3, dryRun: false,
    fetched: 2, cached: 1, deferred: 0, gone: 0, attempts: 2, aborted: false
  });
});

test('abort → throws (domain failure → exit 1), summary still printed', async () => {
  const aborted = { ...okResult, aborted: true, stats: { attempted: 5, fetched: 0, cached: 0, deferred: 5, gone: 0 } };
  const { promise, stdout } = run({ args: { dir: 'w' }, flags: { root: '/c' }, result: aborted });
  await assert.rejects(promise, /cache fill aborted: archive\.org unreachable/);
  assert.equal(JSON.parse(stdout[0]).aborted, true);
});

test('dry-run summary omits stats (no fetch happened)', async () => {
  const dry = { worklist: { built: true, count: 3, path: '/c/.refetch/worklist.jsonl' }, pending: 3, gone: 0, dryRun: true, aborted: false, stats: null };
  const { promise, stdout } = run({ args: { dir: 'w' }, flags: { root: '/c', dryRun: true }, result: dry });
  await promise;
  const line = JSON.parse(stdout[0]);
  assert.equal(line.dryRun, true);
  assert.equal(line.fetched, undefined);
});

test('a GitHub rename streams to stderr as a rewrite candidate', async () => {
  const stderr = [];
  const handler = cacheFillHandler({
    backfill: async opts => {
      opts.onProgress({ type: 'rename', waybackUrl: 'https://web.archive.org/web/1/https://github.com/a/b/issues/1', from: 'https://github.com/a/b/issues/1', to: 'https://github.com/c/d/issues/1' });
      return okResult;
    }
  });
  const push = (o, m) => stderr.push(m);
  const logger = { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
  await handler({ args: { dir: 'w' }, flags: { root: '/c' }, logger, out: () => {} });
  assert.deepEqual(stderr, ['rename   https://github.com/a/b/issues/1 → https://github.com/c/d/issues/1 (rewrite candidate, not gone)']);
});


test('a source-only capture fills, enters crawl, remasters, and fails verification when missing', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { backfill } = await import('@autocache/waybackify/backfill.js');
  const { against, discover } = await import('@autocache/waybackify/ledger.js');
  const { readSidecar } = await import('@autocache/waybackify/cache.js');
  const { bodyPath, metaPath } = await import('@autocache/waybackify/key.js');
  const { enumerateHtmlDocKeys } = await import('@autocache/waybackify-crawl');
  const { run: runCli, EXIT } = await import('../src/cli.js');
  const { remasterBuildHandler } = await import('../src/commands/remaster-build.js');
  const { remasterVerifyHandler } = await import('../src/commands/remaster-verify.js');
  const { cacheVerifyHandler } = await import('../src/commands/cache-verify.js');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'source-capture-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const tree = path.join(temp, 'tree');
  const cache = path.join(temp, 'cache');
  const remastered = path.join(temp, 'remastered');
  await fs.mkdir(tree);
  const original = 'http://document.example/post';
  const timestamp = '20140403040000';
  const key = `${timestamp}/${original}`;
  const wayback = `https://web.archive.org/web/${key}`;
  await fs.writeFile(path.join(tree, 'wayback.json'), JSON.stringify({
    version: 2, sources: { [original]: { wayback, timestamp } }, entries: {}
  }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><a href="${wayback}">This document</a></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const stdout = [];
  const handlers = {
    cacheFill: cacheFillHandler({ backfill: options => backfill({ ...options, deps: {
      wayback: {},
      fetch: url => {
        assert.equal(url, wayback);
        return fetch(`${local}${new URL(url).pathname}`);
      }
    } }) }),
    cacheVerify: cacheVerifyHandler(),
    remasterBuild: remasterBuildHandler(),
    remasterVerify: remasterVerifyHandler()
  };
  const command = async args => {
    stdout.length = 0;
    return runCli(args, { handlers, logger, out: line => stdout.push(line), error() {} });
  };
  const before = await against(discover(tree), cache);
  assert.deepEqual(before.unfetched.map(i => i.key), [key]);
  assert.equal(await command(['cache', 'fill', tree, '--root', cache, '--delay-ms', '0']), EXIT.OK);
  assert.equal(JSON.parse(stdout[0]).fetched, 1);
  assert.equal(requests.length, 1);
  const after = await against(discover(tree), cache);
  assert.deepEqual(after.cached.map(i => i.key), [key]);
  assert.deepEqual(after.unfetched, []);
  assert.deepEqual(await enumerateHtmlDocKeys(cache), [key]);
  assert.equal(await command(['cache', 'verify', '--root', cache, '--json']), EXIT.OK);
  assert.equal(await command(['remaster', 'build', cache, remastered]), EXIT.OK);
  const sidecar = await readSidecar(remastered, key);
  const body = path.join(remastered, bodyPath(sidecar.contentHash));
  assert.match(await fs.readFile(body, 'utf8'), /href="\/web\/20140403040000\/http:\/\/document\.example\/post"/);
  const verify = ['remaster', 'verify', '--root', remastered, '--tier', 'static', '--json'];
  assert.equal(await command(verify), EXIT.OK);
  await fs.unlink(body);
  assert.equal(await command(verify), EXIT.DOMAIN);
  assert.ok(JSON.parse(stdout[0]).layers.flatMap(l => l.findings).some(f => f.key === key && f.kind === 'body-missing'));
  await fs.unlink(path.join(remastered, await metaPath(key)));
  assert.equal(await command(verify), EXIT.DOMAIN);
  assert.ok(JSON.parse(stdout[0]).layers.flatMap(l => l.findings).some(f => f.key === key && f.kind === 'entry-missing'));
  const cached = await readSidecar(cache, key);
  await fs.unlink(path.join(cache, bodyPath(cached.contentHash)));
  assert.equal(await command(['cache', 'verify', '--root', cache, '--json']), EXIT.DOMAIN);
  assert.ok(JSON.parse(stdout[0]).findings.missingBody.some(f => f.key === key));
});
