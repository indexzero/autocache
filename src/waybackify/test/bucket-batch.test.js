// Tests for the cap/ bucket-population batch emitter (#291).
//
// The synthetic roots are built with the REAL writer (cache.js#commitEntry) so
// the fixtures are byte-valid sidecars, never hand-shaped JSON — except the two
// tamper cases (bad schema version, oversized content-type), which by
// definition cannot come out of the validated writer and are written by hand at
// the canonical path.
import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commitEntry } from '../cache.js';
import { capturePath, metaPath } from '../key.js';
import { emitBucketBatch, emitLine, shellQuote } from '../bucket-batch.js';

const execFileP = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/emit-bucket-batch.js', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../../render/wayback/test/fixtures/cache-root', import.meta.url));

async function mkRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'bucket-batch-'));
}

describe('shellQuote', () => {
  it('passes hash-named keys and s3:// URLs through verbatim', () => {
    assert.equal(shellQuote('cap/58/58a9d3a4'), 'cap/58/58a9d3a4');
    assert.equal(shellQuote('s3://bucket/cap/58/58a9d3a4'), 's3://bucket/cap/58/58a9d3a4');
    assert.equal(shellQuote('image/jpeg'), 'image/jpeg');
    assert.equal(shellQuote('status=body'), 'status=body');
  });

  it('single-quotes values with spaces or semicolons', () => {
    assert.equal(shellQuote('text/html; charset=utf-8'), "'text/html; charset=utf-8'");
  });

  it('escapes embedded single quotes with the POSIX `\\x27\\x5c\\x27\\x27` idiom', () => {
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
    assert.equal(shellQuote(''), "''");
  });
});

describe('emitLine', () => {
  it('omits --content-type when contentType is ""', () => {
    const line = emitLine({ contentType: '', status: 'body' }, '/r/cap/aa/h', 's3://b/cap/aa/h');
    assert.equal(line, 'cp --metadata status=body /r/cap/aa/h s3://b/cap/aa/h');
  });

  it('quotes a content-type with spaces/semicolons', () => {
    const line = emitLine({ contentType: 'text/html; charset=utf-8', status: 'body' }, '/r/cap/aa/h', 's3://b/cap/aa/h');
    assert.equal(line, "cp --content-type 'text/html; charset=utf-8' --metadata status=body /r/cap/aa/h s3://b/cap/aa/h");
  });

  it('refuses a CR/LF content-type (the metadata guard, via assertMetadataSafe)', () => {
    assert.throws(() => emitLine({ contentType: 'text/html\r\nX-Evil: 1', status: 'body' }, '/s', 's3://b/k'), /CR\/LF/);
  });

  it('refuses a >1000-byte content-type', () => {
    const huge = `x/${'y'.repeat(1000)}`;
    assert.throws(() => emitLine({ contentType: huge, status: 'body' }, '/s', 's3://b/k'), /1000/);
  });

  it('refuses an unknown status', () => {
    assert.throws(() => emitLine({ contentType: '', status: 'weird' }, '/s', 's3://b/k'), /unknown sidecar status/);
  });
});

