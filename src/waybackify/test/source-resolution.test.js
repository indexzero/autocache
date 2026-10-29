// Source resolution through the real CDX client, with deterministic transport.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WaybackMachine } from '../index.js';
import { generate } from '../manifest.js';

function cdx(records, { ignoreFilters = false, onRequest } = {}) {
  const requests = [];
  const wayback = new WaybackMachine({ impit: {
    async fetch(url) {
      const params = new URL(url).searchParams;
      requests.push(params);
      let rows = onRequest ? onRequest(params, requests.length) : records;
      // fastLatest may read only the newest CDX index block, before filters.
      // Keep one row in that block so a strict lookup must search past it.
      if (params.get('fastLatest') === 'true') rows = rows.slice(-1);
      if (!ignoreFilters) {
        for (const filter of params.getAll('filter')) {
          if (filter.startsWith('original:')) {
            const pattern = new RegExp(filter.slice('original:'.length));
            rows = rows.filter(row => pattern.test(row[1]));
          }
        }
      }
      if (params.has('from')) rows = rows.filter(row => row[0] >= params.get('from'));
      if (params.has('to')) rows = rows.filter(row => row[0].slice(0, params.get('to').length) <= params.get('to'));
      const limit = Number(params.get('limit'));
      rows = limit < 0 ? rows.slice(limit) : rows.slice(0, limit);
      return { status: 200, async json() { return [['timestamp', 'original'], ...rows]; } };
    }
  } });
  return { wayback, requests };
}

const originals = [
  ['path case', 'http://identity.example/Post', 'http://identity.example/post'],
  ['query case', 'http://identity.example/?id=ABC', 'http://identity.example/?id=abc'],
  ['query punctuation', 'http://identity.example/?id=A+B.(C)[D]$|{E}^', 'http://identity.example/?id=other']
];

for (const [name, requested, other] of originals) {
  for (const near of [undefined, '20140402']) {
    test(`default source resolver preserves ${name} when choosing ${near ? 'nearest' : 'latest'} capture`, async () => {
      const timestamp = '20140401000000';
      const { wayback, requests } = cdx([[timestamp, requested], ['20140402000000', other]]);
      const result = await generate('', null, null, { sourceUrls: [requested], near, wayback });
      assert.deepEqual(result.unresolvedSources, []);
      assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/${timestamp}/${requested}`);
      assert.equal(result.manifest.sources[requested].timestamp, timestamp);
      assert.ok(requests.every(params => params.getAll('filter').includes('statuscode:200')));
    });
  }
}

test('source resolution widens the date window after rejecting another original', async () => {
  const requested = 'http://identity.example/Post';
  const other = 'http://identity.example/post';
  const { wayback, requests } = cdx([], {
    ignoreFilters: true,
    onRequest: (_params, count) => count === 1
      ? [['20140402000000', other]]
      : [['20131002000000', requested]]
  });
  const result = await generate('', null, null, { sourceUrls: [requested], near: '20140402', wayback });
  assert.deepEqual(result.unresolvedSources, []);
  assert.equal(result.manifest.sources[requested].timestamp, '20131002000000');
  assert.equal(requests.length, 2);
});

test('an archive response for another original cannot resolve a source', async () => {
  const requested = 'http://identity.example/Post';
  const { wayback, requests } = cdx([['20140402000000', 'http://identity.example/post']], { ignoreFilters: true });
  const result = await generate('', null, null, { sourceUrls: [requested], near: '20140402', wayback });
  assert.deepEqual(result.manifest.sources, {});
  assert.deepEqual(result.seen.sources, {});
  assert.deepEqual(result.unresolvedSources, [{ url: requested, error: 'no archived capture' }]);
  assert.equal(requests.length, 4, 'all date windows and the latest query remain identity-constrained');
});

test('ordinary link resolution retains its existing CDX lookup behavior', async () => {
  const original = 'http://identity.example/Post';
  const captured = 'https://identity.example/post/';
  const { wayback, requests } = cdx([['20140402000000', captured]]);
  const result = await generate(`[Link](${original})`, null, null, { wayback });
  assert.equal(result.manifest.entries[original].wayback, `https://web.archive.org/web/20140402000000/${captured}`);
  assert.deepEqual(requests[0].getAll('filter'), ['statuscode:200']);
});
