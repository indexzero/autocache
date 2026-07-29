/**
 * remaster verify tests (#365) — the remastered-tier standalone validator.
 *
 * STATIC tier is fully offline: a SYNTHETIC all-satisfiable hermetic root is
 * remastered in-test through the merged remaster engine and scanned clean (its
 * refs all resolve, so remaster localizes every one and no archive.org byte
 * survives), then injected-defect cases surface one failure class each — a
 * planted absolute archive.org ref in HTML / CSS / JS, a tampered body vs its
 * build record, and a stale rebuild. The committed 7-entry fixture is remastered
 * and scanned too: it is DELIBERATELY not standalone (its google.com capture,
 * and its stored `alpha.jpg` wayback error page, reference captures outside the
 * 7-entry corpus, which remaster leaves byte-for-byte foreign "so a strict
 * validator can surface it"), so the scan MUST find those escapes — that is the
 * interstitial-shaped-body case.
 *
 * DYNAMIC tier: the request-classification core is a pure function tested in
 * probe.test.js (which this tier reuses verbatim); runDynamic's fail-closed
 * handling is exercised offline through the injected-probe seam, and the
 * real-browser sweep is gated behind REMASTER_VERIFY_BROWSER so CI stays green
 * without a browser.
 */

import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureHash } from '@charlie.dev/waybackify/key.js';
import {
  checkDeterminism,
  enumerateRemastered,
  isTextBearing,
  runDynamic,
  scanBody,
  scanEscapes
} from '../src/verify.js';
// The merged-in remaster engine (PR #369) — the build remaster verify validates.
import { BUILD_NAME, remaster } from '@charlie.dev/waybackify/remaster.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const mkroot = prefix => fsp.mkdtemp(path.join(os.tmpdir(), prefix));
const bytesOf = s => Buffer.from(s, 'latin1');
const sri = bytes => `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;

function canonicalJSON(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Write one hermetic entry (body + sidecar) into a root, the way cache.js does. */
async function writeEntry(root, spec) {
  const { key, status = 'body', contentType = '', flag = null, body = null } = spec;
  const hash = await captureHash(key);
  const aa = hash.slice(0, 2);
  const sidecar = { contentType, fetchedAt: '2026-07-23T00:00:00.000Z', flag, key, requisites: [], status, v: 1 };
  if (status === 'body') {
    const bytes = bytesOf(body ?? '');
    await fsp.mkdir(path.join(root, 'cap', aa), { recursive: true });
    await fsp.writeFile(path.join(root, 'cap', aa, hash), bytes);
    sidecar.contentHash = sri(bytes);
    sidecar.contentLength = bytes.length;
  }
  await fsp.mkdir(path.join(root, 'meta', aa), { recursive: true });
  await fsp.writeFile(path.join(root, 'meta', aa, `${hash}.json`), canonicalJSON(sidecar));
}

const TS = '20140403040000';
const DOC_KEY = `${TS}/http://example.com/`;
const CSS_KEY = `${TS}/http://example.com/screen.css`;
const JS_KEY = `${TS}/http://example.com/app.js`;
const IMG_KEY = `${TS}/http://example.com/logo.png`;
const FONT_KEY = `${TS}/http://example.com/fonts/x.woff2`;

/**
 * A synthetic hermetic root where EVERY wayback reference is satisfiable — so
 * the remaster localizes all of them and the remastered tree is clean (zero
 * archive.org bytes survive). Also carries real replay chrome so the strip runs.
 */
async function buildCleanRoot() {
  const root = await mkroot('remaster-verify-clean-');
  const DOC = [
    '<html><head>',
    '<!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp">chrome</div><!-- END WAYBACK TOOLBAR INSERT -->',
    '<script src="https://web-static.archive.org/_static/js/wombat.js"></script>',
    `<style>@import "https://web.archive.org/web/${TS}cs_/http://example.com/screen.css";`,
    `body{background:url(https://web.archive.org/web/${TS}im_/http://example.com/logo.png)}</style>`,
    '</head><body>',
    `<img src="https://web.archive.org/web/${TS}im_/http://example.com/logo.png">`,
    `<a href="/web/${TS}/http://example.com/screen.css">css</a>`,
    `<script>var u = "https://web.archive.org/web/${TS}js_/http://example.com/app.js";</script>`,
    '</body></html>'
  ].join('');
  await writeEntry(root, { key: DOC_KEY, contentType: 'text/html; charset=utf-8', body: DOC });
  await writeEntry(root, {
    key: CSS_KEY,
    contentType: 'text/css',
    flag: 'cs_',
    body: `@font-face{font-family:x;src:url(https://web.archive.org/web/${TS}cs_/http://example.com/fonts/x.woff2) format("woff2")}`
  });
  await writeEntry(root, {
    key: JS_KEY,
    contentType: 'application/javascript',
    flag: 'js_',
    body: `var img = "https://web.archive.org/web/${TS}im_/http://example.com/logo.png"; console.log(img);`
  });
  await writeEntry(root, { key: IMG_KEY, contentType: 'image/png', flag: 'im_', body: '\x89PNG\r\n\x1a\n archive.org in binary \xff\xfe' });
  await writeEntry(root, { key: FONT_KEY, contentType: 'font/woff2', flag: 'cs_', body: 'wOF2 fake' });
  return root;
}

