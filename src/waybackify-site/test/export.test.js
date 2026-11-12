// Path-tree export — offline. The root is built through the store's own
// writer (commitEntry), so the export reads exactly what `cache fill` leaves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commitEntry } from '@autocache/waybackify/cache.js';
import { exportTree, planPath } from '../src/export.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-export-'));
const jsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const bytes = s => new TextEncoder().encode(s);
const TS = '20030224204757';
const body = (root, original, text, extra = {}) =>
  commitEntry(root, { key: `${TS}/${original}`, status: 'body', contentType: 'image/gif', body: bytes(text), ...extra });

describe('planPath — capture key → relative path', () => {
  it('lays a capture out as <host>/<timestamp>/<path>', () => {
    assert.equal(planPath(`${TS}/http://www.Example.org:80/a/b.html`), `example.org/${TS}/a/b.html`);
  });
  it('a directory URL becomes index.html; the bare host too', () => {
    assert.equal(planPath(`${TS}/http://example.org/docs/`), `example.org/${TS}/docs/index.html`);
    assert.equal(planPath(`${TS}/http://example.org`), `example.org/${TS}/index.html`);
  });
  it('a non-default port joins the host; a query joins the file name', () => {
    assert.equal(planPath(`${TS}/http://example.org:8080/cgi-bin/x.cgi?a=1&b=/c d`), `example.org_8080/${TS}/cgi-bin/x.cgi%3Fa=1&b=%2Fc%20d`);
  });
  it('dot segments and unparseable originals cannot escape the tree', () => {
    // The URL parser resolves dot segments (encoded or not) before a path is planned.
    assert.equal(planPath(`${TS}/http://example.org/a/%2e%2e/b`), `example.org/${TS}/b`);
    // An encoded slash stays encoded: it never becomes a directory.
    assert.equal(planPath(`${TS}/http://example.org/a%2Fb.gif`), `example.org/${TS}/a%2Fb.gif`);
    assert.equal(planPath(`${TS}/mailto:someone@example.org`), `_unparsed/${TS}/mailto%3Asomeone@example.org`);
  });
  it('an over-long component is cut and keeps a hash', () => {
    const p = planPath(`${TS}/http://example.org/${'x'.repeat(400)}.gif`);
    const name = p.split('/').pop();
    assert.ok(Buffer.byteLength(name) < 200);
    assert.match(name, /~[0-9a-f]{10}\.gif$/);
  });
});