describe('emitBucketBatch', () => {
  it('emits deterministic, hash-sorted cp lines with native metadata', async () => {
    const root = await mkRoot();
    // Distinct hashes; commit in a NON-sorted order to prove the emitter sorts.
    await commitEntry(root, { key: '2/z', status: 'body', contentType: 'image/jpeg', body: new TextEncoder().encode('jpg') });
    await commitEntry(root, {
      key: '1/a',
      status: 'body',
      contentType: 'text/html; charset=utf-8',
      body: new TextEncoder().encode('<html>')
    });

    const { lines, summary } = await emitBucketBatch(root, { bucket: 'mybucket' });
    assert.deepEqual(summary, { total: 2, bodied: 2, bodiless: 0 });

    // Independently recompute the expected object keys + sorted order.
    const zKey = await capturePath('2/z');
    const aKey = await capturePath('1/a');
    const expected = [
      { key: zKey, line: `cp --content-type image/jpeg --metadata status=body ${path.join(root, zKey)} s3://mybucket/${zKey}` },
      {
        key: aKey,
        line: `cp --content-type 'text/html; charset=utf-8' --metadata status=body ${path.join(root, aKey)} s3://mybucket/${aKey}`
      }
    ].sort((x, y) => (x.key < y.key ? -1 : 1));
    assert.deepEqual(lines, expected.map(e => e.line));
  });

  it('omits --content-type for a bodied entry whose contentType is ""', async () => {
    const root = await mkRoot();
    await commitEntry(root, { key: '1/octet', status: 'body', contentType: '', body: new TextEncoder().encode('\x00\x01') });
    const { lines } = await emitBucketBatch(root, { bucket: 'b' });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /--content-type/);
    assert.match(lines[0], /^cp --metadata status=body /);
  });

  it('emits empty-file cp lines for bodiless entries (status/Content-Type still carried)', async () => {
    const root = await mkRoot();
    await commitEntry(root, { key: '1/gone', status: 'error', contentType: '' });
    await commitEntry(root, { key: '1/moved', status: 'redirect', contentType: 'text/html' });
    await commitEntry(root, { key: '1/blank', status: 'empty', contentType: 'text/plain' });

    const emptyFile = path.join(os.tmpdir(), 'zero-byte-scratch');
    const { lines, summary } = await emitBucketBatch(root, { bucket: 'b', emptyFile });
    assert.deepEqual(summary, { total: 3, bodied: 0, bodiless: 3 });

    // Every line uploads the SAME empty file to a cap/ object; no local cap/ file exists.
    for (const line of lines) assert.ok(line.includes(` ${emptyFile} s3://b/cap/`), line);
    const errKey = await capturePath('1/gone');
    assert.ok(lines.includes(`cp --metadata status=error ${emptyFile} s3://b/${errKey}`));
    const redirKey = await capturePath('1/moved');
    assert.ok(lines.includes(`cp --content-type text/html --metadata status=redirect ${emptyFile} s3://b/${redirKey}`));
  });

  it('refuses a bodiless entry when --empty-file is absent', async () => {
    const root = await mkRoot();
    await commitEntry(root, { key: '1/gone', status: 'error', contentType: '' });
    await assert.rejects(emitBucketBatch(root, { bucket: 'b' }), /needs --empty-file/);
  });

  it('refuses an unknown sidecar schema version (reusing readSidecar\'s guard)', async () => {
    const root = await mkRoot();
    await commitEntry(root, { key: '1/v2', status: 'body', contentType: 'text/html', body: new TextEncoder().encode('x') });
    const rel = await metaPath('1/v2');
    const bad = JSON.parse(await fsp.readFile(path.join(root, rel), 'utf8'));
    bad.v = 2;
    await fsp.writeFile(path.join(root, rel), JSON.stringify(bad));
    await assert.rejects(emitBucketBatch(root, { bucket: 'b' }), /unsupported sidecar version 2/);
  });

  it('refuses an oversized content-type sidecar (the metadata-size guard)', async () => {
    const root = await mkRoot();
    const key = '1/huge';
    const rel = await metaPath(key);
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    const sidecar = { contentType: `x/${'y'.repeat(1000)}`, fetchedAt: '2026-01-01T00:00:00Z', flag: null, key, requisites: [], status: 'body', v: 1 };
    await fsp.writeFile(path.join(root, rel), JSON.stringify(sidecar));
    // Also drop a body so status:body has a source (guard fires before it matters).
    const cap = await capturePath(key);
    await fsp.mkdir(path.dirname(path.join(root, cap)), { recursive: true });
    await fsp.writeFile(path.join(root, cap), 'x');
    await assert.rejects(emitBucketBatch(root, { bucket: 'b' }), /1000/);
  });

  it('emits nothing for an empty / never-populated root', async () => {
    const root = await mkRoot();
    const { lines, summary } = await emitBucketBatch(root, { bucket: 'b' });
    assert.deepEqual(lines, []);
    assert.deepEqual(summary, { total: 0, bodied: 0, bodiless: 0 });
  });
});