/** Overwrite one remastered body by capture key (a defect injector). */
async function overwriteBody(root, key, bytes) {
  const hash = await captureHash(key);
  await fsp.writeFile(path.join(root, 'cap', hash.slice(0, 2), hash), bytes);
}

/* ------------------------------------------------------------------------ */

describe('remaster verify static — escape scan (zero allowlist)', () => {
  let hermetic;
  let out;

  before(async () => {
    hermetic = await buildCleanRoot();
    out = await mkroot('remaster-verify-clean-out-');
    await remaster(hermetic, out);
  });

  it('a fully-satisfiable remastered tree scans CLEAN', async () => {
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.findings, [], report.findings.map(f => `${f.key} ${f.excerpt}`).join('\n'));
    assert.equal(report.pass, true);
    assert.equal(report.counts?.scanned, 3); // html + css + js; png + woff2 are binary
  });

  it('scanBody flags a planted absolute archive.org ref in HTML — offset + excerpt', () => {
    const html = `<a href="https://web.archive.org/web/20200101000000/http://foo.test/x">y</a>`;
    const findings = scanBody('k', html);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'archive-org');
    assert.equal(findings[0].offset, html.indexOf('archive.org'));
    assert.match(findings[0].excerpt, /web\.archive\.org/);
  });

  it('scanBody flags a planted archive.org ref in a CSS url()', () => {
    const css = `body{background:url(https://web.archive.org/web/20200101000000/http://foo.test/a.png)}`;
    const findings = scanBody('k', css);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'archive-org');
  });

  it('scanBody flags a planted archive.org ref in a JS string literal', () => {
    const js = `var u = "https://web.archive.org/web/20200101000000/http://foo.test/a.js";`;
    const findings = scanBody('k', js);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'archive-org');
  });

  it('scanBody flags a NON-archive absolute /web/<ts> escape as its own class', () => {
    const html = `<a href="https://evil.test/web/20200101000000/http://foo.test/x">y</a>`;
    const findings = scanBody('k', html);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'absolute-web-escape');
  });

  it('scanBody leaves the CORRECT root-relative /web/<ts>/ form alone', () => {
    const html = `<img src="/web/20200101000000im_/http://example.com/logo.png">`;
    assert.deepEqual(scanBody('k', html), []);
  });

  it('binary bodies are not scanned (an "archive.org" byte run in a PNG is not a finding)', () => {
    assert.equal(isTextBearing('image/png'), false);
    assert.equal(isTextBearing('font/woff2'), false);
    assert.equal(isTextBearing('text/html; charset=utf-8'), true);
    assert.equal(isTextBearing('text/css'), true);
    assert.equal(isTextBearing('image/svg+xml'), true);
  });

  it('a planted ref in a remastered body is surfaced at the tree level', async () => {
    const tampered = await mkroot('remaster-verify-plant-');
    await remaster(hermetic, tampered);
    const doc = bytesOf('<html><body><img src="https://web.archive.org/web/20200101000000/http://foo.test/x.png"></body></html>');
    await overwriteBody(tampered, DOC_KEY, doc);
    const report = await scanEscapes(await enumerateRemastered(tampered));
    assert.equal(report.pass, false);
    const hit = report.findings.find(f => f.key === DOC_KEY && f.kind === 'archive-org');
    assert.ok(hit, 'expected an archive-org finding on the doc');
    await fsp.rm(tampered, { recursive: true, force: true });
  });
});

