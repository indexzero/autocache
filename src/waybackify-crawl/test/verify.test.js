/**
 * remaster verify tests (#365) — the remastered-tier standalone validator.
 *
 * STATIC tier is fully offline: a SYNTHETIC all-satisfiable hermetic root is
 * remastered in-test through the merged remaster engine and scanned clean (its
 * refs all resolve, so remaster localizes every one and no archive.org byte
 * survives), then injected-defect cases surface one failure class each — a
 * planted absolute archive.org ref in HTML / CSS / JS, a tampered body vs its
 * build record, and a stale rebuild. The committed 7-entry fixture is remastered
 * and scanned too: its uncaptured refs (its google.com capture's links, and its
 * stored `alpha.jpg` wayback error page's links, to captures outside the 7-entry
 * corpus) are all NAVIGATIONAL, which rule v2 localizes to the mirror form — so
 * the real fixture now stands alone and the scan comes back clean. Subresource
 * escapes still stay foreign, exercised by the planted-ref cases above.
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
import { bodyPath, captureHash } from '@autocache/waybackify/key.js';
import {
  checkDeterminism,
  classifyUpstream,
  enumerateRemastered,
  formatReport,
  isTextBearing,
  runDynamic,
  scanBody,
  scanEscapes
} from '../src/verify.js';
// The merged-in remaster engine (PR #369) — the build remaster verify validates.
import { BUILD_NAME, remaster } from '@autocache/waybackify/remaster.js';

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

/** Write one hermetic entry (body + sidecar) into a root, the way cache.js does: a v3 sidecar, `dynamic` only when given. */
async function writeEntry(root, spec) {
  const { key, status = 'body', contentType = '', flag = null, body = null, requisites = [], dynamic, v = 3 } = spec;
  const hash = await captureHash(key);
  const aa = hash.slice(0, 2);
  const sidecar = { contentType, fetchedAt: '2026-07-23T00:00:00.000Z', flag, key, requisites, status, v };
  if (dynamic) sidecar.dynamic = dynamic;
  if (status === 'body') {
    const bytes = bytesOf(body ?? '');
    sidecar.contentHash = sri(bytes);
    const file = path.join(root, bodyPath(sidecar.contentHash));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, bytes);
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

/** The body file a capture key's sidecar names (content-addressed). */
async function bodyFileFor(root, key) {
  const hash = await captureHash(key);
  const sidecar = JSON.parse(await fsp.readFile(path.join(root, 'meta', hash.slice(0, 2), `${hash}.json`), 'utf8'));
  return path.join(root, bodyPath(sidecar.contentHash));
}

/** Overwrite one remastered body by capture key in place (a defect injector). */
async function overwriteBody(root, key, bytes) {
  await fsp.writeFile(await bodyFileFor(root, key), bytes);
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

describe('remaster verify static — upstream URLs, classified and deduped', () => {
  const OTHER = '20200101000000';
  // A store-held capture whose ref the rewriter left absolute (protocol-relative
  // JS concatenation): a rewriter miss, not a fetch gap.
  const MISS_REF = `//web.archive.org/web/${TS}im_/http://example.com/logo.png`;
  const BEACON_REF = `https://web.archive.org/web/${OTHER}im_/http://www.google-analytics.com/__utm.gif?utmn=1`;
  const FRONTIER_KEY = `${TS}/http://example.com/missing.css`;
  const DYNAMIC_KEY = `${TS}/http://example.com/late.js`;
  const RESOURCE_KEY = `${OTHER}/http://other.test/lib.js`;
  const PAGE_KEY = `${OTHER}/http://other.test/about`;
  const BARE_URL = 'https://web-static.archive.org/_static/css/banner.css';

  /** Remaster a root whose doc records a frontier, then plant upstream refs in two bodies. */
  async function buildUpstreamTree() {
    const hermetic = await mkroot('remaster-verify-upstream-src-');
    await writeEntry(hermetic, {
      key: DOC_KEY,
      contentType: 'text/html',
      body: '<html><body>clean</body></html>',
      requisites: [IMG_KEY, FRONTIER_KEY],
      dynamic: [{ key: DYNAMIC_KEY, flag: 'js_', via: 'remaster-verify' }]
    });
    await writeEntry(hermetic, { key: JS_KEY, contentType: 'application/javascript', flag: 'js_', body: 'var a = 1;' });
    await writeEntry(hermetic, { key: IMG_KEY, contentType: 'image/png', flag: 'im_', body: '\x89PNG' });
    const out = await mkroot('remaster-verify-upstream-out-');
    await remaster(hermetic, out);
    await overwriteBody(
      out,
      DOC_KEY,
      bytesOf(
        [
          '<html><head>',
          `<link rel="stylesheet" href="${BARE_URL}">`,
          `<link rel="stylesheet" href="https://web.archive.org/web/${TS}cs_/http://example.com/missing.css">`,
          `<script src="https://web.archive.org/web/${OTHER}js_/http://other.test/lib.js"></script>`,
          `<script src="https://web.archive.org/web/${OTHER}js_/http://other.test/lib.js"></script>`,
          `</head><body><img src="${BEACON_REF}">`,
          `<a href="https://web.archive.org/web/${OTHER}/http://other.test/about">about</a>`,
          '</body></html>'
        ].join('')
      )
    );
    await overwriteBody(
      out,
      JS_KEY,
      bytesOf(
        [
          `var u = location.protocol + '${MISS_REF}';`,
          `var d = "https://web.archive.org/web/${TS}js_/http:/example.com/late.js";`,
          `var r = "https://web.archive.org/web/${OTHER}js_/http://other.test/lib.js";`
        ].join('\n')
      )
    );
    return { hermetic, out };
  }

  it('scanBody records the upstream URL and the key the server resolves', () => {
    const js = `var u = "https://web.archive.org/web/${TS}js_/http:/example.com/a.js";`;
    const [finding] = scanBody('k', js);
    assert.equal(finding.kind, 'archive-org');
    assert.equal(finding.url, `https://web.archive.org/web/${TS}js_/http:/example.com/a.js`);
    // The proxy-flattened `http:/` is repaired the way the serving parser repairs it.
    assert.equal(finding.upstreamKey, `${TS}/http://example.com/a.js`);
  });

  it('scanBody catches a protocol-relative ref inside a JS concatenation', () => {
    const findings = scanBody('k', `var u = location.protocol + '${MISS_REF}';`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].url, MISS_REF);
    assert.equal(findings[0].upstreamKey, IMG_KEY);
  });

  it('scanBody tags a non-/web/ archive.org byte run as archive-org-bare, once', () => {
    const html = `<script src="${BARE_URL}"></script><img src="https://web.archive.org/web/${TS}im_/http://example.com/x.png">`;
    const findings = scanBody('k', html);
    assert.deepEqual(
      findings.map(f => f.kind),
      ['archive-org-bare', 'archive-org'],
      'in byte order, and the archive.org bytes inside a /web/ ref are owned by that ref, not double-counted'
    );
    const bare = findings.find(f => f.kind === 'archive-org-bare');
    assert.equal(bare.url, BARE_URL);
    assert.equal(bare.upstreamKey, undefined);
  });

  it('scanBody decodes HTML entities for the key only when asked', () => {
    const html = `<a href="https://web.archive.org/web/${TS}/http://example.com/?a=1&amp;b=2">x</a>`;
    assert.equal(scanBody('k', html, { html: true })[0].upstreamKey, `${TS}/http://example.com/?a=1&b=2`);
    assert.equal(scanBody('k', html)[0].upstreamKey, `${TS}/http://example.com/?a=1&amp;b=2`);
  });

  it('foreign content: an SVG or MathML script, style, or title is ordinary markup, and an integration point returns to HTML', () => {
    const ref = `https://web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2`;
    const decoded = `${TS}/http://example.com/endpoint?a=1&b=2`;
    const raw = `${TS}/http://example.com/endpoint?a=1&amp;b=2`;
    const keys = html => scanBody('k', html, { html: true }).map(f => f.upstreamKey);
    // The probe cases: no content state switch inside <svg> or <math>.
    assert.deepEqual(keys(`<svg><script>u="${ref}"</script></svg>`), [decoded], 'svg script');
    assert.deepEqual(keys(`<svg><style>p{background:url(${ref})}</style></svg>`), [decoded], 'svg style');
    assert.deepEqual(keys(`<math><style>u="${ref}"</style></math>`), [decoded], 'math style');
    assert.deepEqual(keys(`<svg><title><script>u="${ref}"</script></title></svg>`), [raw], 'svg title is an integration point, so its script is HTML script');
    // Integration points and breakouts return to the HTML rules.
    assert.deepEqual(keys(`<svg><foreignObject><script>u="${ref}"</script></foreignObject><script>u="${ref}"</script></svg>`), [raw, decoded], 'foreignObject');
    assert.deepEqual(keys(`<math><annotation-xml encoding="text/html"><script>u="${ref}"</script></annotation-xml></math>`), [raw], 'annotation-xml text/html');
    assert.deepEqual(keys(`<math><annotation-xml><script>u="${ref}"</script></annotation-xml></math>`), [decoded], 'annotation-xml without an HTML encoding');
    assert.deepEqual(keys(`<svg><div><script>u="${ref}"</script></div></svg>`), [raw], 'an HTML <div> breaks out of foreign content');
    assert.deepEqual(keys(`<svg/><script>u="${ref}"</script>`), [raw], 'a self-closing <svg/> opens nothing');
    assert.deepEqual(keys(`<svg><script>u="${ref}"</script></svg><script>u="${ref}"</script>`), [decoded, raw], 'after </svg> the HTML rules return');
    // A foreign <style> is CSS: decoded, and a resource position.
    const { residual } = classifyUpstream(scanBody('k', `<svg><style>p{background:url(https://web.archive.org/web/${OTHER}/http://assets.example.com/bg)}</style></svg>`, { html: true }), new Set(), new Set());
    assert.equal(residual.classes.novelResource.count, 1);
  });

  it('an SVG script ref with an entity resolves to the stored capture and fails the layer as inStore', async () => {
    const storedKey = `${TS}/http://example.com/endpoint?a=1&b=2`;
    const hermetic = await mkroot('remaster-verify-svg-script-src-');
    await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: '<html></html>', requisites: [storedKey] });
    await writeEntry(hermetic, { key: storedKey, contentType: 'application/json', body: '{}' });
    const out = await mkroot('remaster-verify-svg-script-out-');
    await remaster(hermetic, out);
    await overwriteBody(out, DOC_KEY, bytesOf(`<html><body><svg><script>u="https://web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2"</script></svg></body></html>`));
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.inStore.entries.map(e => e.key), [storedKey]);
    assert.equal(report.pass, false);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a tag or attribute named after an Object property is an unknown tag, with no finding and no throw', () => {
    const stem = `https://web.archive.org/web/${OTHER}/http://assets.example.com/`;
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepEqual(scanBody('k', `<${name}>clean</${name}>`, { html: true }), [], name);
      assert.deepEqual(scanBody('k', `<${name} id="x">clean</${name}>`, { html: true }), [], `${name} with an attribute`);
      assert.deepEqual(scanBody('k', `<p ${name}="x">clean</p>`, { html: true }), [], `attribute ${name}`);
      // An unknown tag with a URL attribute is still a resource position. `<__proto__`
      // is not a tag at all (a tag name starts with a letter), so its URL is text.
      const [finding] = scanBody('k', `<${name} src="${stem}logo">x</${name}>`, { html: true });
      assert.equal(finding.resource, name !== '__proto__', `${name} src`);
    }
    // An attribute named `constructor` beside a real src: the src keeps its position.
    const [finding] = scanBody('k', `<img constructor="x" src="${stem}logo">`, { html: true });
    assert.equal(finding.resource, true);
  });

  it('scanBody keeps byte offsets across CRLF line ends and unquoted values', () => {
    const decoded = `${TS}/http://example.com/?a=1&b=2`;
    const html = `<html>\r\n<body>\r\n<img\r\n  alt=logo\r\n  src=https://web.archive.org/web/${TS}/http://example.com/?a=1&amp;b=2\r\n>\r\n</body></html>`;
    const [finding] = scanBody('k', html, { html: true });
    assert.equal(finding.upstreamKey, decoded);
    assert.equal(finding.resource, true);
    assert.equal(html.slice(finding.offset, finding.offset + 'archive.org'.length), 'archive.org');
  });

  it('scanBody keeps entity text raw inside HTML script and style blocks', () => {
    const ref = `//web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2`;
    const html = [
      `<img src="https:${ref}">`,
      `<script>var u = location.protocol + '${ref}';</script>`,
      `<STYLE>body{background:url(${ref})}</STYLE>`
    ].join('');
    assert.deepEqual(
      scanBody('k', html, { html: true }).map(f => f.upstreamKey),
      [`${TS}/http://example.com/endpoint?a=1&b=2`, `${TS}/http://example.com/endpoint?a=1&amp;b=2`, `${TS}/http://example.com/endpoint?a=1&amp;b=2`]
    );
  });

  it('a quoted ">" inside a script open tag does not end the tag early', () => {
    const src = `https://web.archive.org/web/${TS}/http://example.com/loader?a=1&amp;b=2`;
    const inline = `//web.archive.org/web/${TS}/http://example.com/inline?a=1&amp;b=2`;
    for (const note of [`"a > b"`, `'a > b'`]) {
      const html = `<html><body><script data-note=${note} src="${src}"></script><script data-x=${note}>var u = '${inline}';</script></body></html>`;
      assert.deepEqual(
        scanBody('k', html, { html: true }).map(f => f.upstreamKey),
        [`${TS}/http://example.com/loader?a=1&b=2`, `${TS}/http://example.com/inline?a=1&amp;b=2`],
        note
      );
    }
  });

  it('a "<script>" token inside a comment or an attribute value does not open a raw-text span', () => {
    const img = `<img data-note="a > b" src="https://web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2">`;
    const decoded = `${TS}/http://example.com/endpoint?a=1&b=2`;
    const decoys = [
      '',
      '<!-- <script> -->',
      '<div title="<script>"></div>',
      '<!DOCTYPE html><?xml version="1.0"?>',
      '<p>a < b</p>',
      // A `<script>` token inside an element the tokenizer reads as text is text.
      '<title><script></title>',
      '<textarea><script></textarea>',
      '<xmp><script></xmp>',
      '<iframe><script></iframe>',
      '<noembed><script></noembed>',
      '<noframes><script></noframes>',
      '<noscript><style></noscript>'
    ];
    for (const decoy of decoys) {
      assert.deepEqual(scanBody('k', decoy + img, { html: true }).map(f => f.upstreamKey), [decoded], decoy || 'control');
    }
    // A ref inside RCDATA (textarea) decodes. A ref inside RAWTEXT (xmp) keeps
    // its entity text, and so does everything after a <plaintext> tag.
    const ref = `https://web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2`;
    const raw = `${TS}/http://example.com/endpoint?a=1&amp;b=2`;
    assert.deepEqual(scanBody('k', `<textarea>${ref}</textarea>`, { html: true }).map(f => f.upstreamKey), [decoded]);
    assert.deepEqual(scanBody('k', `<xmp>${ref}</xmp>${img}`, { html: true }).map(f => f.upstreamKey), [raw, decoded]);
    assert.deepEqual(scanBody('k', `<plaintext>${ref}</plaintext>${img}`, { html: true }).map(f => f.upstreamKey), [raw, raw]);
    // A real script block after the decoys still keeps its text raw.
    const inline = `//web.archive.org/web/${TS}/http://example.com/inline?a=1&amp;b=2`;
    const html = `<!-- <script> --><div title="<script>"></div><script>var u = '${inline}';</script>${img}`;
    assert.deepEqual(
      scanBody('k', html, { html: true }).map(f => f.upstreamKey),
      [`${TS}/http://example.com/inline?a=1&amp;b=2`, decoded]
    );
  });

  it('a comment or attribute "<script>" decoy before an in-store ref still fails the layer as inStore', async () => {
    const storedKey = `${TS}/http://example.com/endpoint?a=1&b=2`;
    const img = `<img data-note="a > b" src="https://web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2">`;
    const decoys = ['<!-- <script> -->', '<div title="<script>"></div>', '<title><script></title>', '<textarea><script></textarea>', '<xmp><script></xmp>', '<noscript><style></noscript>'];
    for (const decoy of decoys) {
      const hermetic = await mkroot('remaster-verify-decoy-src-');
      await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: '<html></html>' });
      await writeEntry(hermetic, { key: storedKey, contentType: 'application/json', body: '{}' });
      const out = await mkroot('remaster-verify-decoy-out-');
      await remaster(hermetic, out);
      await overwriteBody(out, DOC_KEY, bytesOf(`<html><body>${decoy}${img}</body></html>`));
      const report = await scanEscapes(await enumerateRemastered(out));
      assert.deepEqual(report.residual.classes.inStore.entries.map(e => e.key), [storedKey], decoy);
      assert.equal(report.pass, false, decoy);
      await fsp.rm(hermetic, { recursive: true, force: true });
      await fsp.rm(out, { recursive: true, force: true });
    }
  });

  it('a script src after a quoted ">" resolves to the stored capture', async () => {
    const storedKey = `${TS}/http://example.com/loader?a=1&b=2`;
    const hermetic = await mkroot('remaster-verify-quoted-src-');
    await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: '<html></html>' });
    await writeEntry(hermetic, { key: storedKey, contentType: 'application/javascript', body: 'var a = 1;' });
    const out = await mkroot('remaster-verify-quoted-out-');
    await remaster(hermetic, out);
    const doc = `<html><body><script data-note="a > b" src="https://web.archive.org/web/${TS}/http://example.com/loader?a=1&amp;b=2"></script></body></html>`;
    await overwriteBody(out, DOC_KEY, bytesOf(doc));
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.inStore.entries.map(e => e.key), [storedKey]);
    assert.equal(report.pass, false);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('an entity-encoded ref resolves to the stored capture in its own HTML context', async () => {
    const decodedKey = `${TS}/http://example.com/endpoint?a=1&b=2`;
    const rawKey = `${TS}/http://example.com/raw?a=1&amp;b=2`;
    const hermetic = await mkroot('remaster-verify-entities-src-');
    await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: '<html></html>' });
    await writeEntry(hermetic, { key: decodedKey, contentType: 'application/json', body: '{}' });
    await writeEntry(hermetic, { key: rawKey, contentType: 'application/json', body: '{}' });
    const out = await mkroot('remaster-verify-entities-out-');
    await remaster(hermetic, out);
    const doc = [
      `<html><body><img src="https://web.archive.org/web/${TS}/http://example.com/endpoint?a=1&amp;b=2">`,
      `<script>var u = location.protocol + '//web.archive.org/web/${TS}/http://example.com/raw?a=1&amp;b=2';</script>`,
      '</body></html>'
    ].join('');
    await overwriteBody(out, DOC_KEY, bytesOf(doc));
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.inStore.entries.map(e => e.key), [decodedKey, rawKey].sort());
    assert.equal(report.residual.classes.novelPage.count, 0);
    assert.equal(report.pass, false);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('scanBody drops the #fragment from the key and keeps it in the reported URL', () => {
    const [finding] = scanBody('k', `x = '//web.archive.org/web/${TS}/http://example.com/page#section';`);
    assert.equal(finding.url, `//web.archive.org/web/${TS}/http://example.com/page#section`);
    assert.equal(finding.upstreamKey, `${TS}/http://example.com/page`);
  });

  it('fragment variants resolve to the stored or recorded target and dedupe to one entry', async () => {
    const pageKey = `${TS}/http://example.com/page`;
    const hermetic = await mkroot('remaster-verify-fragment-src-');
    await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: '<html></html>', requisites: [FRONTIER_KEY] });
    await writeEntry(hermetic, { key: JS_KEY, contentType: 'application/javascript', flag: 'js_', body: 'var a = 1;' });
    await writeEntry(hermetic, { key: pageKey, contentType: 'text/html', body: '<html></html>' });
    const out = await mkroot('remaster-verify-fragment-out-');
    await remaster(hermetic, out);
    const js = [
      `var a = location.protocol + '//web.archive.org/web/${TS}/http://example.com/page#section';`,
      `var b = location.protocol + '//web.archive.org/web/${TS}/http://example.com/page#other';`,
      `var c = "https://web.archive.org/web/${TS}cs_/http://example.com/missing.css#x";`
    ].join('\n');
    await overwriteBody(out, JS_KEY, bytesOf(js));
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.inStore.entries.map(e => e.key), [pageKey]);
    assert.deepEqual(report.residual.classes.inRecordedFrontier.entries.map(e => e.key), [FRONTIER_KEY]);
    assert.equal(report.residual.classes.novelPage.count, 0);
    assert.equal(report.residual.occurrences, 3);
    assert.equal(report.residual.distinct, 2);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a keyless archive.org ref fails unless isUnmirrorable exempts its original', () => {
    const classify = ref => {
      const { residual, findings } = classifyUpstream(scanBody('k', `<img src="${ref}">`), new Set(), new Set());
      const [id] = Object.entries(residual.classes).find(([, c]) => c.count > 0);
      return { id, failing: findings.length };
    };
    // A relative original: no key, but a live archive.org request all the same.
    assert.deepEqual(classify(`https://web.archive.org/web/${TS}im_/images/x.gif`), { id: 'unresolved', failing: 1 });
    // A bare root path original.
    assert.deepEqual(classify(`https://web.archive.org/web/${TS}im_//`), { id: 'unresolved', failing: 1 });
    // A pseudo URL is unmirrorable by isUnmirrorable, so it stays excluded.
    assert.deepEqual(classify(`https://web.archive.org/web/${TS}/javascript:void(0)`), { id: 'unmirrorable', failing: 0 });
  });

  it('a subresource replay flag alone makes a novel upstream ref resource-like', () => {
    const classOf = ref => {
      const { residual } = classifyUpstream(scanBody('k', `x = "${ref}";`), new Set(), new Set());
      return Object.entries(residual.classes).find(([, c]) => c.count > 0)[0];
    };
    assert.equal(classOf(`https://web.archive.org/web/${OTHER}js_/http://other.test/loader`), 'novelResource');
    assert.equal(classOf(`https://web.archive.org/web/${OTHER}/http://other.test/loader`), 'novelPage');
  });

  it('every non-navigational position is a resource whatever its extension', () => {
    const classOf = (body, options) => {
      const { residual } = classifyUpstream(scanBody('k', body, options), new Set(), new Set());
      return Object.entries(residual.classes).find(([, c]) => c.count > 0)[0];
    };
    const stem = `https://web.archive.org/web/${OTHER}/http://assets.example.com/`;
    // CSS text loads whatever url() and @import name.
    assert.equal(classOf(`body { background: url(${stem}logo) }`, { css: true }), 'novelResource');
    assert.equal(classOf(`@import "${stem}theme";`, { css: true }), 'novelResource');
    assert.equal(classOf(`<div style="background:url('${stem}bg')"></div>`, { html: true }), 'novelResource');
    assert.equal(classOf(`<style>p{background:url(${stem}bg)}</style>`, { html: true }), 'novelResource');
    // HTML and SVG load positions.
    const resources = [
      `<img data-note="a > b" src="${stem}logo">`,
      `<img srcset="${stem}a 1x, ${stem}b 2x">`,
      `<video poster="${stem}cover"></video>`,
      `<link href="${stem}theme" rel="stylesheet">`,
      `<link rel="shortcut icon" href="${stem}favicon">`,
      `<link rel="alternate stylesheet" href="${stem}alt">`,
      `<link rel="alternate" type="text/css" href="${stem}alt2">`,
      // A resource rel token wins over a navigational one.
      `<link rel="canonical preload" as="image" href="${stem}logo7">`,
      `<link rel="alternate icon" href="${stem}favicon2">`,
      `<link rel="prev modulepreload" href="${stem}mod">`,
      `<link rel="author" href="${stem}author">`,
      `<link href="${stem}norel">`,
      `<svg><image href="${stem}logo"/></svg>`,
      `<svg><use xlink:href="${stem}sprite#i"/></svg>`,
      `<svg><image xlink:href="${stem}logo2"/></svg>`,
      `<object data="${stem}movie"></object>`,
      `<embed src="${stem}plugin">`,
      `<video><track src="${stem}captions"></video>`,
      `<input type="image" src="${stem}button">`,
      `<img alt="a<b" src="${stem}logo3">`,
      // Unquoted and single-quoted values are attribute values all the same.
      `<img alt=logo src=${stem}logo4>`,
      `<link rel=stylesheet href=${stem}theme2>`,
      `<img alt='logo' src='${stem}logo5'>`,
      `<IMG SRC=${stem}logo6 ALT=x>`
    ];
    for (const body of resources) assert.equal(classOf(body, { html: true }), 'novelResource', body);
    // Only a navigational position, text content, or JS text reads as a page.
    const pages = [
      `<a href="${stem}about">about</a>`,
      `<area href="${stem}map" shape="rect">`,
      `<form action="${stem}submit"></form>`,
      `<button formaction="${stem}go">go</button>`,
      `<link rel="canonical" href="${stem}about">`,
      `<link rel="next" href="${stem}page2">`,
      `<link rel="alternate" hreflang="fr" href="${stem}fr">`,
      `<link rel="canonical alternate" href="${stem}both">`,
      `<link REL="Canonical" href="${stem}upper">`,
      // The exact `rel` attribute decides, not a `data-rel` or another value that contains the word.
      `<link data-rel="stylesheet" rel="canonical" href="${stem}about2">`,
      `<link title="stylesheet" rel=canonical href=${stem}about3>`,
      `<a data-src="x" href="${stem}about4">x</a>`,
      `<p>${stem}about</p>`
    ];
    for (const body of pages) assert.equal(classOf(body, { html: true }), 'novelPage', body);
    assert.equal(classOf(`var p = "${stem}about";`), 'novelPage');
  });

  it('an extensionless CSS url() in a stylesheet body fails the layer as novelResource', async () => {
    const hermetic = await mkroot('remaster-verify-css-resource-src-');
    await writeEntry(hermetic, {
      key: CSS_KEY,
      contentType: 'text/css',
      body: `body { background: url(https://web.archive.org/web/${OTHER}/http://assets.example.com/logo) }`
    });
    const out = await mkroot('remaster-verify-css-resource-out-');
    await remaster(hermetic, out);
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.novelResource.entries.map(e => e.key), [`${OTHER}/http://assets.example.com/logo`]);
    assert.equal(report.residual.classes.novelPage.count, 0);
    assert.equal(report.pass, false);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('an unquoted src or stylesheet href fails the layer as novelResource, and a data-rel decoy stays a page', async () => {
    const stem = `https://web.archive.org/web/${OTHER}/http://assets.example.com/`;
    const cases = [
      [`<img alt=logo src=${stem}logo>`, 'novelResource', `${OTHER}/http://assets.example.com/logo`],
      [`<link rel=stylesheet href=${stem}theme>`, 'novelResource', `${OTHER}/http://assets.example.com/theme`],
      [`<link data-rel="stylesheet" rel="canonical" href="${stem}about">`, 'novelPage', `${OTHER}/http://assets.example.com/about`],
      [`<link rel="canonical preload" as="image" href="${stem}logo2">`, 'novelResource', `${OTHER}/http://assets.example.com/logo2`],
      [`<link rel="alternate stylesheet" href="${stem}alt">`, 'novelResource', `${OTHER}/http://assets.example.com/alt`]
    ];
    for (const [body, cls, key] of cases) {
      const hermetic = await mkroot('remaster-verify-attr-form-src-');
      await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: `<html><body>${body}</body></html>` });
      const out = await mkroot('remaster-verify-attr-form-out-');
      await remaster(hermetic, out);
      const report = await scanEscapes(await enumerateRemastered(out));
      assert.deepEqual(report.residual.classes[cls].entries.map(e => e.key), [key], body);
      assert.equal(report.pass, cls === 'novelPage', body);
      await fsp.rm(hermetic, { recursive: true, force: true });
      await fsp.rm(out, { recursive: true, force: true });
    }
  });

  it('an extensionless SVG image href or use xlink:href fails the layer as novelResource', async () => {
    const stem = `https://web.archive.org/web/${OTHER}/http://assets.example.com/`;
    const hermetic = await mkroot('remaster-verify-svg-resource-src-');
    await writeEntry(hermetic, {
      key: DOC_KEY,
      contentType: 'text/html',
      body: `<html><body><svg><image href="${stem}logo"/><use xlink:href="${stem}sprite#i"/></svg></body></html>`
    });
    const out = await mkroot('remaster-verify-svg-resource-out-');
    await remaster(hermetic, out);
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.novelResource.entries.map(e => e.key), [`${OTHER}/http://assets.example.com/logo`, `${OTHER}/http://assets.example.com/sprite`]);
    assert.equal(report.residual.classes.novelPage.count, 0);
    assert.equal(report.pass, false);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a store or frontier key that carries a #fragment still matches its upstream ref', async () => {
    const storedKey = `${TS}/http://example.com/icons.svg#home`;
    const recordedKey = `${TS}/http://example.com/sprite.svg#top`;
    const hermetic = await mkroot('remaster-verify-hashkey-src-');
    await writeEntry(hermetic, { key: DOC_KEY, contentType: 'text/html', body: '<html></html>', requisites: [storedKey, recordedKey] });
    await writeEntry(hermetic, { key: JS_KEY, contentType: 'application/javascript', flag: 'js_', body: 'var a = 1;' });
    await writeEntry(hermetic, { key: storedKey, contentType: 'image/svg+xml', flag: 'im_', body: '<svg/>' });
    const out = await mkroot('remaster-verify-hashkey-out-');
    await remaster(hermetic, out);
    const js = [
      `var a = location.protocol + '//web.archive.org/web/${TS}im_/http://example.com/icons.svg#home';`,
      `var b = location.protocol + '//web.archive.org/web/${TS}im_/http://example.com/sprite.svg#top';`
    ].join('\n');
    await overwriteBody(out, JS_KEY, bytesOf(js));
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.deepEqual(report.residual.classes.inStore.entries.map(e => e.key), [`${TS}/http://example.com/icons.svg`]);
    assert.deepEqual(report.residual.classes.inRecordedFrontier.entries.map(e => e.key), [`${TS}/http://example.com/sprite.svg`]);
    assert.equal(report.residual.classes.novelResource.count, 0);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('scanEscapes classifies each DISTINCT upstream key and dedupes across bodies', async () => {
    const { hermetic, out } = await buildUpstreamTree();
    const report = await scanEscapes(await enumerateRemastered(out));
    const keysOf = id => report.residual.classes[id].entries.map(e => e.key ?? e.url);
    assert.deepEqual(keysOf('inStore'), [IMG_KEY]);
    assert.deepEqual(keysOf('inRecordedFrontier'), [DYNAMIC_KEY, FRONTIER_KEY]);
    assert.deepEqual(keysOf('novelResource'), [RESOURCE_KEY]);
    assert.deepEqual(keysOf('novelPage'), [PAGE_KEY]);
    assert.deepEqual(keysOf('unmirrorable'), [`${OTHER}/http://www.google-analytics.com/__utm.gif?utmn=1`]);
    assert.deepEqual(keysOf('bare'), [BARE_URL]);
    // lib.js is referenced upstream three times across two bodies: one distinct entry, two docs.
    assert.equal(report.residual.classes.novelResource.entries[0].docs, 2);
    assert.equal(report.residual.occurrences, 9);
    assert.equal(report.residual.distinct, 7);
    assert.equal(report.counts.distinct, 7);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('the verdict is split: misses and fetchable gaps fail, out-of-scope pages advise, unmirrorable is excluded', async () => {
    const { hermetic, out } = await buildUpstreamTree();
    const report = await scanEscapes(await enumerateRemastered(out));
    const status = Object.fromEntries(Object.entries(report.residual.classes).map(([id, c]) => [id, c.status]));
    assert.deepEqual(status, {
      inStore: 'fail',
      inRecordedFrontier: 'fail',
      novelResource: 'fail',
      bare: 'fail',
      unresolved: 'fail',
      novelPage: 'advisory',
      unmirrorable: 'excluded'
    });
    assert.equal(report.pass, false);
    // One finding per distinct FAILING upstream URL, never one per byte occurrence.
    assert.deepEqual(report.findings.map(f => f.class).sort(), ['bare', 'inRecordedFrontier', 'inRecordedFrontier', 'inStore', 'novelResource']);
    const lib = report.findings.find(f => f.upstreamKey === RESOURCE_KEY);
    assert.equal(lib.docs, 2);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('a tree whose only upstream refs are out-of-scope pages and beacons passes the escape layer', async () => {
    const hermetic = await buildCleanRoot();
    const out = await mkroot('remaster-verify-advisory-');
    await remaster(hermetic, out);
    await overwriteBody(out, JS_KEY, bytesOf(`var p = "https://web.archive.org/web/${OTHER}/http://other.test/about"; var b = "${BEACON_REF}";`));
    const report = await scanEscapes(await enumerateRemastered(out));
    assert.equal(report.pass, true, JSON.stringify(report.findings, null, 2));
    assert.deepEqual(report.findings, []);
    assert.equal(report.residual.classes.novelPage.count, 1);
    assert.equal(report.residual.classes.unmirrorable.count, 1);
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });

  it('formatReport prints classified counts and upstream URLs, not byte offsets', async () => {
    const { hermetic, out } = await buildUpstreamTree();
    const layer = await scanEscapes(await enumerateRemastered(out));
    const text = formatReport({ root: out, pass: false, layers: [layer] });
    assert.match(text, /rewriter miss.*· 1 · FAIL/);
    assert.match(text, /out of scope.*· 1 · ADVISORY/);
    assert.match(text, /unmirrorable.*· 1 · EXCLUDED/);
    assert.ok(text.includes(IMG_KEY), text);
    assert.ok(text.includes(`${RESOURCE_KEY} (2 docs)`), text);
    assert.doesNotMatch(text, / @\d+/, 'no raw byte offsets in the escape summary');
    await fsp.rm(hermetic, { recursive: true, force: true });
    await fsp.rm(out, { recursive: true, force: true });
  });
});

describe('remaster verify — the tree reader takes sidecar v3 only', () => {
  it('enumerateRemastered rejects an older or unknown sidecar version with a clear error', async () => {
    for (const v of [1, 2, 99]) {
      const root = await mkroot(`remaster-verify-sidecar-v${v}-`);
      await writeEntry(root, { key: DOC_KEY, contentType: 'text/html', body: '<p>clean</p>', v });
      await assert.rejects(enumerateRemastered(root), new RegExp(`unsupported sidecar version ${v} .*sidecar v3 only`));
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('a v3 sidecar without a dynamic array reads with an empty frontier', async () => {
    const root = await mkroot('remaster-verify-sidecar-v3-');
    await writeEntry(root, { key: DOC_KEY, contentType: 'text/html', body: '<p>clean</p>' });
    const [entry] = await enumerateRemastered(root);
    assert.deepEqual({ requisites: entry.requisites, dynamic: entry.dynamic }, { requisites: [], dynamic: [] });
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('remaster verify — the tree reader refuses a non-object sidecar', () => {
  it('enumerateRemastered rejects null, [], "x", and 1 with a clear error', async () => {
    const root = await mkroot('wb-verify-nonobject-');
    await writeEntry(root, { key: DOC_KEY, contentType: 'text/html', body: '<html>x</html>' });
    const hash = await captureHash(DOC_KEY);
    const meta = path.join(root, 'meta', hash.slice(0, 2), `${hash}.json`);
    for (const text of ['null', '[]', '"x"', '1']) {
      await fsp.writeFile(meta, text);
      await assert.rejects(enumerateRemastered(root), { message: `remaster verify: malformed sidecar at ${meta} (not a JSON object)` }, text);
    }
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

describe('remaster verify static — the committed fixture stands alone under rule v2 (navigational archive links localize)', () => {
  const FIXTURE = path.resolve(HERE, 'fixtures/cache-root');

  it('remastering the real fixture localizes its uncaptured navigational archive.org links, so the escape scan is clean', async () => {
    const out = await mkroot('remaster-verify-fixture-');
    await remaster(FIXTURE, out);
    const report = await scanEscapes(await enumerateRemastered(out));
    // Rule v2: uncaptured NAVIGATIONAL <a href> refs localize to the mirror form
    // (they funnel to the mirror's own "not mirrored" miss page) instead of
    // staying foreign. The fixture's only surviving escapes — the google.com
    // homepage's links to captures outside the 7-entry corpus, and the stored
    // alpha.jpg wayback error page's links — were all navigational, so the real
    // fixture now stands alone. (Subresource escapes DO stay foreign — covered
    // by the planted-ref tests above.)
    assert.equal(report.pass, true, JSON.stringify(report.findings, null, 2));
    assert.equal(report.findings.length, 0);
    // The mechanism, on a REAL body: the 1998 google.com homepage links to
    // findmail.com (a capture the corpus does not hold) via an ABSOLUTE
    // https://web.archive.org/web/… href. After remaster it is the host-relative
    // mirror form, and no absolute archive origin survives in the served bytes.
    const googleBody = await fsp.readFile(await bodyFileFor(out, '19981202230410/http://www.google.com/'), 'utf8');
    assert.ok(
      googleBody.includes('/web/19981202230410/http://www.findmail.com/list/google-friends/'),
      'the uncaptured navigational link is localized to the mirror form'
    );
    assert.ok(!googleBody.includes('https://web.archive.org'), 'no absolute archive.org origin remains in the served body');
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
