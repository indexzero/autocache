/**
 * The opt-in `--relax-content-csp` STOPGAP: widen the content CSP's
 * resource-loading directives (and the chrome shell's framing grants) with the
 * archive origins so un-localized web.archive.org references load live instead
 * of being blocked. Driven exactly like app.test.ts / split.test.ts —
 * app.request() against a MemoryStore, zero network.
 *
 * Two families of assertion, both load-bearing:
 *   1. OFF (the default) is byte-identical to today's strict policies — no
 *      archive origin anywhere.
 *   2. ON widens directive VALUES only. The invariants that must survive the
 *      relaxation, verbatim: `default-src 'self'`, `form-action 'self'`,
 *      `base-uri 'none'` (chrome), every `frame-ancestors` (content names only
 *      the chrome origin; chrome stays `'self'`), the chrome
 *      `script-src 'none'`/`object-src 'none'`, and the forced-`'enforce'`
 *      MODE on the content boundary and the chrome lockdown.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createCloudflareHandler } from '../src/cloudflare.ts';
import { captureKey } from '../src/path.ts';
import { MemoryStore, type R2BucketLike } from '../src/store.ts';
import type { SplitOptions } from '../src/app.ts';

const TS = '20140403040000';
const ORIGINAL = 'http://sudomakethought.com/post/123';
const PATH = `/${TS}/${ORIGINAL}`;

const CHROME = 'wayback.example.com';
const CONTENT = 'content.example.net';
const SPLIT: SplitOptions = { chromeHost: CHROME, contentHost: CONTENT };
const chromeUrl = (path = PATH) => `https://${CHROME}${path}`;
const contentUrl = (path = PATH) => `https://${CONTENT}${path}`;

/** The strict standalone document CSP (src/app.ts) — today's default. */
const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'";

/** The archive origins the relaxation appends to the CONTENT directives. */
const ARCHIVE = 'https://web.archive.org https://archive.org';

/**
 * The relaxed document CSP, spelled out in full: the archive origins appended
 * to each resource-loading directive; `default-src` and `form-action` verbatim.
 * Duplicated from src/app.ts ON PURPOSE (like DOCUMENT_CSP above) so a change
 * to the policy is a deliberate two-place edit.
 */
const RELAXED_DOCUMENT_CSP =
  "default-src 'self'; " +
  `script-src 'self' 'unsafe-inline' ${ARCHIVE}; ` +
  `style-src 'self' 'unsafe-inline' ${ARCHIVE}; ` +
  `img-src 'self' data: ${ARCHIVE}; ` +
  `font-src 'self' ${ARCHIVE}; ` +
  `media-src 'self' ${ARCHIVE}; ` +
  `connect-src 'self' ${ARCHIVE}; ` +
  `frame-src 'self' ${ARCHIVE}; ` +
  "form-action 'self'";

