// Interstitial detection tests (#363) — pure, offline. Every signature is
// exercised against a synthetic-but-faithful body (test/fixtures/interstitial/*)
// or a metadata shape; the id_ refetch runs against an injected fetch, never
// the wire.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTERSTITIAL_SIGNATURES,
  classifyEntry,
  detectInterstitial,
  idRefetchUrl,
  refetchRaw
} from '../interstitial.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures/interstitial');
const WRAPPER = fs.readFileSync(path.join(FIX, 'wrapper-stub.html'), 'utf8');
const REDIRECT = fs.readFileSync(path.join(FIX, 'redirect-interstitial.html'), 'utf8');
const bytes = s => new TextEncoder().encode(s);

describe('detectInterstitial — signatures', () => {
  it('wrapper-stub: <title>Wayback Machine</title> + id="playback" iframe', () => {
    const d = detectInterstitial({ key: '20140403040000/http://example.com/report.pdf', contentType: 'text/html', body: bytes(WRAPPER) });
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.wrapperStub);
    assert.equal(d.target, undefined, 'wrapper stubs carry no decoded target');
  });

  it('redirect-interstitial: setTimeout(go, 5000) + navbar chrome, with the target decoded', () => {
    const d = detectInterstitial({ key: '20140403040000/http://example.com/old', contentType: 'text/html; charset=utf-8', body: bytes(REDIRECT) });
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.redirectInterstitial);
    assert.deepEqual(d.target, { url: 'http://example.com/moved-here', timestamp: '20140403040000' });
  });

  it('redirect-interstitial accepts a body handed in as a string, not just bytes', () => {
    const d = detectInterstitial({ contentType: 'text/html', body: REDIRECT });
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.redirectInterstitial);
  });

  it('extension-mismatch: .pdf / .txt stored as text/html — no body needed', () => {
    for (const ext of ['report.pdf', 'notes.txt', 'DATA.PDF']) {
      const d = detectInterstitial({ key: `20140403040000/http://example.com/${ext}`, contentType: 'text/html' });
      assert.equal(d.signature, INTERSTITIAL_SIGNATURES.extensionMismatch, ext);
    }
  });

  it('extension-mismatch ignores a query/fragment when reading the extension', () => {
    const d = detectInterstitial({ key: '20140403040000/http://example.com/report.pdf?download=1#page=2', contentType: 'text/html' });
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.extensionMismatch);
  });

  it('archived-error: an injected CDX 4xx/5xx statuscode fires without any body', () => {
    assert.equal(detectInterstitial({ cdxStatus: '404' }).signature, INTERSTITIAL_SIGNATURES.archivedError);
    assert.equal(detectInterstitial({ cdxStatus: 503 }).signature, INTERSTITIAL_SIGNATURES.archivedError);
    assert.equal(detectInterstitial({ cdxStatus: '200' }), null, 'a clean statuscode is not an interstitial');
    assert.equal(detectInterstitial({ cdxStatus: '301' }), null, 'a 3xx capture is a redirect, not an error');
  });

  it('the CDX signature takes precedence over content signatures', () => {
    const d = detectInterstitial({ key: '2014/http://x/a.pdf', contentType: 'text/html', body: bytes(WRAPPER), cdxStatus: '404' });
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.archivedError);
  });
});

describe('detectInterstitial — the false-positive posture', () => {
  it('a real HTML article is NOT an interstitial', () => {
    const real = '<!DOCTYPE html><html><head><title>Scaling Isomorphic JS</title></head><body><h1>Real content</h1><p>...</p></body></html>';
    assert.equal(detectInterstitial({ key: '2011/http://example.com/post', contentType: 'text/html', body: bytes(real) }), null);
  });

  it('a .pdf served with a NON-html content-type is fine (the bytes are the asset)', () => {
    assert.equal(detectInterstitial({ key: '2014/http://x/report.pdf', contentType: 'application/pdf' }), null);
    assert.equal(detectInterstitial({ key: '2014/http://x/report.pdf', contentType: '' }), null, 'unknown type is not a mismatch');
  });

  it('a .jpg served as text/html is NOT flagged — the named set is .pdf/.txt only', () => {
    // The committed corpus fixture ships exactly this shape as a real body; the
    // narrow extension set keeps it from being a false positive.
    assert.equal(detectInterstitial({ key: '19981202230410/http://www.google.com/alpha.jpg', contentType: 'text/html' }), null);
  });

  it('a page with a lone setTimeout(...,5000) but no archive chrome is NOT a redirect interstitial', () => {
    const html = '<html><body><script>setTimeout(go, 5000)</script></body></html>';
    assert.equal(detectInterstitial({ contentType: 'text/html', body: bytes(html) }), null);
  });

  it('binary bytes under a non-html content-type are never scanned', () => {
    assert.equal(detectInterstitial({ key: '2014/http://x/i.png', contentType: 'image/png', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }), null);
  });
});

describe('classifyEntry — report-first path for the #364 sweep', () => {
  it('classifies an existing entry from its sidecar + body, committing nothing', () => {
    const sidecar = { key: '20140403040000/http://example.com/report.pdf', contentType: 'text/html' };
    const d = classifyEntry(sidecar, bytes(WRAPPER));
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.wrapperStub);
  });

  it('forwards an injected cdxStatus', () => {
    const d = classifyEntry({ key: '2014/http://x/', contentType: 'text/html' }, null, { cdxStatus: '410' });
    assert.equal(d.signature, INTERSTITIAL_SIGNATURES.archivedError);
  });
});

describe('id_ refetch — the wrapper-stub remediation primitive', () => {
  it('builds the id_ replay URL for a capture key', () => {
    assert.equal(
      idRefetchUrl('20140403040000/http://example.com/report.pdf'),
      'https://web.archive.org/web/20140403040000id_/http://example.com/report.pdf'
    );
  });

  it('rejects a non-capture-key', () => {
    assert.throws(() => idRefetchUrl('not-a-key'), /not a capture key/);
    assert.throws(() => idRefetchUrl('20140403040000/'), /not a capture key/);
  });

  it('fetches raw bytes through an INJECTED fetch (no live network)', async () => {
    const raw = bytes('%PDF-1.4 the real asset bytes');
    const calls = [];
    const fetchImpl = async url => {
      calls.push(url);
      return {
        status: 200,
        headers: { get: h => (h === 'content-type' ? 'application/pdf' : null) },
        arrayBuffer: async () => raw.slice().buffer
      };
    };
    const out = await refetchRaw('20140403040000/http://example.com/report.pdf', { fetch: fetchImpl });
    assert.deepEqual(calls, ['https://web.archive.org/web/20140403040000id_/http://example.com/report.pdf']);
    assert.equal(out.status, 200);
    assert.equal(out.contentType, 'application/pdf');
    assert.deepEqual(out.body, raw);
  });

  it('a non-200 refetch returns a null body (the caller decides what it means)', async () => {
    const fetchImpl = async () => ({ status: 404, headers: { get: () => null } });
    const out = await refetchRaw('20140403040000/http://example.com/report.pdf', { fetch: fetchImpl });
    assert.equal(out.status, 404);
    assert.equal(out.body, null);
  });

  it('requires an injected fetch', async () => {
    await assert.rejects(() => refetchRaw('2014/http://x/', {}), /fetch is required/);
  });
});
