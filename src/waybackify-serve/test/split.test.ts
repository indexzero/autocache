/**
 * The chrome/content split (#320): Host-keyed serving inside the
 * runtime-agnostic app. Driven exactly like app.test.ts — app.request()
 * against a MemoryStore (and a THROWING spy store to prove the chrome host
 * never reaches storage) — so every #320 recipe claim this code depends on is
 * asserted locally, zero network, zero DNS.
 *
 * The two hostnames under test are placeholder split hosts (#320):
 *   chrome  → wayback.example.com   (attribution UI + iframe shell)
 *   content → content.example.net   (sacrificial usercontent origin)
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, validateSplit, type SplitOptions } from '../src/app.ts';
import { createCloudflareHandler } from '../src/cloudflare.ts';
import { captureKey } from '../src/path.ts';
import { MemoryStore } from '../src/store.ts';
import type { Capture, CaptureMeta, Store } from '../src/store.ts';

const CHROME = 'wayback.example.com';
const CONTENT = 'content.example.net';
const SPLIT: SplitOptions = { chromeHost: CHROME, contentHost: CONTENT };

const TS = '20140403040000';
const ORIGINAL = 'http://sudomakethought.com/post/123';
const PATH = `/${TS}/${ORIGINAL}`;

/** The standalone document CSP (src/app.ts). Carries `form-action 'self'`. */
const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'";

/**
 * The content-origin document CSP: standalone + frame-ancestors, one header.
 * `frame-ancestors` names ONLY the chrome origin (no `'self'`) — a content
 * capture may not frame a sibling capture on the sacrificial origin.
 */
const CONTENT_CSP = `${DOCUMENT_CSP}; frame-ancestors https://${CHROME}`;

/** Full URLs so `new URL(c.req.url).host` resolves to the intended Host. */
const chromeUrl = (path = PATH) => `https://${CHROME}${path}`;
const contentUrl = (path = PATH) => `https://${CONTENT}${path}`;

/** A Store whose every method throws — the chrome host must never call it. */
class ThrowingStore implements Store {
  async head(): Promise<CaptureMeta | null> {
    throw new Error('chrome host reached the store.head() — capture bytes must never be served on the chrome origin');
  }
  async get(): Promise<Capture | CaptureMeta | null> {
    throw new Error('chrome host reached the store.get() — capture bytes must never be served on the chrome origin');
  }
}

