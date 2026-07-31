/**
 * Serve-time discovery options (design §D3): the `localize` corpus rewrite, the
 * `cspMode` header posture, and the corpus key-set walker they stand on.
 *
 * - localize: a served text dialect (html/css/js) has its wayback references
 *   rewritten to root-relative form — but ONLY for references whose capture key
 *   is in the supplied set; a reference the mirror cannot satisfy stays foreign.
 *   The rewrite runs over a LOSSLESS latin1 byte↔char mapping, so a non-UTF-8
 *   capture (ISO-8859-1 page, a UTF-8 BOM, binary-ish JS) is byte-exact.
 * - cspMode: 'report-only' emits Content-Security-Policy-Report-Only (same
 *   policy) instead of Content-Security-Policy, at both CSP call sites.
 * - default posture is unchanged: no localize, CSP enforced, html chrome-stripped.
 * - loadCorpusKeySet: one meta-walk → the Set localize rewrites against;
 *   defensive (a bad sidecar is skipped, never a boot abort).
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { loadCorpusKeySet } from '../src/corpus.ts';
import { captureKey } from '../src/path.ts';
import { MemoryStore } from '../src/store.ts';

const TS = '20140403040000';

/** The standalone CSP, spelled once for the header-posture assertions. */
const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'";

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));

describe('localize — serve-time reference localization', () => {
  const DOC_KEY = captureKey(TS, 'http://example.com/');
  const HELD = 'http://example.com/other'; //     in the corpus → localized
  const FOREIGN = 'http://example.com/foreign.gif'; // absent → stays foreign
  const HELD_KEY = captureKey(TS, HELD);

  it('rewrites an absolute wayback ref whose key is in the set, and leaves a foreign ref alone (HTML)', async () => {
    const store = new MemoryStore();
    store.put(
      DOC_KEY,
      `<html><body>` +
        `<a href="https://web.archive.org/web/${TS}/${HELD}">held</a>` +
        `<img src="https://web.archive.org/web/${TS}/${FOREIGN}">` +
        `</body></html>`,
      'text/html'
    );
    const app = createApp(store, { localize: new Set([HELD_KEY]) });

    const body = await (await app.request(`/${TS}/http://example.com/`)).text();
    // The held ref sheds its host → root-relative (resolves against this mirror).
    assert.ok(body.includes(`href="/web/${TS}/${HELD}"`));
    // The foreign ref (no capture) is left byte-for-byte absolute.
    assert.ok(body.includes(`src="https://web.archive.org/web/${TS}/${FOREIGN}"`));
  });

  it('localizes a CSS body (which passes through untouched without localize)', async () => {
    const CSS_KEY = captureKey(TS, 'http://example.com/site.css');
    const BG = 'http://example.com/bg.png';
    const BG_KEY = captureKey(TS, BG);
    const css = `body { background: url(https://web.archive.org/web/${TS}/${BG}); }`;
    const store = new MemoryStore();
    store.put(CSS_KEY, css, 'text/css');
    const app = createApp(store, { localize: new Set([BG_KEY]) });

    const body = await (await app.request(`/${TS}/http://example.com/site.css`)).text();
    assert.ok(body.includes(`url(/web/${TS}/${BG})`));
    assert.ok(!body.includes('web.archive.org'));
  });

  it('does not double-strip: an HTML hit under localize still has its chrome removed', async () => {
    const store = new MemoryStore();
    store.put(
      DOC_KEY,
      `<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">chrome</div>` +
        `<!-- END WAYBACK TOOLBAR INSERT --><h1>page</h1></body></html>`,
      'text/html'
    );
    const app = createApp(store, { localize: new Set<string>() });

    const body = await (await app.request(`/${TS}/http://example.com/`)).text();
    assert.ok(!body.includes('wm-ipp'));
    assert.ok(!body.includes('WAYBACK TOOLBAR INSERT'));
    assert.ok(body.includes('<h1>page</h1>'));
  });
});

describe('localize — latin1 byte fidelity (no UTF-8 transcode corruption)', () => {
  /** Encode a latin1 string to its exact bytes (TextEncoder is UTF-8-only). */
  const latin1Bytes = (s: string): Uint8Array => Uint8Array.from(s, ch => ch.charCodeAt(0) & 0xff);
  /** A raw 0xA0 byte (NBSP in latin1) — U+FFFD if a UTF-8 round-trip touched it. */
  const NBSP = String.fromCharCode(0xa0);

  it('rewrites a CSS ref AND preserves a latin1 (0xA0) byte byte-exact', async () => {
    const CSS_KEY = captureKey(TS, 'http://example.com/site.css');
    const BG = 'http://example.com/bg.png';
    const BG_KEY = captureKey(TS, BG);
    // A raw 0xA0 byte inside a comment, plus a localizable ref: the ref must be
    // rewritten AND the 0xA0 must survive. A UTF-8 round-trip fails both halves
    // (0xA0 → EF BF BD), which is the corruption this guards.
    const cssIn = `/*${NBSP}*/a{background:url(https://web.archive.org/web/${TS}/${BG})}`;
    const store = new MemoryStore();
    store.put(CSS_KEY, latin1Bytes(cssIn), 'text/css');
    const app = createApp(store, { localize: new Set([BG_KEY]) });

    const res = await app.request(`/${TS}/http://example.com/site.css`);
    const got = new Uint8Array(await res.arrayBuffer());
    const expected = latin1Bytes(`/*${NBSP}*/a{background:url(/web/${TS}/${BG})}`);
    assert.deepEqual(got, expected);
    // The raw 0xA0 byte survived (would be absent — replaced by EF BF BD — under
    // a UTF-8 round-trip).
    assert.ok(got.includes(0xa0));
  });

  it('preserves a UTF-8 BOM byte-exact when the corpus changes nothing (codex case)', async () => {
    const JS_KEY = captureKey(TS, 'http://example.com/app.js');
    // EF BB BF (BOM) + ascii. Empty corpus → rewrite() is a no-op, so the served
    // bytes must equal the input EXACTLY (BOM not stripped, no transcode).
    const input = new Uint8Array([0xef, 0xbb, 0xbf, ...latin1Bytes('var wm = 1;')]);
    const store = new MemoryStore();
    store.put(JS_KEY, input, 'text/javascript');
    const app = createApp(store, { localize: new Set<string>() });

    const res = await app.request(`/${TS}/http://example.com/app.js`);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), input);
  });
});

