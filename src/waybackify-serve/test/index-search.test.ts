/**
 * The local-only cache index/search page (`GET /_index`). Same harness as
 * app.test.ts: hono's app.request() against a MemoryStore, zero network.
 *
 * The load-bearing property is EDGE SAFETY: `/_index` exists ONLY when
 * `indexKeys` was supplied (the Node --root entry under `--index`). Without
 * the option — every edge entry, which cannot enumerate — the route answers
 * the same styled local 404 any non-capture path gets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type SplitOptions } from '../src/app.ts';
import { decodeCapturePath, parseWaybackPath } from '../src/path.ts';
import { MemoryStore } from '../src/store.ts';

const GITHUB_KEY = '20090226220257/http://github.com/indexzero';
const EXAMPLE_KEY = '20140403040000/http://example.com/a';

function appWithIndex(keys: string[] = [GITHUB_KEY, EXAMPLE_KEY]) {
  return createApp(new MemoryStore(), { indexKeys: new Set(keys) });
}

/** Undo escapeHtml (src/app.ts) — recover an attribute's raw value. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Every result link's raw href from a rendered /_index page. */
function resultHrefs(page: string): string[] {
  return [...page.matchAll(/<li><a href="([^"]*)"/g)].map(m => unescapeHtml(m[1]));
}