describe('exportTree', () => {
  it('copies every body to its path and indexes it; bodiless sidecars are listed, not exported', async () => {
    const root = tmp();
    const out = tmp();
    await body(root, 'http://example.org/', '<html>home</html>', { contentType: 'text/html', requisites: [`${TS}/http://example.org/img/a.gif`] });
    await body(root, 'http://example.org/img/a.gif', 'GIF89a-a', { flag: 'im_' });
    await commitEntry(root, { key: `${TS}/http://example.org/gone.gif`, status: 'error', contentType: '', flag: 'im_' });

    const summary = exportTree(root, out);
    assert.equal(summary.exported, 2);
    assert.equal(summary.written, 2);
    assert.equal(summary.unexported, 1);
    assert.equal(summary.collisions, 0);
    assert.deepEqual(summary.byHost, { 'example.org': 2 });
    assert.equal(fs.readFileSync(path.join(out, 'example.org', TS, 'index.html'), 'utf8'), '<html>home</html>');
    assert.equal(fs.readFileSync(path.join(out, 'example.org', TS, 'img', 'a.gif'), 'utf8'), 'GIF89a-a');

    const index = jsonl(path.join(out, 'index.jsonl'));
    assert.deepEqual(index.map(r => r.path), [`example.org/${TS}/img/a.gif`, `example.org/${TS}/index.html`]);
    assert.equal(index[0].wayback, `https://web.archive.org/web/${TS}im_/http://example.org/img/a.gif`);
    assert.equal(index[0].role, 'requisite');
    assert.equal(index[0].bytes, 8);
    assert.deepEqual(jsonl(path.join(out, '_unexported.jsonl')).map(r => [r.key, r.status]), [[`${TS}/http://example.org/gone.gif`, 'error']]);
  });

  it('a ledger names the documents and how they were asked for', async () => {
    const root = tmp();
    const out = tmp();
    const ledger = tmp();
    await body(root, 'http://example.org/logo.gif', 'GIF89a-logo');
    await body(root, 'http://example.org/skin.gif', 'GIF89a-skin', { flag: 'im_' });
    fs.mkdirSync(path.join(ledger, 'example.org'));
    fs.writeFileSync(path.join(ledger, 'example.org', 'captures.jsonl'),
      `${JSON.stringify({ wayback: `https://web.archive.org/web/${TS}id_/http://example.org/logo.gif`, rank: 3 })}\n`);

    const summary = exportTree(root, out, { ledger });
    assert.equal(summary.documents, 1);
    assert.equal(summary.requisites, 1);
    const doc = jsonl(path.join(out, 'index.jsonl')).find(r => r.role === 'document');
    assert.equal(doc.wayback, `https://web.archive.org/web/${TS}id_/http://example.org/logo.gif`);
    assert.deepEqual(doc.files, ['example.org/captures.jsonl']);
    assert.equal(doc.rank, 3);
  });

  it('resolves case clashes and file/directory clashes the same way on every filesystem, and says so', async () => {
    const root = tmp();
    const out = tmp();
    await body(root, 'http://example.org/img/E.gif', 'GIF89a-upper');
    await body(root, 'http://example.org/img/e.gif', 'GIF89a-lower');
    await body(root, 'http://example.org/docs', '<html>docs as a file</html>', { contentType: 'text/html' });
    await body(root, 'http://example.org/docs/page.html', '<html>page</html>', { contentType: 'text/html' });
    await body(root, 'http://example.org/Docs/other.html', '<html>other</html>', { contentType: 'text/html' });

    const summary = exportTree(root, out);
    assert.equal(summary.exported, 5);
    const index = Object.fromEntries(jsonl(path.join(out, 'index.jsonl')).map(r => [r.original, r.path]));
    // Both GIFs exist, under different names, with their own bytes.
    assert.equal(index['http://example.org/img/E.gif'], `example.org/${TS}/img/E.gif`);
    assert.equal(index['http://example.org/img/e.gif'], `example.org/${TS}/img/e~2.gif`);
    assert.equal(fs.readFileSync(path.join(out, ...index['http://example.org/img/E.gif'].split('/')), 'utf8'), 'GIF89a-upper');
    assert.equal(fs.readFileSync(path.join(out, ...index['http://example.org/img/e.gif'].split('/')), 'utf8'), 'GIF89a-lower');
    // A URL that is both a file and a directory keeps both, and a directory
    // spelled two ways is one directory — under its first spelling in
    // code-unit order (`Docs` sorts before `docs`).
    assert.equal(index['http://example.org/docs'], `example.org/${TS}/Docs/index.html`);
    assert.equal(fs.readFileSync(path.join(out, 'example.org', TS, 'Docs', 'index.html'), 'utf8'), '<html>docs as a file</html>');
    assert.equal(path.dirname(index['http://example.org/Docs/other.html']), path.dirname(index['http://example.org/docs/page.html']));

    const kinds = jsonl(path.join(out, '_collisions.jsonl')).map(c => c.kind).sort();
    // One row per adjusted file: both files under `docs/` moved to `Docs/`.
    assert.deepEqual(kinds, ['case-collision', 'directory-case-merged', 'directory-case-merged', 'file-is-also-directory']);
    assert.equal(summary.collisions, 4);
  });

  it('a re-run rewrites nothing; a capture that left the root leaves the tree', async () => {
    const root = tmp();
    const out = tmp();
    await body(root, 'http://example.org/a.gif', 'GIF89a-a');
    const stub = await commitEntry(root, { key: `${TS}/http://example.org/b.gif`, status: 'body', contentType: 'image/gif', body: bytes('GIF89a-b') });
    exportTree(root, out);
    const again = exportTree(root, out);
    assert.equal(again.written, 0);
    assert.equal(again.unchanged, 2);

    // The store re-commits b.gif as an error (same key, bodiless now).
    assert.equal(stub.status, 'body');
    await commitEntry(root, { key: `${TS}/http://example.org/b.gif`, status: 'error', contentType: '' });
    const third = exportTree(root, out);
    assert.equal(third.removed, 1);
    assert.ok(!fs.existsSync(path.join(out, 'example.org', TS, 'b.gif')));
    assert.ok(fs.existsSync(path.join(out, 'example.org', TS, 'a.gif')));
  });

  it('dryRun plans and counts but writes nothing', async () => {
    const root = tmp();
    const out = path.join(tmp(), 'tree');
    await body(root, 'http://example.org/a.gif', 'GIF89a-a');
    const summary = exportTree(root, out, { dryRun: true });
    assert.equal(summary.exported, 1);
    assert.equal(summary.written, 0);
    assert.ok(!fs.existsSync(out));
  });

  it('refuses to write inside the cache root, and refuses a directory that is not a root', async () => {
    const root = tmp();
    await body(root, 'http://example.org/a.gif', 'GIF89a-a');
    assert.throws(() => exportTree(root, path.join(root, 'export')), /must be outside the cache root/);
    assert.throws(() => exportTree(tmp(), tmp()), /no meta\/ under .* — not a cache root/);
    assert.deepEqual(fs.readdirSync(root).sort(), ['cap', 'meta', 'tmp']);
  });
});
