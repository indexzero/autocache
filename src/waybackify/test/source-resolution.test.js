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
  ['non-default port', 'http://identity.example:8080/Post', 'http://identity.example/Post'],
  ['scheme', 'https://identity.example/Post', 'http://identity.example/Post'],
  ['www host', 'http://www.identity.example/Post', 'http://identity.example/Post'],
  ['path encoding', 'http://identity.example/%50ost', 'http://identity.example/Post'],
  ['percent escape case', 'http://identity.example/%2fPost', 'http://identity.example/%2FPost'],
  ['query encoding', 'http://identity.example/?q=%41', 'http://identity.example/?q=A'],
  ['dot segments', 'http://identity.example/a/../Post', 'http://identity.example/Post'],
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


const equivalentOriginals = [
  ['HTTP default port', 'http://identity.example/Post', 'http://identity.example:80/Post'],
  ['HTTPS default port', 'https://identity.example/Post', 'https://identity.example:443/Post'],
  ['bare root', 'http://identity.example', 'http://identity.example/'],
  ['bare root with query', 'https://identity.example?ID=%2f', 'https://identity.example:443/?ID=%2f'],
  ['scheme and host case', 'http://identity.example/Post?ID=ABC', 'HTTP://Identity.Example/Post?ID=ABC'],
  ['combined spellings', 'HTTPS://Identity.Example:443', 'https://identity.example/'],
  ['IPv6 host case', 'http://[2001:db8::a]/Post', 'HTTP://[2001:DB8::A]:80/Post']
];

for (const [name, first, second] of equivalentOriginals) {
  for (const [requested, captured] of [[first, second], [second, first]]) {
    for (const near of [undefined, '20110601']) {
      test(`source ${name}: ${requested} resolves an all-variant ${near ? 'near' : 'latest'} history`, async () => {
        const { wayback, requests } = cdx([
          ['20110501000000', captured], ['20110601120000', captured], ['20110701000000', captured]
        ]);
        const result = await generate('', null, null, { sourceUrls: [requested], near, wayback });
        const ts = near ? '20110601120000' : '20110701000000';
        assert.deepEqual(result.unresolvedSources, []);
        assert.equal(result.manifest.sources[requested].timestamp, ts);
        assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/${ts}/${captured}`);
        assert.equal(requests.length, 1, 'one query admits all equivalent spellings');
        assert.equal(requests[0].get('url'), requested, 'the requested spelling reaches CDX unchanged');
      });
    }
    test(`injected source resolver accepts ${name}: ${requested}`, async () => {
      const result = await generate('', null, null, {
        sourceUrls: [requested], resolve: () => ({
          url: `https://web.archive.org/web/20110601120000/${captured}`, timestamp: '20110601120000'
        })
      });
      assert.deepEqual(result.unresolvedSources, []);
      assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/20110601120000/${captured}`);
    });
  }
}

test('nearest source selection includes an equivalent capture ahead of a much newer exact spelling', async () => {
  const requested = 'http://identity.example/Post';
  const captured = 'HTTP://Identity.Example:80/Post';
  const { wayback, requests } = cdx([
    ['20110601120000', captured], ['20190301000000', requested]
  ]);
  const result = await generate('', null, null, { sourceUrls: [requested], near: '20110601', wayback });
  assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/20110601120000/${captured}`);
  assert.equal(requests.length, 1);
});

test('latest source selection compares multiple matching rows across spellings and index blocks', async () => {
  const requested = 'https://identity.example/Post';
  const captured = 'HTTPS://Identity.Example:443/Post';
  const { wayback, requests } = cdx([
    ['20110401000000', captured], ['20110501000000', requested],
    ['20110601120000', captured], ['20190301000000', requested.replace('/Post', '/post')]
  ]);
  const result = await generate('', null, null, { sourceUrls: [requested], wayback });
  assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/20110601120000/${captured}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].get('fastLatest'), 'false');
  assert.equal(requests[0].get('limit'), '-1');
});

test('case-distinct paths and queries cannot exhaust the nearest-source result limit', async () => {
  const requested = 'http://identity.example/Post?ID=ABC';
  const captured = 'HTTP://Identity.Example:80/Post?ID=ABC';
  const crowded = Array.from({ length: 60 }, (_, i) => [
    `20110501${String(i).padStart(6, '0')}`,
    i % 2 ? 'http://identity.example/post?ID=ABC' : 'http://identity.example/Post?ID=abc'
  ]);
  const { wayback, requests } = cdx([
    ...crowded, ['20110502000000', requested], ['20110601120000', captured]
  ]);
  const result = await generate('', null, null, { sourceUrls: [requested], near: '20110601', wayback });
  assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/20110601120000/${captured}`);
  assert.equal(requests.length, 1, 'the server filters case-distinct originals before limit=50');
});

test('client post-filter accepts equivalent rows while rejecting distinct originals when filters are ignored', async () => {
  const requested = 'https://identity.example/Post?ID=%2f';
  const captured = 'HTTPS://Identity.Example:443/Post?ID=%2f';
  const { wayback } = cdx([
    ['20110601000000', captured],
    ['20110601120000', 'https://identity.example/post?ID=%2f'],
    ['20110601120000', 'https://identity.example/Post?ID=%2F']
  ], { ignoreFilters: true });
  const result = await generate('', null, null, { sourceUrls: [requested], near: '20110601120000', wayback });
  assert.deepEqual(result.unresolvedSources, []);
  assert.equal(result.manifest.sources[requested].wayback, `https://web.archive.org/web/20110601000000/${captured}`);
});