describe('cspMode — report-only header posture', () => {
  const DOC_KEY = captureKey(TS, 'http://example.com/');

  it("emits Content-Security-Policy-Report-Only (and NOT Content-Security-Policy) on an HTML hit and a 404", async () => {
    const store = new MemoryStore();
    store.put(DOC_KEY, '<html><body><h1>x</h1></body></html>', 'text/html');
    const app = createApp(store, { cspMode: 'report-only' });

    const hit = await app.request(`/${TS}/http://example.com/`);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('content-security-policy-report-only'), DOCUMENT_CSP);
    assert.equal(hit.headers.get('content-security-policy'), null);

    const miss = await app.request(`/${TS}/http://example.com/absent`, { redirect: 'manual' });
    assert.equal(miss.status, 404);
    assert.equal(miss.headers.get('content-security-policy-report-only'), DOCUMENT_CSP);
    assert.equal(miss.headers.get('content-security-policy'), null);
  });
});

describe('defaults unchanged — no localize, CSP enforced', () => {
  const DOC_KEY = captureKey(TS, 'http://example.com/');

  it('an HTML hit is chrome-stripped but NOT localized, CSP under Content-Security-Policy', async () => {
    const HELD = 'http://example.com/other';
    const store = new MemoryStore();
    store.put(
      DOC_KEY,
      `<html><body><a href="https://web.archive.org/web/${TS}/${HELD}">held</a>` +
        `<!-- BEGIN WAYBACK TOOLBAR INSERT -->x<!-- END WAYBACK TOOLBAR INSERT --></body></html>`,
      'text/html'
    );
    const app = createApp(store); // default options

    const res = await app.request(`/${TS}/http://example.com/`);
    assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
    assert.equal(res.headers.get('content-security-policy-report-only'), null);
    const body = await res.text();
    // Chrome stripped...
    assert.ok(!body.includes('WAYBACK TOOLBAR INSERT'));
    // ...but the wayback ref is left foreign — no localize, no rewrite.
    assert.ok(body.includes(`href="https://web.archive.org/web/${TS}/${HELD}"`));
  });

  it('a CSS body passes through byte-for-byte with no localize', async () => {
    const CSS_KEY = captureKey(TS, 'http://example.com/site.css');
    const css = `body { background: url(https://web.archive.org/web/${TS}/http://example.com/bg.png); }`;
    const store = new MemoryStore();
    store.put(CSS_KEY, css, 'text/css');
    const app = createApp(store);

    assert.equal(await (await app.request(`/${TS}/http://example.com/site.css`)).text(), css);
  });
});

describe('loadCorpusKeySet — the meta-walk', () => {
  it('collects the capture keys held under a cache-root (committed fixture)', async () => {
    const keys = await loadCorpusKeySet(FIXTURE_ROOT);
    assert.ok(keys.size > 0);
    // Known committed entries (their sidecars carry these keys).
    assert.ok(keys.has('20140403040000/http://example.com/'));
    assert.ok(keys.has('19981202230410/http://www.google.com/'));
    // The orphan cap/ file has NO sidecar, so its key is never collected.
    assert.ok(!keys.has('20140403040000/http://example.com/orphan'));
  });

  it('is defensive: a single unparseable sidecar is skipped, not a boot abort', async () => {
    const root = await fsp.mkdtemp(`${os.tmpdir()}/wayback-corpus-`);
    try {
      await fsp.mkdir(`${root}/meta/aa`, { recursive: true });
      await fsp.writeFile(`${root}/meta/aa/good.json`, JSON.stringify({ v: 1, key: '20140403040000/http://example.com/good' }));
      await fsp.writeFile(`${root}/meta/aa/broken.json`, '{ not json');
      await fsp.writeFile(`${root}/meta/aa/keyless.json`, JSON.stringify({ v: 1 })); // no .key
      await fsp.writeFile(`${root}/meta/aa/notjson.txt`, 'ignored');

      const keys = await loadCorpusKeySet(root);
      assert.deepEqual([...keys], ['20140403040000/http://example.com/good']);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('a root with no meta/ dir yields an empty set (localizes nothing)', async () => {
    const root = await fsp.mkdtemp(`${os.tmpdir()}/wayback-corpus-empty-`);
    try {
      const keys = await loadCorpusKeySet(root);
      assert.equal(keys.size, 0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
