import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyFile, entryPaths, readSidecar } from '@autocache/waybackify/cache.js';
import { compareRoots } from '@autocache/waybackify/compare.js';
import { EXIT, run } from '../src/cli.js';
import { fixture, key, put, roots, snapshot } from '../../waybackify/test/helpers/compare-fixture.js';

const BIN = fileURLToPath(new URL('../bin/waybackify.js', import.meta.url));
function cli(...argv) {
  const result = spawnSync(process.execPath, [BIN, 'merge', ...argv], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  return result;
}

test('real bin emits exact JSONL matching the library and preserves both input trees', async () => {
  const { dir, base, fetch } = await fixture();
  const before = await snapshot(dir);
  const report = await compareRoots(base, fetch);
  const first = cli(base, fetch, '--report');
  assert.equal(first.status, EXIT.OK, first.stderr);
  assert.equal(first.stderr, '');
  const lines = first.stdout.trimEnd().split('\n');
  assert.equal(lines[0], '{"type":"summary","counts":{"newOnly":1,"oldOnly":1,"bothAgreeing":5,"bothConflicting":3}}');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(JSON.parse), [
    { type: 'summary', counts: report.counts },
    ...report.conflicts.map(row => ({ type: 'conflict', ...row }))
  ]);
  assert.ok(first.stdout.endsWith('\n'));
  assert.equal(cli(base, fetch, '--report').stdout, first.stdout);
  assert.deepEqual(await snapshot(dir), before, 'no changed inputs or created output directory');
});

test('two empty roots emit only the summary record', async () => {
  const { base, fetch } = await roots();
  const result = cli(base, fetch, '--report');
  assert.equal(result.status, EXIT.OK, result.stderr);
  assert.equal(result.stdout, '{"type":"summary","counts":{"newOnly":0,"oldOnly":0,"bothAgreeing":0,"bothConflicting":0}}\n');
});

for (const side of ['base', 'fetch']) {
  for (const defect of ['missing-root', 'file-root', 'malformed', 'missing-body', 'stale-tmp']) {
    test(`real bin rejects ${side} ${defect} with zero partial stdout`, async () => {
      const pair = await roots();
      await put(pair.base, 'one');
      await put(pair.fetch, 'one', 'error');
      const broken = pair[side];
      await put(broken, 'corrupt');
      const record = await readSidecar(broken, key('corrupt'));
      const { meta } = await entryPaths(broken, key('corrupt'));
      if (defect === 'missing-root') pair[side] = path.join(pair.dir, 'absent');
      if (defect === 'file-root') {
        pair[side] = path.join(pair.dir, 'plain-file');
        await fsp.writeFile(pair[side], 'not a directory');
      }
      if (defect === 'malformed') await fsp.writeFile(meta, 'not JSON');
      if (defect === 'missing-body') await fsp.unlink(bodyFile(broken, record.contentHash));
      if (defect === 'stale-tmp') await fsp.writeFile(path.join(broken, 'tmp', 'keep.part'), 'evidence');
      const before = await snapshot(pair.dir);
      const result = cli(pair.base, pair.fetch, '--report');
      assert.equal(result.status, EXIT.DOMAIN, result.stderr);
      assert.equal(result.stdout, '');
      assert.notEqual(result.stderr, '');
      if (['malformed', 'missing-body', 'stale-tmp'].includes(defect)) assert.match(result.stderr, /failed fsck/);
      assert.deepEqual(await snapshot(pair.dir), before);
    });
  }
}

test('writer invocations and invalid arguments exit 2 without creating an output corpus', async () => {
  const { dir, base, fetch } = await fixture();
  const output = path.join(dir, 'output');
  const before = await snapshot(dir);
  for (const args of [
    [base, fetch], [base, fetch, '--no-report'], [base, fetch, output],
    [base, fetch, output, '--report'], [base, fetch, '--report', '--output', output],
    [base, fetch, '--report', '--fix'], ['--report'], [base, '--report']
  ]) {
    const result = cli(...args);
    assert.equal(result.status, EXIT.USAGE, result.stderr);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
  }
  assert.match(cli(base, fetch).stderr, /merge requires --report.*not supported/);
  assert.deepEqual(await snapshot(dir), before);
  await assert.rejects(fsp.stat(output), { code: 'ENOENT' });
});

test('merge handler receives parsed roots and the required report flag', async () => {
  let payload;
  const status = await run(['merge', 'base-cache', 'fetch-cache', '--report'], {
    handlers: { merge: value => { payload = value; } }, error: () => {}
  });
  assert.equal(status, EXIT.OK);
  assert.deepEqual(payload.args, { baseRoot: 'base-cache', fetchRoot: 'fetch-cache' });
  assert.equal(payload.flags.report, true);
});