describe('remaster verify static — determinism (build-record integrity + rebuild)', () => {
  let hermetic;

  before(async () => {
    hermetic = await buildCleanRoot();
  });

  it('a current build passes: integrity holds and a rebuild reproduces the build record', async () => {
    const out = await mkroot('remaster-verify-det-ok-');
    await remaster(hermetic, out);
    const report = await checkDeterminism(out, await enumerateRemastered(out), { hermetic });
    assert.deepEqual(report.findings, []);
    assert.equal(report.pass, true);
    assert.equal(report.counts?.reproduced, 1);
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a tampered served body diverges from BOTH the build record and its sidecar', async () => {
    const out = await mkroot('remaster-verify-det-tamper-');
    await remaster(hermetic, out);
    await overwriteBody(out, CSS_KEY, bytesOf('/* tampered — bytes the build record never saw */'));
    const report = await checkDeterminism(out, await enumerateRemastered(out), { hermetic });
    assert.equal(report.pass, false);
    assert.ok(report.findings.some(f => f.key === CSS_KEY && f.kind === 'body-hash'));
    assert.ok(report.findings.some(f => f.key === CSS_KEY && f.kind === 'sidecar-hash'));
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a missing build record is itself a finding', async () => {
    const out = await mkroot('remaster-verify-det-nobuild-');
    await remaster(hermetic, out);
    await fsp.rm(path.join(out, BUILD_NAME));
    const report = await checkDeterminism(out, await enumerateRemastered(out), { hermetic });
    assert.equal(report.pass, false);
    assert.equal(report.findings[0].kind, 'build-missing');
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a stale build (hermetic changed after the build) is caught as rebuild-drift', async () => {
    const src = await buildCleanRoot();
    const out = await mkroot('remaster-verify-det-stale-');
    await remaster(src, out);
    // Mutate the hermetic source AFTER the build: a fresh rebuild now differs.
    await writeEntry(src, { key: `${TS}/http://example.com/new.js`, contentType: 'application/javascript', flag: 'js_', body: 'var late = 1;' });
    const report = await checkDeterminism(out, await enumerateRemastered(out), { hermetic: src });
    assert.equal(report.pass, false);
    assert.ok(report.findings.some(f => f.kind === 'rebuild-drift'));
    await fsp.rm(src, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('without --hermetic (or with skip), integrity still runs and reproducibility is noted skipped', async () => {
    const out = await mkroot('remaster-verify-det-skip-');
    await remaster(hermetic, out);
    const report = await checkDeterminism(out, await enumerateRemastered(out), {});
    assert.equal(report.pass, true);
    assert.ok(report.skipped);
    assert.equal(report.counts?.reproduced, 0);
    await fsp.rm(out, { recursive: true, force: true });
  });
});

describe('remaster verify static — the committed 7-entry fixture is deliberately NOT standalone', () => {
  const FIXTURE = path.resolve(HERE, 'fixtures/cache-root');

  it('remastering the real fixture leaves foreign archive.org refs the scan surfaces (incl. the alpha.jpg interstitial)', async () => {
    const out = await mkroot('remaster-verify-fixture-');
    await remaster(FIXTURE, out);
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.equal(report.pass, false);
    // The stored `alpha.jpg` is a text/html wayback error page — an
    // interstitial-shaped body — carrying archive.org links to captures the
    // 7-entry corpus does not hold.
    assert.ok(report.findings.some(f => f.key.endsWith('/alpha.jpg') && f.kind === 'archive-org'), 'expected escapes from the alpha.jpg interstitial');
    assert.ok(report.findings.some(f => f.key === '19981202230410/http://www.google.com/'), 'expected escapes from the google.com document');
    await fsp.rm(out, { recursive: true, force: true });
  });
});

describe('remaster verify dynamic — fail-closed on no evidence (injected probe)', () => {
  it('a probe that observes ZERO requests fails the doc closed (never verifies on no evidence)', async () => {
    const hermetic = await buildCleanRoot();
    const out = await mkroot('remaster-verify-noev-');
    await remaster(hermetic, out);

    // A fake probe that renders "clean" (no nonLocal / dangling / csp findings)
    // but observed === 0 — the signature of a failed navigation / log
    // collection. runDynamic MUST NOT read this as a pass.
    const createProbe = () => ({
      async open() {},
      async render(serverUrl, docKey) {
        return { pass: true, observed: 0, dangling: [], nonLocal: [], csp: [], requests: [], url: `${serverUrl}/web/${docKey}` };
      },
      async close() {}
    });

    const report = await runDynamic(out, { root: out, createProbe });
    assert.equal(report.pass, false, JSON.stringify(report.findings, null, 2));
    assert.ok(report.documents.length >= 1, 'expected at least one HTML doc rendered');
    assert.ok(report.documents.every(d => d.pass === false), 'every zero-evidence doc must fail');
    assert.ok(report.findings.some(f => f.kind === 'no-evidence'), 'expected a no-evidence finding');

    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });
});

describe('remaster verify dynamic — real browser sweep (gated behind REMASTER_VERIFY_BROWSER)', () => {
  const enabled = process.env.REMASTER_VERIFY_BROWSER === '1';
  it('renders a clean remastered tree with zero escapes / CSP violations', { skip: !enabled, timeout: 120000 }, async () => {
    const hermetic = await buildCleanRoot();
    const out = await mkroot('remaster-verify-dyn-');
    await remaster(hermetic, out);
    const report = await runDynamic(out, { root: out });
    assert.equal(report.pass, true, JSON.stringify(report.findings, null, 2));
    assert.ok((report.documents?.length ?? 0) >= 1);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });
});
