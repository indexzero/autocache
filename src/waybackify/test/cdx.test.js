// CDX enumeration — offline, mocked fetch. The page shapes are the index's
// own: a header row, data rows, and (with showResumeKey) an empty row
// followed by a one-cell row carrying the next page's key.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CDX_FIELDS, CdxUnavailableError, cdxFetch, cdxPages, cdxUrl, parseCdxPage } from '../cdx.js';

const HEADER = [...CDX_FIELDS];
const row = (timestamp, statuscode = '200') =>
  ['org,example)/', timestamp, 'http://example.org/', 'text/html', statuscode, 'DIGEST', '512'];
const res = (status, text) => ({ status, text: async () => text });
const OFFLINE = '<html><head><title>Temporarily Offline</title></head><body>…</body></html>';

describe('parseCdxPage', () => {
  it('maps rows onto the header and finds the resume key', () => {
    const { rows, resumeKey } = parseCdxPage(JSON.stringify([HEADER, row('20020101000000'), row('20030101000000', '404'), [], ['org%2Cexample%29%2F+20030101000000']]));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], {
      urlkey: 'org,example)/', timestamp: '20030101000000', original: 'http://example.org/',
      mimetype: 'text/html', statuscode: '404', digest: 'DIGEST', length: '512'
    });
    assert.equal(resumeKey, 'org%2Cexample%29%2F+20030101000000');
  });

  it('an empty result and a last page have no resume key', () => {
    assert.deepEqual(parseCdxPage('[]'), { rows: [], resumeKey: null });
    assert.equal(parseCdxPage(JSON.stringify([HEADER, row('20020101000000')])).resumeKey, null);
  });

  it('an outage page is an error with the caller\'s context, never zero rows', () => {
    assert.throws(() => parseCdxPage(OFFLINE, 'cdx/a.p000.json'), /cdx\/a\.p000\.json: not JSON \(an outage page\?\)/);
    assert.throws(() => parseCdxPage('{"error":"x"}'), /not a JSON array/);
  });
});

describe('cdxFetch — outage-aware retry', () => {
  it('treats HTML under a 200, a 503, and a transport throw alike: back off and retry', async () => {
    const replies = [res(200, OFFLINE), res(503, 'busy'), new Error('ConnectError(\n  "tcp connect error",\n)'), res(200, '[]')];
    const sleeps = [];
    const text = await cdxFetch('https://web.archive.org/cdx/search/cdx?url=a', {
      fetch: async () => {
        const r = replies.shift();
        if (r instanceof Error) throw r;
        return r;
      },
      sleep: async ms => { sleeps.push(ms); },
      backoffMs: 30000,
      maxBackoffMs: 100000
    });
    assert.equal(text, '[]');
    assert.deepEqual(sleeps, [30000, 60000, 100000], 'doubles from backoffMs, capped at maxBackoffMs');
  });

  it('gives up with a typed error that says why, in one line', async () => {
    const err = await cdxFetch('https://web.archive.org/cdx/search/cdx?url=a', {
      fetch: async () => { throw new Error('ConnectError(\n  "tcp connect error",\n  Os { code: 61 },\n)'); },
      sleep: async () => {},
      maxAttempts: 3
    }).catch(e => e);
    assert.ok(err instanceof CdxUnavailableError);
    assert.equal(err.code, 'ERR_CDX_UNAVAILABLE');
    assert.equal(err.attempts, 3);
    assert.equal(err.message, 'ConnectError( after 3 attempts: https://web.archive.org/cdx/search/cdx?url=a');
  });
});

describe('cdxPages — paged enumeration', () => {
  it('always sends a limit, follows the resume key, and yields each page\'s raw text', async () => {
    const requests = [];
    const pages = [
      JSON.stringify([HEADER, row('20020101000000'), [], ['KEY-1']]),
      JSON.stringify([HEADER, row('20030101000000')])
    ];
    const seen = [];
    for await (const page of cdxPages(
      { url: 'example.org', matchType: 'domain', from: '2002', to: '2007', pageLimit: 1 },
      { fetch: async url => { requests.push(new URL(url).searchParams); return res(200, pages[requests.length - 1]); }, sleep: async () => {} }
    )) seen.push(page);

    assert.deepEqual(seen.map(p => [p.page, p.rows.length, p.resumeKey]), [[0, 1, 'KEY-1'], [1, 1, null]]);
    assert.equal(seen[0].text, pages[0]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].get('limit'), '1');
    assert.equal(requests[0].get('matchType'), 'domain');
    assert.equal(requests[0].get('showResumeKey'), 'true');
    assert.equal(requests[0].get('fl'), CDX_FIELDS.join(','));
    assert.equal(requests[0].get('resumeKey'), null);
    assert.equal(requests[1].get('resumeKey'), 'KEY-1');
  });

  it('an exact query sends no matchType; a bad one is refused before any request', async () => {
    assert.equal(new URL(cdxUrl({ url: 'http://example.org/', matchType: undefined })).searchParams.has('matchType'), false);
    await assert.rejects(cdxPages({ url: 'a', matchType: 'glob' }).next(), /matchType must be one of exact \| prefix \| host \| domain/);
    await assert.rejects(cdxPages({}).next(), /query\.url is required/);
  });
});