describe('chrome/content split (#320)', () => {
  describe('content host — serves capture bytes with frame-ancestors', () => {
    let store: MemoryStore;
    let app: ReturnType<typeof createApp>;
    beforeEach(() => {
      store = new MemoryStore();
      app = createApp(store, { split: SPLIT });
    });

    it('an HTML hit carries exactly the standalone CSP + frame-ancestors, merged into one header', async () => {
      store.put(captureKey(TS, ORIGINAL), '<html><body><h1>archived</h1></body></html>', 'text/html; charset=utf-8');
      const res = await app.request(contentUrl());
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      // frame-ancestors names EXACTLY the chrome origin — no 'self' (a content
      // capture must not frame a sibling capture on the sacrificial origin).
      assert.ok((res.headers.get('content-security-policy') ?? '').includes(`frame-ancestors https://${CHROME}`));
      assert.ok(!(res.headers.get('content-security-policy') ?? '').includes(`frame-ancestors 'self'`));
      assert.ok((await res.text()).includes('<h1>archived</h1>'));
    });

    it('never emits X-Frame-Options (archived XFO cannot replay; frame-ancestors is the policy)', async () => {
      store.put(captureKey(TS, ORIGINAL), '<html><body>x</body></html>', 'text/html');
      const res = await app.request(contentUrl());
      assert.equal(res.headers.get('x-frame-options'), null);
    });

    it('still serves the provenance header and immutable cache on a hit', async () => {
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');
      const res = await app.request(contentUrl());
      assert.equal(res.headers.get('x-wayback-source'), `https://web.archive.org/web/${TS}/${ORIGINAL}`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    it('passes non-HTML bodies through byte-for-byte, and still carries the frame-ancestors CSP (origin-wide contract)', async () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      store.put(captureKey(TS, 'http://example.com/pixel.gif'), bytes, 'image/gif');
      const res = await app.request(contentUrl(`/${TS}/http://example.com/pixel.gif`));
      assert.equal(res.status, 200);
      // #320 step 1 is origin-wide — EVERY content response carries
      // frame-ancestors. Harmless on an inert image (document CSP is not
      // enforced on a subresource); the bytes pass through unchanged.
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      assert.equal(res.headers.get('x-frame-options'), null);
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
    });

    it('a PDF (framable document) also carries the frame-ancestors CSP', async () => {
      store.put(captureKey(TS, 'http://example.com/doc.pdf'), new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'application/pdf');
      const res = await app.request(contentUrl(`/${TS}/http://example.com/doc.pdf`));
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
    });

    it('a Content-Type with leading whitespace is normalized before classification (no CSP bypass)', async () => {
      // Headers strips the OWS, so the browser sees executable `text/html`; the
      // CSP classification must see the same, or the frame-ancestors is missing.
      store.put(captureKey(TS, 'http://example.com/x'), '<script>1</script>', ' text/html; charset=utf-8');
      const res = await app.request(contentUrl(`/${TS}/http://example.com/x`));
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
    });

    it('a content miss (rendered in-frame) still carries the frame-ancestors CSP', async () => {
      const res = await app.request(contentUrl());
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      // The 404 is shown inside the chrome iframe, so it too must permit framing.
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      assert.equal(res.headers.get('x-frame-options'), null);
    });
  });

  describe('chrome host — serves the iframe shell, NEVER capture bytes', () => {
    it('a capture request never touches the store (throwing spy store stays untouched)', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      // If the chrome path reached the store, ThrowingStore would throw and
      // Hono would surface a 500 — a 200 here proves it never did.
      const res = await app.request(chromeUrl());
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    });

    it('the shell contains no capture bytes even when the store HAS the capture', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<html><body>SECRET_CAPTURE_BODY</body></html>', 'text/html');
      const app = createApp(store, { split: SPLIT });
      const body = await (await app.request(chromeUrl())).text();
      assert.ok(!body.includes('SECRET_CAPTURE_BODY'));
    });

    it('embeds a sandboxed iframe with EXACTLY the #320 tokens and NOT allow-top-navigation', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(chromeUrl())).text();
      assert.ok(body.includes('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"'));
      assert.ok(!body.includes('allow-top-navigation'));
    });

    it('points the iframe src at the content origin, same path (a pure host swap)', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(chromeUrl())).text();
      assert.ok(body.includes(`src="https://${CONTENT}${PATH}"`));
    });

    it('the attribution header names the original, a SHORT capture date, and the archive + donate links', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(chromeUrl())).text();
      // The original URL links to its canonical archive capture.
      assert.ok(body.includes(`Archived mirror of <a href="https://web.archive.org/web/${TS}/${ORIGINAL}" rel="noreferrer">${ORIGINAL}</a> (web.archive.org)`));
      // The wayback timestamp is rendered human-short, not the raw 14 digits.
      assert.ok(body.includes('captured on Apr 3 2014 by'), 'short date "Apr 3 2014", not the raw timestamp');
      assert.ok(!body.includes(`captured on ${TS}`), 'the raw timestamp is NOT shown');
      // Both named links: the archive credit and the donation ask.
      assert.ok(body.includes('<a href="https://web.archive.org/" rel="noreferrer">The Internet Archive</a>'));
      assert.ok(body.includes('<a href="https://archive.org/donate/" rel="noreferrer">Donate</a> to keep knowledge free.'));
    });

    it('carries a locked-down chrome CSP: frames only the content origin, no scripts, unframeable', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const res = await app.request(chromeUrl());
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes(`frame-src https://${CONTENT}`));
      assert.ok(csp.includes("default-src 'self'"));
      // v1 shell is script-free: no script executes on the chrome origin, not
      // even same-origin (default-src 'self' alone would permit that).
      assert.ok(csp.includes("script-src 'none'"));
      assert.ok(csp.includes("object-src 'none'"));
      // The shell has no legitimate embedder — refuse framing (anti-clickjacking).
      assert.ok(csp.includes("frame-ancestors 'self'"));
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('an attacker-controlled capture URL cannot break out onto the chrome origin', async () => {
      // A path crafted to break out of the iframe src attribute. Two layers
      // defend the trusted chrome origin: (1) the WHATWG URL parser
      // percent-encodes `"`, `<`, `>` in the pathname before they ever reach
      // the template, and (2) escapeHtml is the belt-and-suspenders second
      // layer (asserted separately below).
      const evil = `/${TS}/http://evil.example/"><script>alert(1)</script>`;
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(chromeUrl(evil))).text();
      // The injected script never appears as live markup.
      assert.ok(!body.includes('<script>alert(1)</script>'));
      // The dangerous chars are percent-encoded in the rendered attribute, so
      // the iframe src attribute is not broken open.
      assert.ok(body.includes('%22%3E%3Cscript%3E'));
    });

    it('escapeHtml neutralizes a raw & from the original URL (defense in depth)', async () => {
      // The query string of the original URL carries literal `&`, which reaches
      // the template un-percent-encoded — escapeHtml MUST turn it into &amp;
      // (both valid HTML and the guarantee that the escaper is live).
      const queried = `/${TS}/http://example.com/d.aspx?a=1&b=2`;
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(chromeUrl(queried))).text();
      assert.ok(body.includes('a=1&amp;b=2'));
      assert.ok(!body.includes('a=1&b=2'));
    });

    it('answers HEAD on a capture path with headers and an empty body', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const res = await app.request(chromeUrl(), { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(await res.text(), '');
    });

    it('a non-capture path on the chrome host is a 404 under the LOCKED chrome CSP (not the unsafe-inline document CSP)', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const res = await app.request(`https://${CHROME}/favicon.ico`);
      assert.equal(res.status, 404);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("script-src 'none'"));
      // The document CSP's `script-src 'self' 'unsafe-inline'` must NOT reach
      // the chrome origin — no inline/same-origin script executes here.
      assert.ok(!csp.includes("script-src 'self'"));
    });

    it('the chrome index (/) serves the attribution UI under the locked chrome CSP', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const res = await app.request(`https://${CHROME}/`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('wayback.example.com'));
      assert.ok((res.headers.get('content-security-policy') ?? '').includes("script-src 'none'"));
    });
  });

  describe('served pages name the configured chrome host, not a placeholder (#453)', () => {
    it('the chrome index title + heading show the configured chrome host', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(`https://${CHROME}/`)).text();
      assert.ok(body.includes(`<title>${CHROME} · web.archive.org mirror</title>`));
      assert.ok(body.includes(`<h1>${CHROME}</h1>`));
    });

    it('the capture shell title names the chrome host', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const body = await (await app.request(chromeUrl())).text();
      assert.ok(body.includes(`· ${CHROME} · web.archive.org mirror</title>`));
    });

    it('a content-origin miss 404 still names the chrome host (the mirror identity)', async () => {
      // Even a miss rendered in-frame on the content origin displays the mirror's
      // canonical identity — the configured CHROME host, not the content host.
      const app = createApp(new MemoryStore(), { split: SPLIT });
      const body = await (await app.request(contentUrl())).text();
      assert.ok(body.includes(`Not mirrored · ${CHROME} · web.archive.org mirror`));
      assert.ok(!body.includes(CONTENT), 'the content host is NOT the displayed mirror identity');
    });
  });

  describe('content host — non-capture paths stay on-contract (in-frame safe)', () => {
    it('a non-capture path 404 carries the frame-ancestors CSP (reachable in-frame via archived site-relative links)', async () => {
      // An archived page framed on the content origin links to `/about`; that
      // resolves to a non-capture path on the content host and must still
      // permit framing by the chrome host.
      const app = createApp(new MemoryStore(), { split: SPLIT });
      const res = await app.request(`https://${CONTENT}/about`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      assert.equal(res.headers.get('x-frame-options'), null);
    });

    it('a bare / on the content host serves NO trusted UI — a 404 under the frame-ancestors CSP', async () => {
      const app = createApp(new MemoryStore(), { split: SPLIT });
      const res = await app.request(`https://${CONTENT}/`);
      assert.equal(res.status, 404);
      // The content origin hosts nothing of ours: not the chrome index.
      assert.ok(!(await res.text()).includes('A self-hosted mirror'));
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
    });
  });

  describe('Host matching — case-insensitive, port-tolerant, fail-closed', () => {
    it('matches the content host regardless of case', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');
      const app = createApp(store, { split: SPLIT });
      const res = await app.request(`https://${CONTENT.toUpperCase()}${PATH}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
    });

    it('a request with an UNCONFIGURED :port fails closed to the shell (full-authority match, no port collapse)', async () => {
      // The config carries no port; a request to CONTENT:8443 is a DIFFERENT
      // authority and must NOT serve bytes — it gets the shell. (To serve on a
      // pinned port, the operator puts the port in contentHost; see the port
      // test above.) ThrowingStore proves storage is never touched.
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const res = await app.request(`https://${CONTENT}:8443${PATH}`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('sandbox="allow-scripts'));
    });

    it('drops the DEFAULT port when matching (https :443 === no port)', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');
      const app = createApp(store, { split: SPLIT });
      // A browser never sends :443 in Host, but assert the canonicalization
      // holds if it did: the URL layer drops :443, so it matches the port-less
      // configured content host.
      const res = await app.request(`https://${CONTENT}:443${PATH}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
    });

    it('a content host CONFIGURED with a :port matches that exact authority (local dev on a pinned port)', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');
      // Operator pins a dev port on the content host; the browser sends exactly
      // that host:port and it must route to the content branch (not shell).
      const app = createApp(store, { split: { chromeHost: `${CHROME}:8080`, contentHost: `${CONTENT}:8080`, scheme: 'http' } });
      const res = await app.request(`http://${CONTENT}:8080${PATH}`);
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-security-policy') ?? '').includes(`frame-ancestors http://${CHROME}:8080`));
      // And the shell (chrome host) points its iframe at the ported content origin.
      const shell = await (await app.request(`http://${CHROME}:8080${PATH}`)).text();
      assert.ok(shell.includes(`src="http://${CONTENT}:8080${PATH}"`));
    });

    it('two ports on ONE hostname stay DISTINCT origins — the chrome authority never serves bytes (no port collapse)', async () => {
      // Regression: comparing port-stripped hosts would collapse h:8080 and
      // h:8081 to `h` and serve capture bytes on the chrome origin. Full-
      // authority comparison keeps them distinct. ThrowingStore proves the
      // chrome-port request never reaches storage.
      const app = createApp(new ThrowingStore(), { split: { chromeHost: 'h.local:8080', contentHost: 'h.local:8081', scheme: 'http' } });
      const res = await app.request('http://h.local:8080/20140403040000/http://x/');
      assert.equal(res.status, 200); // shell, not bytes (ThrowingStore would 500)
      assert.ok((await res.text()).includes('sandbox="allow-scripts'));
    });

    it('an unknown Host serves the shell, NOT capture bytes (fail-closed allowlist)', async () => {
      // A spoofed/unrecognized Host must not coax bytes out — the store throws
      // if reached; a 200 shell proves the request was treated as chrome, not
      // content.
      const app = createApp(new ThrowingStore(), { split: SPLIT });
      const res = await app.request(`https://spoofed.example${PATH}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"'));
    });
  });

  describe('a custom scheme threads through to every cross-origin reference', () => {
    it('http scheme (local dev) is honored in the iframe src and frame-ancestors', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<body>x</body>', 'text/html');
      const app = createApp(store, { split: { chromeHost: CHROME, contentHost: CONTENT, scheme: 'http' } });
      const contentRes = await app.request(`http://${CONTENT}${PATH}`);
      assert.ok((contentRes.headers.get('content-security-policy') ?? '').includes(`frame-ancestors http://${CHROME}`));
      const shell = await (await app.request(`http://${CHROME}${PATH}`)).text();
      assert.ok(shell.includes(`src="http://${CONTENT}${PATH}"`));
    });
  });

  describe('content host — scriptable non-HTML documents carry the CSP', () => {
    for (const ctype of ['image/svg+xml', 'application/xhtml+xml']) {
      it(`stamps the frame-ancestors CSP on ${ctype}`, async () => {
        const store = new MemoryStore();
        store.put(captureKey(TS, 'http://example.com/doc'), '<svg/>', ctype);
        const app = createApp(store, { split: SPLIT });
        const res = await app.request(contentUrl(`/${TS}/http://example.com/doc`));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
        assert.equal(res.headers.get('x-frame-options'), null);
      });
    }
  });

  describe('config validation — a misconfigured split must fail loud, never serve bytes wrong', () => {
    it('validateSplit rejects chrome and content resolving to the SAME origin', () => {
      assert.match(validateSplit({ chromeHost: 'same.example', contentHost: 'same.example' }) ?? '', /same origin/);
      // default-port canonicalization: `h` and `h:443` are the same https origin.
      assert.match(validateSplit({ chromeHost: 'same.example', contentHost: 'same.example:443' }) ?? '', /same origin/);
    });

    it('validateSplit rejects a non-http(s) scheme and a non-bare host', () => {
      assert.match(validateSplit({ chromeHost: 'a.example', contentHost: 'b.example', scheme: 'javascript' }) ?? '', /scheme/);
      // A host carrying a CSP-injection payload is rejected.
      assert.match(validateSplit({ chromeHost: 'a.example', contentHost: "b.example *; frame-ancestors *" }) ?? '', /bare host/);
      assert.match(validateSplit({ chromeHost: 'a.example', contentHost: 'https://b.example' }) ?? '', /bare host/);
    });

    it('validateSplit rejects an empty-string host (fail-open guard)', () => {
      assert.match(validateSplit({ chromeHost: '', contentHost: '' }) ?? '', /bare host/);
      assert.match(validateSplit({ chromeHost: 'a.example', contentHost: '' }) ?? '', /bare host/);
    });

    it('validateSplit returns the error STRING (not a raw throw) for an out-of-range port or malformed IPv6', () => {
      // The regex admits :99999 and [:::], but new URL() rejects them — the
      // error must surface as a string, not an uncaught TypeError.
      assert.match(validateSplit({ chromeHost: 'a.example', contentHost: 'b.example:99999' }) ?? '', /bare host/);
      assert.match(validateSplit({ chromeHost: 'a.example', contentHost: '[:::]' }) ?? '', /bare host/);
    });

    it('validateSplit accepts a valid two-host config', () => {
      assert.equal(validateSplit(SPLIT), null);
      assert.equal(validateSplit({ chromeHost: 'c.local:8080', contentHost: 'c.local:8081', scheme: 'http' }), null);
    });

    it('createApp THROWS on an invalid split rather than building a byte-leaking app', () => {
      assert.throws(() => createApp(new ThrowingStore(), { split: { chromeHost: 'x.example', contentHost: 'x.example' } }), /same origin/);
    });
  });

  // PRESENCE, not truthiness. TypeScript types split as `SplitOptions |
  // undefined`, but the runtime callers (node.ts:132, fastly.ts:100) forward the
  // value unchanged — so a present-but-FALSY split (`null`, `false`, `0`, `""`)
  // can reach createApp. A falsy split is PRESENT (not `undefined`) and so is a
  // configured-but-invalid split: it MUST fail closed, never fall through to
  // single-host, which would serve capture bytes FIRST-PARTY on the trusted
  // chrome host — the exact #320 vulnerability. Each case below would build a
  // single-host app and serve 200 capture bytes on the chrome host WITHOUT the
  // presence-not-truthiness fix; with it, createApp throws before any request
  // runs. (`undefined` remains the ONLY "single-host" value — covered above.)
  describe('present-but-falsy split fails closed — never single-host capture bytes (#320 truthiness fix)', () => {
    for (const bad of [null, false, 0, ''] as const) {
      it(`split: ${JSON.stringify(bad)} throws at build; a chrome-host capture request never serves 200 bytes`, async () => {
        const store = new MemoryStore();
        store.put(captureKey(TS, ORIGINAL), '<html><body>x</body></html>', 'text/html');
        let servedStatus: number | undefined;
        await assert.rejects(
          async () => {
            // createApp must throw on a present-but-invalid split. If it did NOT
            // (the truthiness bug), the request below would serve 200 capture
            // bytes on the chrome host — which `servedStatus` proves never runs.
            const app = createApp(store, { split: bad as unknown as SplitOptions });
            const res = await app.request(chromeUrl());
            servedStatus = res.status;
            return res;
          },
          /invalid AppOptions\.split/
        );
        assert.equal(servedStatus, undefined, 'createApp must fail closed BEFORE any request executes — no 200 capture bytes on the chrome host');
      });
    }
  });

  // Validate-then-reread (TOCTOU): createApp validates the split and SEPARATELY
  // re-reads its fields to derive the routing authorities. If the object's
  // fields are read more than once, a stateful/proxy accessor can pass
  // validateSplit on the first read then return a boundary-collapsing value on
  // the routing read — a `contentHost` getter that yields a distinct content
  // host FIRST (so validation sees two distinct origins) and the CHROME host on
  // the next read makes contentAuthority === chromeAuthority, so roleOf
  // classifies the TRUSTED chrome host as `content` and serves capture bytes on
  // it. The fix snapshots the three fields ONCE at build time and derives
  // everything from the snapshot, so the object is consulted exactly once and no
  // accessor can diverge between check and use. WITHOUT the fix this test sees a
  // 200 with CAPTURE-BYTES and the store touched; WITH it, the chrome host gets
  // the byte-free shell and the store stays untouched.
  describe('validate-then-reread (TOCTOU) — the split is snapshotted once (#320)', () => {
    it('a stateful contentHost getter cannot collapse the boundary: chrome host serves the shell, store untouched', async () => {
      // A spy store that RECORDS any access and would hand back capture bytes:
      // if the chrome host were misrouted to `content`, we'd see BOTH a touch
      // and 200 CAPTURE-BYTES. It must see neither.
      const captureBody = '<html><body>CAPTURE-BYTES</body></html>';
      let touched = false;
      const store: Store = {
        async head(): Promise<CaptureMeta> {
          touched = true;
          return { contentType: 'text/html', size: captureBody.length };
        },
        async get(): Promise<Capture> {
          touched = true;
          return { contentType: 'text/html', size: captureBody.length, body: captureBody };
        }
      };
      // contentHost is a stateful getter: `content.example` on the FIRST read
      // (so validateSplit sees a distinct, valid content authority), the CHROME
      // host on every read after (the pre-fix routing read). With the snapshot
      // the object is consulted once, so the second value can never apply.
      let reads = 0;
      const split = {
        chromeHost: 'chrome.example',
        get contentHost(): string { return ++reads === 1 ? 'content.example' : 'chrome.example'; }
      } as unknown as SplitOptions;
      const app = createApp(store, { split });
      // The split object was read EXACTLY once (the snapshot), never re-read.
      assert.equal(reads, 1, 'the split object must be read exactly once (snapshot), never re-read at routing time');
      const res = await app.request('https://chrome.example/20140403040000/http://evil.example/');
      const text = await res.text();
      // Fail-closed: the chrome host gets the byte-free iframe shell, not bytes.
      assert.ok(!text.includes('CAPTURE-BYTES'), 'the chrome host must NEVER serve capture bytes');
      assert.ok(text.includes('sandbox="allow-scripts'), 'the chrome host serves the sandboxed shell');
      assert.equal(touched, false, 'the chrome host must never reach the store');
    });
  });

  describe('no split configured — byte-identical to single-host serving', () => {
    it('serves capture bytes on ANY host with the plain document CSP (regression guard)', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<html><body><h1>archived</h1></body></html>', 'text/html; charset=utf-8');
      const app = createApp(store); // no split
      const res = await app.request(chromeUrl()); // even on what WOULD be the chrome host
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
      assert.ok(!(res.headers.get('content-security-policy') ?? '').includes('frame-ancestors'));
      assert.ok((await res.text()).includes('<h1>archived</h1>'));
    });

    for (const ctype of ['image/svg+xml', 'application/xhtml+xml', 'image/gif', 'application/pdf']) {
      it(`stamps NO CSP on non-text/html ${ctype} in single-host mode (pre-#320 posture preserved)`, async () => {
        const store = new MemoryStore();
        store.put(captureKey(TS, 'http://example.com/doc'), '<svg/>', ctype);
        const app = createApp(store); // no split
        const res = await app.request(`https://anything.example/${TS}/http://example.com/doc`);
        assert.equal(res.status, 200);
        // Pre-#320, only text/html got the standalone CSP; that must not change.
        assert.equal(res.headers.get('content-security-policy'), null);
      });
    }
  });

  // The content-host security policy (egress-lock + frame-ancestors) is a
  // hostile-content boundary. report-only there is log-only = a FULL bypass of
  // the boundary, so it must be emitted enforced regardless of cspMode —
  // exactly like the chrome lockdown. cspMode governs ONLY the plain
  // single-host document CSP (see discovery.test.ts).
  describe('split × cspMode:report-only — the content boundary stays ENFORCED', () => {
    it('a content HTML hit emits enforced Content-Security-Policy (never -Report-Only) with the egress-lock + frame-ancestors', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<html><body><h1>archived</h1></body></html>', 'text/html; charset=utf-8');
      const app = createApp(store, { split: SPLIT, cspMode: 'report-only' });
      const res = await app.request(contentUrl());
      assert.equal(res.status, 200);
      // ENFORCED — carries the egress-lock (connect-src 'self') + frame-ancestors.
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      // NOT report-only — that would log-only the boundary = a full bypass.
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('a content non-HTML hit also stays enforced under report-only (origin-wide boundary)', async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, 'http://example.com/pixel.gif'), new Uint8Array([0x47, 0x49, 0x46]), 'image/gif');
      const app = createApp(store, { split: SPLIT, cspMode: 'report-only' });
      const res = await app.request(contentUrl(`/${TS}/http://example.com/pixel.gif`));
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('a content miss (in-frame 404) stays enforced under report-only', async () => {
      const app = createApp(new MemoryStore(), { split: SPLIT, cspMode: 'report-only' });
      const res = await app.request(contentUrl());
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('a content non-capture path 404 stays enforced under report-only', async () => {
      const app = createApp(new MemoryStore(), { split: SPLIT, cspMode: 'report-only' });
      const res = await app.request(`https://${CONTENT}/about`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_CSP);
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('the chrome shell lockdown stays enforced under report-only', async () => {
      const app = createApp(new ThrowingStore(), { split: SPLIT, cspMode: 'report-only' });
      const res = await app.request(chromeUrl());
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-security-policy') ?? '').includes("script-src 'none'"));
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });
  });

  describe('DOCUMENT_CSP — form-action egress hole closed (#433 review)', () => {
    it("a content HTML response carries form-action 'self' (blocks cross-origin form exfil from allow-forms iframe)", async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<html><body>x</body></html>', 'text/html');
      const app = createApp(store, { split: SPLIT });
      const csp = (await app.request(contentUrl())).headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("form-action 'self'"), csp);
    });

    it("the single-host document CSP also carries form-action 'self'", async () => {
      const store = new MemoryStore();
      store.put(captureKey(TS, ORIGINAL), '<html><body>x</body></html>', 'text/html');
      const app = createApp(store); // no split
      const csp = (await app.request(`https://anything.example${PATH}`)).headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("form-action 'self'"), csp);
    });
  });

  // A scheme-only (or otherwise partial) split config must NEVER silently fall
  // back to single-host serving — that would serve capture bytes first-party on
  // the trusted chrome origin, the exact vulnerability #320 closes. Only ALL
  // THREE vars absent means split-off; anything partial fails closed.
  describe('scheme-only config fails closed — never single-host (#433 review)', () => {
    const req = () => new Request(`https://${CHROME}${PATH}`);

    it('createCloudflareHandler with ONLY SPLIT_SCHEME set throws (never single-host)', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, SPLIT_SCHEME: 'https' }),
        /split misconfigured/
      );
    });

    it('createCloudflareHandler with only CHROME_HOST set throws (partial, fail-closed)', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, CHROME_HOST: CHROME }),
        /split misconfigured/
      );
    });

    it('createCloudflareHandler with BOTH hosts absent + no scheme is single-host (serves capture bytes, REACHES the store)', async () => {
      const handler = createCloudflareHandler();
      // No split vars at all → single-host. Discriminate single-host from split
      // by something that GENUINELY differs: a CAPTURE request on an arbitrary
      // host must REACH the store and stream the stored bytes. Under a split
      // that same request lands on a non-content (chrome/unknown) host and gets
      // the byte-free iframe shell — never touching the store. (A bare `/` is a
      // vacuous probe: it 200s in BOTH modes via the index route, proving
      // nothing.) A spy R2 bucket records whether serving reached it.
      const body = '<html><body>SINGLE-HOST-CAPTURE-BODY</body></html>';
      let reached = false;
      const bucket = {
        async head() {
          reached = true;
          return { size: body.length, httpMetadata: { contentType: 'text/html' } };
        },
        async get() {
          reached = true;
          return { size: body.length, httpMetadata: { contentType: 'text/html' }, body: new Response(body).body };
        }
      };
      const res = await handler.fetch(new Request(`https://anything.example${PATH}`), { WAYBACK_CAPTURES: bucket });
      assert.equal(res.status, 200);
      assert.ok(reached, 'single-host must REACH the store; split-on-a-non-content-host serves the byte-free shell and never does');
      assert.ok((await res.text()).includes('SINGLE-HOST-CAPTURE-BODY'), 'single-host serves the stored capture bytes, not the chrome shell');
    });
  });

  // Presence must be decided on the RAW binding, not a string-coerced value.
  // Wrangler permits JSON-valued `[vars]` (objects/numbers/bools); a binding
  // that is DEFINED but not a string used to coerce to `undefined` and look
  // ABSENT — silently disabling the split and serving hostile archived bytes
  // first-party on the trusted chrome host. Each case here would serve a 200
  // capture WITHOUT the fix; with it they fail closed.
  describe('non-string / empty split bindings fail closed — never single-host (re-review)', () => {
    const req = () => new Request(`https://${CHROME}${PATH}`);

    it('a DEFINED-but-non-string CHROME_HOST (Wrangler JSON var) throws (Codex repro; never serves 200 bytes)', () => {
      const handler = createCloudflareHandler();
      // The exact reproduction: an object-valued CHROME_HOST with the other
      // split vars absent. Coercing it to a string would have looked ABSENT →
      // single-host → hostile bytes on the chrome host. It must fail closed.
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, CHROME_HOST: { value: CHROME } }),
        /split misconfigured/
      );
    });

    it('a DEFINED-but-non-string CONTENT_HOST alone throws (fail-closed)', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, CONTENT_HOST: { value: CONTENT } }),
        /split misconfigured/
      );
    });

    it('a DEFINED-but-non-string SPLIT_SCHEME alone throws (fail-closed)', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, SPLIT_SCHEME: { value: 'https' } }),
        /split misconfigured/
      );
    });

    it('an EMPTY-string CHROME_HOST (present, blank) throws — not treated as unset', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, CHROME_HOST: '', CONTENT_HOST: CONTENT }),
        /split misconfigured/
      );
    });

    it('both valid hosts + an EMPTY-string SPLIT_SCHEME throws (fix 2 — never a silent https drop)', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, CHROME_HOST: CHROME, CONTENT_HOST: CONTENT, SPLIT_SCHEME: '' }),
        /split misconfigured/
      );
    });

    it('both valid hosts + a WHITESPACE SPLIT_SCHEME throws (fix 2)', () => {
      const handler = createCloudflareHandler();
      assert.throws(
        () => handler.fetch(req(), { WAYBACK_CAPTURES: {}, CHROME_HOST: CHROME, CONTENT_HOST: CONTENT, SPLIT_SCHEME: '   ' }),
        /split misconfigured/
      );
    });

    it('both valid hosts + SPLIT_SCHEME ABSENT still works: the split is ON with the https default (chrome shell, 200)', async () => {
      const handler = createCloudflareHandler();
      // No scheme var → https default (NOT a throw, NOT single-host). A chrome-
      // host capture request returns the sandboxed shell — 200, never touching
      // the store — and its iframe points at the content origin over https.
      const res = await handler.fetch(req(), { WAYBACK_CAPTURES: {}, CHROME_HOST: CHROME, CONTENT_HOST: CONTENT });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes(`src="https://${CONTENT}${PATH}"`));
      assert.ok(body.includes('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"'));
    });
  });
});
