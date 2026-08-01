/**
 * Handler-level serving-semantics tests (#249): hono's app.request() against
 * a MemoryStore — the full runtime-agnostic path both edge targets share,
 * zero network, zero vendor. Store impl seams (R2Store in store.test.ts, the
 * S3Store in s3store.test.ts) get their own suites.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { captureKey } from '../src/path.ts';
import { MemoryStore } from '../src/store.ts';
import type { Capture, CaptureMeta, Store } from '../src/store.ts';

const TS = '20140403040000';
const ORIGINAL = 'http://sudomakethought.com/post/123';
const PATH = `/${TS}/${ORIGINAL}`;
const ARCHIVE = `https://web.archive.org/web/${TS}/${ORIGINAL}`;

/** The standalone CSP served on HTML document responses (src/app.ts). */
const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'";

describe('createApp', () => {
  let store: MemoryStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new MemoryStore();
    app = createApp(store);
  });

  describe('index page', () => {
    it('serves a small explainer at /', async () => {
      const res = await app.request('/', { headers: { host: 'my-mirror.test' } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      const body = await res.text();
      assert.ok(body.includes('web.archive.org'));
    });

    it('renders the request Host (the mirror identity), not a hardcoded placeholder', async () => {
      // Single-host mode: the displayed host is the request's own Host header —
      // never the old `wayback.example.com` placeholder baked into the HTML.
      const body = await (await app.request('/', { headers: { host: 'my-mirror.test' } })).text();
      assert.ok(body.includes('<h1>my-mirror.test</h1>'));
      assert.ok(body.includes('<title>my-mirror.test · web.archive.org mirror</title>'));
      assert.ok(!body.includes('example.com'), 'no placeholder host may survive into the served page');
    });

    it('escapes a hostile Host header — no XSS from the attacker-controlled host (single-host)', async () => {
      // The Host header is attacker-controllable; interpolating it raw would be
      // reflected XSS. Prove escapeHtml neutralizes a breakout payload in BOTH
      // the index and the 404 served pages.
      const evilHost = 'evil"><script>alert(1)</script>';
      const idx = await (await app.request('/', { headers: { host: evilHost } })).text();
      assert.ok(!idx.includes('<script>alert(1)</script>'), 'hostile host must never render as live markup');
      assert.ok(idx.includes('evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), 'the host must be HTML-escaped');

      const miss = await (await app.request(PATH, { headers: { host: evilHost } })).text();
      assert.ok(!miss.includes('<script>alert(1)</script>'), 'the 404 must also escape the hostile host');
      assert.ok(miss.includes('evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    });
  });

  describe('served-page copy (#453)', () => {
    // The GENERIC, site-agnostic defaults baked into app.ts — the shipped base
    // case, naming no deployment. Duplicated here so a change to the wording is
    // a deliberate two-place edit.
    const DEFAULT_INDEX =
      'A self-hosted mirror of the <a href="https://web.archive.org/">Wayback Machine</a> ' +
      'captures that its source pages reference — exactly those, nothing more.';
    const DEFAULT_NOT_FOUND =
      'This mirror serves exactly the <a href="https://web.archive.org/">Wayback Machine</a> ' +
      'captures that its source pages reference. This capture is not among them.';

    it('renders the generic site-agnostic default when no copy is configured', async () => {
      // The default names NO specific deployment — "its source pages", not any
      // site — so the positive match on the generic wording is itself the proof
      // the base case is site-neutral (and this file names no deployment).
      const idx = await (await app.request('/', { headers: { host: 'm.test' } })).text();
      assert.ok(idx.includes(DEFAULT_INDEX), 'index carries the generic default about');

      const miss = await (await app.request(PATH, { headers: { host: 'm.test' } })).text();
      assert.ok(miss.includes(DEFAULT_NOT_FOUND), '404 carries the generic default about');
    });

    it('renders configured copy (raw HTML, links intact) on the index and 404', async () => {
      const copy = {
        index: 'A self-hosted mirror the <a href="https://example.test/">example</a> site keeps.',
        notFound: 'The <a href="https://example.test/">example</a> mirror does not hold this one.'
      };
      const withCopy = createApp(new MemoryStore(), { copy });

      const idx = await (await withCopy.request('/', { headers: { host: 'm.test' } })).text();
      assert.ok(idx.includes(`<p>${copy.index}</p>`), 'configured index copy is injected raw');
      assert.ok(!idx.includes(DEFAULT_INDEX), 'the default is replaced, not appended');

      const miss = await (await withCopy.request(PATH, { headers: { host: 'm.test' } })).text();
      assert.ok(miss.includes(`<p>${copy.notFound}</p>`), 'configured 404 copy is injected raw');
      assert.ok(!miss.includes(DEFAULT_NOT_FOUND));
    });

    it('injects copy raw (TRUSTED site config) while the host stays escaped', async () => {
      // copy is TRUSTED — its <a> markup renders live. The host is NOT — a
      // hostile Host header is still escaped even alongside configured copy, so
      // the raw-copy path never becomes an escaping bypass for the host.
      const copy = { index: 'trusted <a href="https://ok.test/">link</a> lives' };
      const withCopy = createApp(new MemoryStore(), { copy });
      const evilHost = 'evil"><script>alert(1)</script>';
      const idx = await (await withCopy.request('/', { headers: { host: evilHost } })).text();
      // The copy's anchor survives as live markup...
      assert.ok(idx.includes('trusted <a href="https://ok.test/">link</a> lives'));
      // ...but the attacker-controlled host is still neutralized.
      assert.ok(!idx.includes('<script>alert(1)</script>'), 'host must never render as live markup');
      assert.ok(idx.includes('evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    });
  });

  describe('cache hit', () => {
    it('serves the stored body with content-type, immutable cache, the standalone CSP, and provenance headers', async () => {
      store.put(captureKey(TS, ORIGINAL), '<html><body><h1>archived</h1></body></html>', 'text/html; charset=utf-8');

      const res = await app.request(PATH);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
      assert.equal(res.headers.get('x-wayback-source'), ARCHIVE);
      assert.ok((await res.text()).includes('<h1>archived</h1>'));
    });

    it('carries nothing of ours in the body: no attribution banner, no marker markup (#361)', async () => {
      store.put(captureKey(TS, ORIGINAL), '<html><body><h1>archived</h1></body></html>', 'text/html; charset=utf-8');

      const body = await (await app.request(PATH)).text();
      // Capture bytes carry nothing of ours — provenance rides the header, not
      // the page. Visible attribution is #320's chrome.
      assert.ok(!body.includes('wayback-charlie-dev-attribution'));
      assert.ok(!body.includes('archive.org'));
      // The stored bytes minus archive chrome — the page itself, untouched.
      assert.equal(body, '<html><body><h1>archived</h1></body></html>');
    });

    it('passes non-HTML bodies through byte-for-byte, with no document CSP', async () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
      const key = captureKey(TS, 'http://example.com/pixel.gif');
      store.put(key, bytes, 'image/gif');

      const res = await app.request(`/${TS}/http://example.com/pixel.gif`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/gif');
      assert.equal(res.headers.get('content-security-policy'), null);
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
    });

    it('resolves flagged requests (if_/id_) to the same flagless capture key', async () => {
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');

      const res = await app.request(`/${TS}if_/${ORIGINAL}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-wayback-source'), ARCHIVE);
    });

    it('keeps the original URL query string in the capture identity', async () => {
      const queried = 'http://example.com/d.aspx?displaylang=en&id=9';
      store.put(captureKey(TS, queried), 'ok', 'text/plain');

      const res = await app.request(`/${TS}/${queried}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    });

    it('answers HEAD from store metadata without a body', async () => {
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');

      const res = await app.request(PATH, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      // The document CSP is uniform: HEAD carries it too (no body to strip).
      assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
      assert.equal(await res.text(), '');
    });
  });

  describe('/web/-prefixed requests (replay-shaped requisite paths)', () => {
    it('serves the same capture for the /web/-prefixed spelling', async () => {
      const key = captureKey(TS, 'http://example.com/logo.gif');
      store.put(key, new Uint8Array([0x47, 0x49, 0x46]), 'image/gif');

      const res = await app.request(`/web/${TS}im_/http://example.com/logo.gif`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/gif');
    });

    it('answers a local 404 (no-store) on a /web/-prefixed requisite miss (strict default)', async () => {
      const res = await app.request(`/web/${TS}cs_/http://example.com/site.css`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('location'), null);
    });
  });

  describe('serve-time HTML transform wiring', () => {
    it('strips archive chrome from text/html hits and injects nothing (#361)', async () => {
      store.put(
        captureKey(TS, ORIGINAL),
        '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">chrome</div>' +
          '<!-- END WAYBACK TOOLBAR INSERT --><h1>page</h1></body></html>',
        'text/html'
      );

      const html = await (await app.request(PATH)).text();
      assert.ok(!html.includes('wm-ipp'));
      assert.ok(!html.includes('WAYBACK TOOLBAR INSERT'));
      assert.ok(html.includes('<h1>page</h1>'));
      // No banner, no marker markup — the transform only strips chrome now.
      assert.ok(!html.includes('wayback-charlie-dev-attribution'));
    });
  });

  describe('status discriminators (cache-root bodiless entries)', () => {
    /** A Store whose entries carry statuses, the way FsStore's do. */
    class StatusStore implements Store {
      #entries = new Map<string, CaptureMeta | Capture>();
      set(key: string, entry: CaptureMeta | Capture): void {
        this.#entries.set(key, entry);
      }
      async head(key: string): Promise<CaptureMeta | null> {
        const entry = this.#entries.get(key);
        if (entry === undefined) return null;
        const { contentType, size, status } = entry;
        return { contentType, ...(size === undefined ? {} : { size }), ...(status === undefined ? {} : { status }) };
      }
      async get(key: string): Promise<Capture | CaptureMeta | null> {
        return this.#entries.get(key) ?? null;
      }
    }

    let statusStore: StatusStore;
    beforeEach(() => {
      statusStore = new StatusStore();
      app = createApp(statusStore);
    });

    it('empty → 200 with no body (a real archived zero-byte 200, served as exactly that)', async () => {
      statusStore.set(captureKey(TS, ORIGINAL), { contentType: 'text/html', status: 'empty' });

      const res = await app.request(PATH);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      // A zero-byte HTML document still carries the standalone CSP.
      assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
      assert.equal(await res.text(), '');
    });

    it('redirect → local 404 no-store under strict (no bounce to live; #361)', async () => {
      statusStore.set(captureKey(TS, ORIGINAL), { contentType: '', status: 'redirect' });

      const res = await app.request(`/${TS}im_/${ORIGINAL}`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('location'), null);
    });

    it('error → 404 no-store (the archive permanently lacks this capture; never a bounce)', async () => {
      statusStore.set(captureKey(TS, ORIGINAL), { contentType: '', status: 'error' });

      const res = await app.request(PATH);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('interstitial → local 404 no-store under strict (a refused wayback fluff page, never served; #363)', async () => {
      // #363: the entry is complete but holds no servable content. Strict
      // refuses to bounce to live, so a local 404 is the honest answer — the
      // same graceful-degradation path a miss takes (liveFallback replays it).
      statusStore.set(captureKey(TS, ORIGINAL), { contentType: 'text/html', status: 'interstitial' });

      const res = await app.request(`/${TS}im_/${ORIGINAL}`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('location'), null);
    });

    it('statuses answer HEAD identically', async () => {
      statusStore.set(captureKey(TS, ORIGINAL), { contentType: '', status: 'error' });
      assert.equal((await app.request(PATH, { method: 'HEAD' })).status, 404);
    });
  });

  describe('cache miss — strict is the default (#361)', () => {
    it('answers a styled local 404, no-store, no redirect to live', async () => {
      const res = await app.request(PATH);
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
      assert.equal(res.headers.get('location'), null);
      const body = await res.text();
      assert.ok(body.includes('Not mirrored'));
      // Self-contained: zero external references in the 404 body itself.
      assert.ok(!body.includes('src='));
      assert.ok(!body.includes('<script'));
    });

    it('a requisite miss is also a local 404 (flags do not change the answer)', async () => {
      const res = await app.request(`/${TS}im_/${ORIGINAL}`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('location'), null);
    });
  });

  describe('cache miss — with { liveFallback: true } (opt-in, restores the old 302)', () => {
    let liveApp: ReturnType<typeof createApp>;
    beforeEach(() => {
      liveApp = createApp(store, { liveFallback: true });
    });

    it('302s to the corresponding web.archive.org capture, but never caches it', async () => {
      const res = await liveApp.request(PATH);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), ARCHIVE);
      // The 302 loses its max-age — cache poisoning ends even under fallback.
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('preserves replay flags on the redirect (asset semantics survive degradation)', async () => {
      const res = await liveApp.request(`/${TS}im_/${ORIGINAL}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `https://web.archive.org/web/${TS}im_/${ORIGINAL}`);
    });

    it('a redirect-status entry replays at the archive under fallback', async () => {
      // A redirect entry has no local body; under fallback it 302s to the archive.
      const redirectStore: Store = {
        head: async () => ({ contentType: '', status: 'redirect' }),
        get: async () => ({ contentType: '', status: 'redirect' })
      };
      const res = await createApp(redirectStore, { liveFallback: true }).request(`/${TS}im_/${ORIGINAL}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `https://web.archive.org/web/${TS}im_/${ORIGINAL}`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('an interstitial-status entry bounces to the archive under fallback (#363)', async () => {
      // An interstitial entry holds no servable content (a refused wayback
      // fluff page); under fallback it 302s to the archive, like a miss.
      const interstitialStore: Store = {
        head: async () => ({ contentType: 'text/html', status: 'interstitial' }),
        get: async () => ({ contentType: 'text/html', status: 'interstitial' })
      };
      const res = await createApp(interstitialStore, { liveFallback: true }).request(`/${TS}im_/${ORIGINAL}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `https://web.archive.org/web/${TS}im_/${ORIGINAL}`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });

  describe('non-capture paths', () => {
    for (const path of ['/favicon.ico', '/not/a/capture', '/123/http://example.com/']) {
      it(`404s ${path}`, async () => {
        const res = await app.request(path);
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      });
    }
  });
});