describe('emitBucketBatch over the committed fixture', () => {
  let lines;
  let summary;
  // The fixture carries bodiless sidecars (empty/redirect/error — added with the
  // store-conformance suite in #285), so the emitter needs a scratch empty file.
  const emptyFile = path.join(os.tmpdir(), 'bucket-batch-fixture-empty');
  before(async () => {
    ({ lines, summary } = await emitBucketBatch(FIXTURE_ROOT, { bucket: 'wayback', emptyFile }));
  });

  it('emits one cp line per real entry, hash-sorted (bodied from cap/, bodiless from the empty file)', async () => {
    // Every fixture entry (see the fixture README), sorted by cap object key: four
    // bodied (source = the local cap/ file) plus the three synthetic bodiless
    // entries (source = the shared empty file; '' content-type omits the flag).
    const cases = [
      { key: '19981202230410/http://www.google.com/alpha.jpg', status: 'body', ct: 'text/html' },
      { key: '19981202230410/http://www.google.com/google.jpg', status: 'body', ct: 'image/jpeg' },
      { key: '19981202230410/http://www.google.com/', status: 'body', ct: 'text/html' },
      { key: '20140403040000/http://example.com/empty', status: 'empty', ct: '' },
      { key: '20140403040000/http://example.com/', status: 'body', ct: 'text/html' },
      { key: '20140403040000/http://example.com/redirect', status: 'redirect', ct: 'text/html; charset=utf-8' },
      { key: '20140403040000/http://example.com/missing.gif', status: 'error', ct: '' }
    ];
    const expected = [];
    for (const c of cases) {
      const objectKey = await capturePath(c.key);
      const source = c.status === 'body' ? path.join(FIXTURE_ROOT, objectKey) : emptyFile;
      const ctFlag = c.ct === '' ? '' : `--content-type ${shellQuote(c.ct)} `;
      expected.push({ objectKey, line: `cp ${ctFlag}--metadata status=${c.status} ${source} s3://wayback/${objectKey}` });
    }
    expected.sort((a, b) => (a.objectKey < b.objectKey ? -1 : 1));
    assert.deepEqual(lines, expected.map(e => e.line));
    assert.deepEqual(summary, { total: 7, bodied: 4, bodiless: 3 });
  });

  it('pins the cross-package tripwire hash in the example.com line', () => {
    assert.ok(
      lines.some(l => l.includes('cap/77/77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac')),
      lines.join('\n')
    );
  });
});

describe('emit-bucket-batch bin', () => {
  it('writes lines to stdout by default and NOTHING to stdout under --dry-run', async () => {
    const root = await mkRoot();
    await commitEntry(root, { key: '1/a', status: 'body', contentType: 'text/html', body: new TextEncoder().encode('x') });

    const run = await execFileP(process.execPath, [BIN, '--root', root, '--bucket', 'b']);
    assert.match(run.stdout, /^cp --content-type text\/html --metadata status=body /);
    assert.match(run.stderr, /1 objects \(1 bodied, 0 bodiless\)/);

    const dry = await execFileP(process.execPath, [BIN, '--root', root, '--bucket', 'b', '--dry-run']);
    assert.equal(dry.stdout, '');
    assert.match(dry.stderr, /cp --content-type text\/html/);
    assert.match(dry.stderr, /dry-run, nothing written to stdout/);
  });

  it('exits non-zero when a required option is missing', async () => {
    await assert.rejects(execFileP(process.execPath, [BIN, '--bucket', 'b']), /is required/);
  });
});