describe('--relax-content-csp (STOPGAP)', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    store.put(captureKey(TS, ORIGINAL), '<html><body><h1>archived</h1></body></html>', 'text/html; charset=utf-8');
  });

  describe('OFF (the default) — strict policies, byte-identical to today', () => {
    it('single-host: an HTML hit carries exactly the strict document CSP — no archive origin', async () => {
      const app = createApp(store);
      const res = await app.request(PATH);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), DOCUMENT_CSP);
      assert.ok(!(res.headers.get('content-security-policy') ?? '').includes('web.archive.org'));
    });

    it('split: the content CSP and the chrome shell CSP carry no archive origin', async () => {
      const app = createApp(store, { split: SPLIT });

      const content = await app.request(contentUrl());
      assert.equal(content.headers.get('content-security-policy'), `${DOCUMENT_CSP}; frame-ancestors https://${CHROME}`);

      const chrome = await app.request(chromeUrl());
      const csp = chrome.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes(`frame-src https://${CONTENT};`), 'frame-src names ONLY the content origin');
      assert.ok(csp.includes(`child-src https://${CONTENT};`), 'child-src names ONLY the content origin');
      assert.ok(!csp.includes('web.archive.org'));
    });
  });

  describe('ON, single-host — the document CSP gains the archive origins, nothing else moves', () => {
    it('an HTML hit carries the relaxed document CSP, exactly', async () => {
      const app = createApp(store, { relaxContentCsp: true });
      const res = await app.request(PATH);
      assert.equal(res.status, 200);
      // The FULL policy, so nothing beyond the seven named directives moved.
      assert.equal(res.headers.get('content-security-policy'), RELAXED_DOCUMENT_CSP);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes(`script-src 'self' 'unsafe-inline' ${ARCHIVE}`));
      assert.ok(csp.includes(`img-src 'self' data: ${ARCHIVE}`));
      // The invariants, verbatim: posture directives never widen.
      assert.ok(csp.includes("default-src 'self';"), "default-src stays 'self' alone");
      assert.ok(csp.endsWith("form-action 'self'"), "form-action stays 'self' alone");
      assert.ok(!csp.includes('frame-ancestors'), 'single-host never grows frame-ancestors');
      // The MODE is untouched: still the enforced header, no report-only.
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('a miss (the local 404) carries the same relaxed document CSP', async () => {
      const app = createApp(new MemoryStore(), { relaxContentCsp: true });
      const res = await app.request(PATH);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-security-policy'), RELAXED_DOCUMENT_CSP);
    });
  });

  describe('ON, split — content directives widen; every boundary stays intact', () => {
    let app: ReturnType<typeof createApp>;
    beforeEach(() => {
      app = createApp(store, { split: SPLIT, relaxContentCsp: true });
    });

    it('a content hit carries the relaxed CSP + the UNCHANGED frame-ancestors, one header', async () => {
      const res = await app.request(contentUrl());
      assert.equal(res.status, 200);
      // Full-policy equality: archive origins in the content directives, and
      // frame-ancestors still names EXACTLY the chrome origin — no archive
      // origin, no 'self' — so the framing contract did not move.
      assert.equal(res.headers.get('content-security-policy'), `${RELAXED_DOCUMENT_CSP}; frame-ancestors https://${CHROME}`);
    });

    it('the chrome shell frame-src/child-src gain web.archive.org (the mobile frame-navigation unblank); the lockdown survives verbatim', async () => {
      const res = await app.request(chromeUrl());
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes(`frame-src https://${CONTENT} https://web.archive.org`));
      assert.ok(csp.includes(`child-src https://${CONTENT} https://web.archive.org`));
      // ONLY web.archive.org — the chrome shell frames replay pages, not bare
      // archive.org (which the content directives admit for replay assets).
      assert.ok(!csp.includes('https://archive.org'), 'chrome framing gains web.archive.org only');
      // The lockdown, verbatim — the relaxation may never touch it.
      assert.ok(csp.includes("script-src 'none'"));
      assert.ok(csp.includes("object-src 'none'"));
      assert.ok(csp.includes("frame-ancestors 'self'"));
      assert.ok(csp.includes("base-uri 'none'"));
      assert.ok(csp.includes("form-action 'self'"));
      assert.ok(csp.includes("default-src 'self'"));
    });

    it('a content miss (in-frame 404) still carries the relaxed CSP with frame-ancestors intact', async () => {
      const missApp = createApp(new MemoryStore(), { split: SPLIT, relaxContentCsp: true });
      const res = await missApp.request(contentUrl());
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-security-policy'), `${RELAXED_DOCUMENT_CSP}; frame-ancestors https://${CHROME}`);
    });
  });

  describe('guard — the flag widens VALUES, never the enforcement MODE', () => {
    it('flag on + cspMode report-only: the content boundary is STILL enforced', async () => {
      const app = createApp(store, { split: SPLIT, relaxContentCsp: true, cspMode: 'report-only' });
      const res = await app.request(contentUrl());
      assert.equal(res.status, 200);
      // Enforced Content-Security-Policy — report-only is never reachable on
      // the hostile-content boundary, relaxed or not (log-only = full bypass).
      assert.equal(res.headers.get('content-security-policy'), `${RELAXED_DOCUMENT_CSP}; frame-ancestors https://${CHROME}`);
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('flag on + cspMode report-only: the chrome lockdown is STILL enforced', async () => {
      const app = createApp(store, { split: SPLIT, relaxContentCsp: true, cspMode: 'report-only' });
      const res = await app.request(chromeUrl());
      assert.ok((res.headers.get('content-security-policy') ?? '').includes("script-src 'none'"));
      assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('flag on, single-host: cspMode still governs the NON-boundary document CSP (the flag changed values, not the mode)', async () => {
      // report-only on the plain single-host document CSP is the pre-existing
      // staging posture — the relaxation must not flip it either way.
      const app = createApp(store, { relaxContentCsp: true, cspMode: 'report-only' });
      const res = await app.request(PATH);
      assert.equal(res.headers.get('content-security-policy'), null);
      assert.equal(res.headers.get('content-security-policy-report-only'), RELAXED_DOCUMENT_CSP);
    });
  });
});

describe('edge adapter — RELAX_CONTENT_CSP threads to the content CSP', () => {
  /** A fake R2 bucket that always misses (get/head → null). */
  const emptyBucket: R2BucketLike = {
    async get() { return null; },
    async head() { return null; }
  } as unknown as R2BucketLike;

  /** Whichever CSP header the miss response actually emits (enforce OR report-only). */
  const cspOf = (res: Response) =>
    res.headers.get('content-security-policy') ?? res.headers.get('content-security-policy-report-only') ?? '';

  it('RELAX_CONTENT_CSP: "1" → the 404 document CSP admits the archive origins', async () => {
    const handler = createCloudflareHandler();
    const res = await handler.fetch(
      new Request('https://x/20140403040000/http://x/none'),
      { WAYBACK_CAPTURES: emptyBucket, RELAX_CONTENT_CSP: '1' }
    );
    assert.equal(res.status, 404);
    const csp = cspOf(res);
    // Matches the ARCHIVE origins constant: both web.archive.org and archive.org.
    assert.ok(csp.includes('https://web.archive.org'), 'relaxed CSP admits web.archive.org');
    assert.ok(csp.includes('https://archive.org'), 'relaxed CSP admits archive.org');
    assert.ok(csp.includes(ARCHIVE), 'relaxed CSP carries the full ARCHIVE origins');
  });

  it('no relax var (default) → the 404 document CSP is strict, no archive origin', async () => {
    const handler = createCloudflareHandler();
    const res = await handler.fetch(
      new Request('https://x/20140403040000/http://x/none'),
      { WAYBACK_CAPTURES: emptyBucket }
    );
    assert.equal(res.status, 404);
    assert.ok(!cspOf(res).includes('web.archive.org'), 'strict CSP names no archive origin');
  });
});