describe('/_index cache search page', () => {
  it('serves the search form and links every key', async () => {
    const res = await appWithIndex().request('/_index', { headers: { host: 'm.test' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.headers.get('content-security-policy'), 'the page carries the document CSP');
    const body = await res.text();
    assert.ok(body.includes('<form'), 'renders a search form');
    assert.ok(body.includes(`href="/${GITHUB_KEY}"`), 'each key links to its capture path');
    assert.ok(body.includes(`href="/${EXAMPLE_KEY}"`));
    assert.ok(body.includes('showing 2 of 2'));
    assert.ok(!body.includes('<script'), 'zero client script — server-side filtering only');
  });

  it('filters server-side on ?q= (case-insensitive substring)', async () => {
    const body = await (await appWithIndex().request('/_index?q=example', { headers: { host: 'm.test' } })).text();
    assert.ok(body.includes(EXAMPLE_KEY), 'the matching key is listed');
    assert.ok(!body.includes(GITHUB_KEY), 'the non-matching key is not');
    assert.ok(body.includes('showing 1 of 1'));
  });

  it('answers an empty result honestly', async () => {
    const body = await (await appWithIndex().request('/_index?q=zzzznomatch', { headers: { host: 'm.test' } })).text();
    assert.ok(body.includes('showing 0 of 0'));
  });

  it('caps the rendered list at 200 and says so', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `20140101000000/http://example.com/p${String(i).padStart(3, '0')}`);
    const body = await (await appWithIndex(keys).request('/_index', { headers: { host: 'm.test' } })).text();
    assert.ok(body.includes('showing 200 of 250 — refine to narrow'));
    assert.equal((body.match(/<li>/g) ?? []).length, 200);
  });

  it('HEAD answers headers with an empty body', async () => {
    const res = await appWithIndex().request('/_index', { method: 'HEAD', headers: { host: 'm.test' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(await res.text(), '');
  });

  it('escapes hostile keys — no raw markup from a key survives into the page', async () => {
    const evilKey = '20140101000000/http://example.com/?a=<b>&x="y"';
    const body = await (await appWithIndex([evilKey]).request('/_index', { headers: { host: 'm.test' } })).text();
    assert.ok(!body.includes('<b>'), 'a key must never render as live markup');
    assert.ok(body.includes('&lt;b&gt;'), 'the key is HTML-escaped');
    assert.ok(body.includes('&amp;x='), 'ampersands in the key are escaped');
  });

  it('escapes the reflected query', async () => {
    const body = await (await appWithIndex().request('/_index?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E', { headers: { host: 'm.test' } })).text();
    assert.ok(!body.includes('<script>alert(1)</script>'), 'the query must never render as live markup');
    assert.ok(body.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  // Result links must ROUND-TRIP to the byte-exact capture key. The href is
  // built by formatCapturePath (the parser's inverse); a browser navigating it
  // transmits `pathname + search` byte-identically (the href is a WHATWG
  // fixed point), and the `*` route — raw parseWaybackPath first, then the
  // decodeCapturePath'd re-parse on a store miss — recovers the EXACT key.
  describe('result links round-trip hostile keys', () => {
    const HOSTILE_KEYS = [
      '20140403040000/http://x.com/a?b=c#f', // the fragment trap from the review
      '20140101000000/http://example.com/a b/c d.html', // spaces in the path
      '20140101000000/http://example.com/a?q=c d', // space in the query
      '20140101000000/http://example.com/café/日本', // Unicode (latin1 + beyond)
      '20140101000000/http://example.com/<i>"quoted"</i>', // markup + double quotes
      "20140101000000/http://example.com/a?q='hi'&x=1", // single quotes in the query
      '20140101000000/http://example.com/ab', // a C0 control byte
      '20140101000000/http://example.com/a\\b^c`d{e}f', // path-mangled ASCII
      '20140101000000/http://example.com/100%/a%20b', // lone % AND a literal %20 (must NOT decode to a space)
      '20140101000000/http://example.com/plain?q=1&r=2' // wire-safe: the href stays the identity
    ];

    it('each href survives the browser URL parse and maps back to the byte-exact key via the * route\'s parse', async () => {
      for (const key of HOSTILE_KEYS) {
        const page = await (await appWithIndex([key]).request('/_index', { headers: { host: 'm.test' } })).text();
        const hrefs = resultHrefs(page);
        assert.equal(hrefs.length, 1, `exactly one result link for ${key}`);
        // What a browser transmits for this href: WHATWG-parse it against the
        // page origin. The href must be a FIXED POINT — transmitted verbatim,
        // nothing re-encoded, no fragment split off.
        const url = new URL(`http://m.test${hrefs[0]}`);
        const wire = url.pathname + url.search;
        assert.equal(wire, hrefs[0], `the href is transmitted byte-identically for ${key}`);
        // The * route's key derivation: raw parse first, decode-fallback on a
        // store miss. The candidate that serves must be the byte-exact key.
        const raw = parseWaybackPath(wire);
        const decoded = decodeCapturePath(wire);
        const alt = decoded === wire ? null : parseWaybackPath(decoded);
        assert.equal((alt ?? raw)?.key, key, `round-trips to the byte-exact key for ${key}`);
      }
    });

    it('clicking a result serves that exact capture (end-to-end store hit)', async () => {
      for (const key of HOSTILE_KEYS) {
        const store = new MemoryStore();
        store.put(key, `BODY:${key}`, 'text/plain');
        const app = createApp(store, { indexKeys: new Set([key]) });
        const page = await (await app.request('/_index', { headers: { host: 'm.test' } })).text();
        const [href] = resultHrefs(page);
        const url = new URL(`http://m.test${href}`);
        const res = await app.request(url.pathname + url.search, { headers: { host: 'm.test' } });
        assert.equal(res.status, 200, `clicking the link hits the capture for ${key}`);
        assert.equal(await res.text(), `BODY:${key}`, `the exact capture body is served for ${key}`);
      }
    });

    it('a request that dials a literal percent-sequence key directly still wins over the decoded reading', async () => {
      // Raw-first precedence: the store holds the literal `%20` key; asking
      // for it by its own byte-exact path must keep serving it, never the
      // space-decoded neighbor.
      const literal = '20140101000000/http://example.com/a%20b';
      const store = new MemoryStore();
      store.put(literal, 'literal-percent', 'text/plain');
      const app = createApp(store, {});
      const res = await app.request(`/${literal}`, { headers: { host: 'm.test' } });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'literal-percent');
    });
  });

  // The /_index SERVE path honors roleOf (#320) exactly like `/` does: the
  // content origin NEVER hosts our listing, the chrome origin serves it under
  // the LOCKED chrome CSP, single-host keeps the plain document CSP.
  describe('under the chrome/content split', () => {
    const SPLIT: SplitOptions = { chromeHost: 'wayback.example.com', contentHost: 'content.example.net' };
    const splitApp = () =>
      createApp(new MemoryStore(), { indexKeys: new Set([GITHUB_KEY]), split: SPLIT });

    it('content-host /_index is a content 404 — no listing bytes leak onto the sacrificial origin', async () => {
      const res = await splitApp().request('https://content.example.net/_index');
      assert.equal(res.status, 404);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes('frame-ancestors https://wayback.example.com'), 'the boundary CSP, enforced');
      const body = await res.text();
      assert.ok(body.includes('Not mirrored here'), 'the styled content 404');
      assert.ok(!body.includes(GITHUB_KEY), 'no capture key leaks');
      assert.ok(!body.includes('<form'), 'no search page on the content origin');
    });

    it('chrome-host /_index serves the listing under the LOCKED chrome CSP, not the document CSP', async () => {
      const res = await splitApp().request('https://wayback.example.com/_index');
      assert.equal(res.status, 200);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("script-src 'none'"), 'the chrome lockdown CSP');
      assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'never the permissive document CSP');
      const body = await res.text();
      assert.ok(body.includes(GITHUB_KEY), 'the listing serves on the chrome origin');
    });

    it('single-host /_index keeps the plain document CSP', async () => {
      const res = await appWithIndex().request('/_index', { headers: { host: 'm.test' } });
      assert.equal(res.status, 200);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), 'the standalone document CSP');
      assert.ok(!csp.includes("script-src 'none'"));
    });
  });

  it('is INERT without indexKeys — /_index answers 404 (edge safety)', async () => {
    const app = createApp(new MemoryStore(), {});
    const res = await app.request('/_index', { headers: { host: 'm.test' } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.ok(body.includes('Not mirrored here'), 'the same styled local 404 as any non-capture path');
  });
});
