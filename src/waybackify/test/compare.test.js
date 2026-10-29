import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { bodyFile, canonicalJSON, entryPaths, readSidecar, SIDECAR_VERSION } from '../cache.js';
import { compareRoots } from '../compare.js';
import { fsck, totalFindings } from '../fsck.js';
import { fetchedAt, fixture, key, put, roots, snapshot } from './helpers/compare-fixture.js';

const sri = text => `sha256-${crypto.createHash('sha256').update(text).digest('base64')}`;

test('four sets partition capture keys and retain exact conflict identities', async () => {
  const { dir, base, fetch } = await fixture();
  const before = await snapshot(dir);
  const report = await compareRoots(base, fetch);
  assert.deepEqual(report.counts, { newOnly: 1, oldOnly: 1, bothAgreeing: 5, bothConflicting: 3 });
  assert.equal(Object.values(report.counts).reduce((a, b) => a + b), 10, 'each distinct key counted once');
  assert.deepEqual(report.conflicts.map(row => row.key), [key('A-state'), key('z-hash'), key('é-body')]);
  assert.deepEqual(report.conflicts[1], {
    key: key('z-hash'),
    base: {
      v: SIDECAR_VERSION, key: key('z-hash'), status: 'body',
      contentHash: sri('old bytes'), contentLength: 9, contentType: 'text/plain',
      flag: null, fetchedAt, signature: null, target: null
    },
    fetch: {
      v: SIDECAR_VERSION, key: key('z-hash'), status: 'body',
      contentHash: sri('new bytes'), contentLength: 9, contentType: 'text/plain',
      flag: null, fetchedAt, signature: null, target: null
    }
  });
  assert.equal(report.conflicts[0].base.contentHash, null);
  assert.equal(report.conflicts[0].fetch.contentLength, null);
  assert.equal(report.conflicts[2].base.status, 'body');
  assert.equal(report.conflicts[2].fetch.status, 'error');
  assert.deepEqual(await snapshot(dir), before, 'both input trees and their parent stay byte-identical');
});

test('all current status pairs agree only on matching status, with body hashes checked', async () => {
  const { dir, base, fetch } = await roots();
  const statuses = ['body', 'empty', 'redirect', 'error', 'interstitial'];
  for (const oldStatus of statuses) {
    for (const newStatus of statuses) {
      const name = `${oldStatus}-${newStatus}`;
      await put(base, name, oldStatus, 'same bytes');
      await put(fetch, name, newStatus, 'same bytes');
    }
  }
  const before = await snapshot(dir);
  const report = await compareRoots(base, fetch);
  assert.deepEqual(report.counts, { newOnly: 0, oldOnly: 0, bothAgreeing: 5, bothConflicting: 20 });
  assert.equal(report.conflicts.length, 20);
  assert.ok(report.conflicts.every(row => row.base.status !== row.fetch.status));
  assert.deepEqual(await snapshot(dir), before);
});

test('same bodiless state ignores other metadata and conflict records retain interstitial detail', async () => {
  const { base, fetch } = await roots();
  await put(base, 'notice', 'interstitial');
  await put(fetch, 'notice', 'interstitial');
  const { meta } = await entryPaths(base, key('notice'));
  await fsp.writeFile(meta, canonicalJSON({
    ...await readSidecar(base, key('notice')),
    signature: 'redirect-interstitial', target: 'https://example.test/elsewhere'
  }));
  assert.equal((await compareRoots(base, fetch)).counts.bothAgreeing, 1);
  await put(fetch, 'notice', 'error');
  const report = await compareRoots(base, fetch);
  assert.equal(report.conflicts[0].base.signature, 'redirect-interstitial');
  assert.equal(report.conflicts[0].base.target, 'https://example.test/elsewhere');
});

test('empty existing roots are valid and comparing one root with itself agrees', async () => {
  const { base, fetch } = await roots();
  assert.deepEqual(await compareRoots(base, fetch), {
    counts: { newOnly: 0, oldOnly: 0, bothAgreeing: 0, bothConflicting: 0 }, conflicts: []
  });
  await put(base, 'one');
  assert.deepEqual(await compareRoots(base, base), {
    counts: { newOnly: 0, oldOnly: 0, bothAgreeing: 1, bothConflicting: 0 }, conflicts: []
  });
});

test('output is stable across roots, insertion order, repeated calls, and UTF-16 key order', async () => {
  const forward = await fixture();
  const backward = await fixture(true);
  const first = JSON.stringify(await compareRoots(forward.base, forward.fetch));
  assert.equal(JSON.stringify(await compareRoots(backward.base, backward.fetch)), first);
  assert.equal(JSON.stringify(await compareRoots(forward.base, forward.fetch)), first);
  const pair = await roots();
  for (const name of ['\ue000', '😀', 'é', 'z', 'A']) {
    await put(pair.base, name, 'empty');
    await put(pair.fetch, name, 'error');
  }
  assert.deepEqual((await compareRoots(pair.base, pair.fetch)).conflicts.map(row => row.key),
    [key('A'), key('z'), key('é'), key('😀'), key('\ue000')]);
});

for (const side of ['base', 'fetch']) {
  for (const defect of ['missing-root', 'file-root', 'malformed', 'missing-body', 'changed-body', 'old-schema', 'stale-tmp', 'missing-key', 'wrong-shard']) {
    test(`${side} rejects ${defect} without writing either tree`, async () => {
      const pair = await roots();
      await put(pair.base, 'one');
      await put(pair.fetch, 'one');
      const broken = pair[side];
      const sidecar = await readSidecar(broken, key('one'));
      const { meta } = await entryPaths(broken, key('one'));
      if (defect === 'missing-root') pair[side] = path.join(pair.dir, 'absent');
      if (defect === 'file-root') {
        pair[side] = path.join(pair.dir, 'plain-file');
        await fsp.writeFile(pair[side], 'not a directory');
      }
      if (defect === 'malformed') await fsp.writeFile(meta, '{');
      if (defect === 'missing-body') await fsp.unlink(bodyFile(broken, sidecar.contentHash));
      if (defect === 'changed-body') await fsp.writeFile(bodyFile(broken, sidecar.contentHash), 'tampered');
      if (defect === 'old-schema') await fsp.writeFile(meta, canonicalJSON({ ...sidecar, v: 2 }));
      if (defect === 'stale-tmp') await fsp.writeFile(path.join(broken, 'tmp', 'interrupted.part'), 'evidence');
      if (defect === 'missing-key') await fsp.writeFile(meta, canonicalJSON({ ...sidecar, key: null }));
      if (defect === 'wrong-shard') {
        const destination = path.join(broken, 'meta', 'wrong', path.basename(meta));
        await fsp.mkdir(path.dirname(destination));
        await fsp.rename(meta, destination);
      }
      const before = await snapshot(pair.dir);
      await assert.rejects(compareRoots(pair.base, pair.fetch));
      assert.deepEqual(await snapshot(pair.dir), before);
    });
  }
}

test('fsck identity visitor preserves the default report and exposes keys for the formal reader', async () => {
  const { base } = await roots();
  await put(base, 'one');
  const entries = [];
  const normal = await fsck(base);
  const visited = await fsck(base, { onSidecar: entry => { entries.push(entry); } });
  assert.equal(totalFindings(visited), 0);
  assert.deepEqual(visited, normal);
  assert.deepEqual(entries, [{ key: key('one'), path: (await entryPaths(base, key('one'))).meta }]);
  assert.equal((await readSidecar(base, entries[0].key)).status, 'body');
});
