// fsck tests — offline, tmpdir roots built through the REAL commit path so
// "clean" means "what cache.js actually writes verifies", then each defect is
// injected surgically (one category at a time) to pin isolation. Plus a bin
// smoke test for exit codes and a pin over the committed corpus fixture.
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitEntry, entryPaths } from '../cache.js';
import { fsck, totalFindings, unresolvedFindings, CATEGORIES } from '../fsck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'fsck.js');
const FIXTURE_ROOT = path.resolve(HERE, '../../../render/wayback/test/fixtures/cache-root');
const WRAPPER = fs.readFileSync(path.join(HERE, 'fixtures/interstitial/wrapper-stub.html'), 'utf8');

const mkroot = () => fsp.mkdtemp(path.join(os.tmpdir(), 'waybackify-fsck-'));
const bytesOf = s => new TextEncoder().encode(s);

/** Commit a bodied entry and hand back its resolved paths. */
async function commitBody(root, key, body = `body-for-${key}`) {
  await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytesOf(body) });
  return entryPaths(root, key);
}

/** Every finding category empty except the named ones. */
function only(report, ...keys) {
  const want = new Set(keys);
  for (const { key } of CATEGORIES) {
    const n = report.findings[key].length;
    if (want.has(key)) assert.ok(n > 0, `expected finding: ${key}`);
    else assert.equal(n, 0, `unexpected finding ${key}: ${JSON.stringify(report.findings[key])}`);
  }
}

describe('fsck — clean root', () => {
  it('a store written entirely through commitEntry verifies with zero findings', async () => {
    const root = await mkroot();
    await commitBody(root, '2011/http://a.example/');
    await commitBody(root, '2012/http://b.example/');
    // a legitimately bodiless entry owns no cap/ file and must NOT read as missingBody
    await commitEntry(root, { key: '2013/http://c.example/gone', status: 'error', contentType: 'text/html' });

    const report = await fsck(root);
    only(report);
    assert.equal(totalFindings(report), 0);
    assert.equal(unresolvedFindings(report), 0);
    assert.equal(report.counts.sidecars, 3);
    assert.equal(report.counts.bodies, 2);
    assert.equal(report.counts.capFiles, 2);
  });

  it('an empty / never-populated root is clean, not an error', async () => {
    const root = await mkroot();
    const report = await fsck(root);
    only(report);
    assert.equal(report.counts.sidecars, 0);
  });
});

describe('fsck — corruption (report-only, never auto-fixed)', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
  });

  it('detects a body whose bytes no longer match contentHash', async () => {
    const { body } = await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(body, 'TAMPERED bytes'); // flip the stored body

    const report = await fsck(root);
    only(report, 'hashMismatch');
    const f = report.findings.hashMismatch[0];
    assert.match(f.expected, /^sha256-/);
    assert.match(f.actual, /^sha256-/);
    assert.notEqual(f.expected, f.actual);
  });

  it('detects a sidecar filed under the wrong hash (misfiled / tampered)', async () => {
    // A real bodiless sidecar moved under a bogus filename: sidecar.key still
    // hashes to its true hash, which no longer matches the on-disk name.
    await commitEntry(root, { key: '2011/http://x.example/', status: 'redirect', contentType: 'text/html' });
    const { meta } = await entryPaths(root, '2011/http://x.example/');
    const bogus = crypto.createHash('sha256').update('not-the-key').digest('hex');
    const bogusMeta = path.join(root, 'meta', bogus.slice(0, 2), `${bogus}.json`);
    await fsp.mkdir(path.dirname(bogusMeta), { recursive: true });
    await fsp.rename(meta, bogusMeta);

    only(await fsck(root), 'keyMismatch');
  });

  it("detects status 'body' with a missing cap/ file (incomplete entry)", async () => {
    const { body } = await commitBody(root, '2011/http://x.example/');
    await fsp.unlink(body); // body lost out from under a complete sidecar

    only(await fsck(root), 'missingBody');
  });

  it('flags a sidecar whose schema version is outside the supported set', async () => {
    const { meta } = await commitBody(root, '2011/http://x.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, v: 99 }));

    const report = await fsck(root);
    only(report, 'schemaVersion');
    assert.equal(report.findings.schemaVersion[0].v, 99);
  });

  it('a legacy v1 sidecar is SUPPORTED — no schemaVersion finding', async () => {
    const { meta } = await commitBody(root, '2011/http://legacy.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, v: 1 })); // as the v1 writer left it
    only(await fsck(root)); // clean: v1 is still readable, not a migration flag
  });

  it('reports an unparseable sidecar as malformed, without throwing', async () => {
    const { meta } = await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(meta, '{ this is not json');

    only(await fsck(root), 'malformed');
  });

  it('--fix REFUSES to touch corruption (leaves the cap file and finding intact)', async () => {
    const { body } = await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(body, 'TAMPERED');

    const report = await fsck(root, { fix: true });
    only(report, 'hashMismatch');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [] });
    assert.ok(fs.existsSync(body), 'corrupt body is preserved for investigation');
    assert.equal(unresolvedFindings(report), 1);
  });
});

describe('fsck — reapable classes (orphan cap/ + stale tmp/)', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
  });

  it('detects an orphan cap/ file (body present, no sidecar)', async () => {
    const hash = crypto.createHash('sha256').update('orphan-key').digest('hex');
    const orphan = path.join(root, 'cap', hash.slice(0, 2), hash);
    await fsp.mkdir(path.dirname(orphan), { recursive: true });
    await fsp.writeFile(orphan, 'ingest garbage');

    only(await fsck(root), 'orphanCap');
  });

  it('detects stale tmp/ scratch', async () => {
    await fsp.mkdir(path.join(root, 'tmp'), { recursive: true });
    await fsp.writeFile(path.join(root, 'tmp', 'abc.1234-deadbeef.part'), 'half a write');

    only(await fsck(root), 'staleTmp');
  });

  it('--fix reaps orphans + stale tmp and NOTHING else; a valid neighbour survives', async () => {
    const { body: goodBody, meta: goodMeta } = await commitBody(root, '2011/http://keep.example/');
    const hash = crypto.createHash('sha256').update('orphan-key').digest('hex');
    const orphan = path.join(root, 'cap', hash.slice(0, 2), hash);
    await fsp.mkdir(path.dirname(orphan), { recursive: true });
    await fsp.writeFile(orphan, 'garbage');
    const tmp = path.join(root, 'tmp', 'x.1-a.part');
    await fsp.writeFile(tmp, 'scratch');

    // report-only first: both flagged, nothing removed
    const before = await fsck(root);
    only(before, 'orphanCap', 'staleTmp');
    assert.equal(before.reaped, null);
    assert.ok(fs.existsSync(orphan) && fs.existsSync(tmp));

    const report = await fsck(root, { fix: true });
    assert.deepEqual(report.reaped.orphanCap, [orphan]);
    assert.deepEqual(report.reaped.staleTmp, [tmp]);
    assert.ok(!fs.existsSync(orphan), 'orphan reaped');
    assert.ok(!fs.existsSync(tmp), 'stale tmp reaped');
    assert.ok(fs.existsSync(goodBody) && fs.existsSync(goodMeta), 'valid entry untouched');
    assert.equal(unresolvedFindings(report), 0, 'a fixed store is clean');

    // idempotent: a second pass finds nothing
    assert.equal(totalFindings(await fsck(root)), 0);
  });
});

describe('fsck — interstitial-as-body (#363, report-only)', () => {
  // A PRE-SCHEMA entry: written before cache-time refusal existed, so a wayback
  // interstitial sits on disk as `status:body`. Build it by committing a benign
  // body (commitEntry would refuse the interstitial today), then swapping the
  // cap/ bytes in and re-pinning contentHash so the ONLY finding is the new
  // category — never a hashMismatch.
  async function plantInterstitial(root, key, body) {
    const { body: capPath, meta } = await commitBody(root, key, '<html><body>benign at commit time</body></html>');
    await fsp.writeFile(capPath, body);
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    sidecar.contentHash = `sha256-${crypto.createHash('sha256').update(body).digest('base64')}`;
    sidecar.contentLength = Buffer.byteLength(body);
    await fsp.writeFile(meta, JSON.stringify(sidecar));
    return { capPath, meta };
  }

  it('reports a status:body wrapper stub, with its signature, and never reaps it', async () => {
    const root = await mkroot();
    await plantInterstitial(root, '2011/http://x.example/', WRAPPER);

    const report = await fsck(root, { fix: true });
    only(report, 'interstitialAsBody');
    assert.equal(report.findings.interstitialAsBody[0].signature, 'wrapper-stub');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [] }, 'remediation is #364, not fsck');
    assert.equal(unresolvedFindings(report), 1);
    assert.ok(fs.existsSync((await entryPaths(root, '2011/http://x.example/')).body), 'the body is left in place');
  });

  it('a clean corpus of real bodies stays clean (no false interstitial findings)', async () => {
    const root = await mkroot();
    await commitBody(root, '2011/http://a.example/', '<html><head><title>Real</title></head><body>content</body></html>');
    await commitBody(root, '2012/http://b.example/', 'plain body, not html at all');
    only(await fsck(root));
  });
});

describe('fsck — root contract (foreign entries)', () => {
  it('flags a root entry outside cap/ meta/ tmp/ (the .runs/ shape) and --fix never reaps it', async () => {
    const root = await mkroot();
    await commitBody(root, '2011/http://x.example/');
    await fsp.mkdir(path.join(root, '.runs'), { recursive: true });
    await fsp.writeFile(path.join(root, '.runs', 'report.json'), '{}');

    const report = await fsck(root, { fix: true });
    only(report, 'foreignRoot');
    assert.equal(report.findings.foreignRoot[0].name, '.runs');
    assert.ok(fs.existsSync(path.join(root, '.runs')), 'operational data is never swept by fsck');
    assert.equal(unresolvedFindings(report), 1, 'foreign entry keeps the store dirty');
  });
});

describe('fsck bin — exit codes + summary', () => {
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

  it('exits 0 and prints "clean" on a clean root', async () => {
    const root = await mkroot();
    await commitBody(root, '2011/http://a.example/');
    const r = run('--root', root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /clean/);
  });

  it('exits 1 with findings on a dirty root; --json is machine-readable', async () => {
    const root = await mkroot();
    const { body } = await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(body, 'TAMPERED');

    const human = run('--root', root);
    assert.equal(human.status, 1);
    assert.match(human.stdout, /FAIL/);

    const json = run('--root', root, '--json');
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout);
    assert.equal(report.findings.hashMismatch.length, 1);
  });

  it('exits 2 on a usage error (no --root)', () => {
    const r = run();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--root/);
  });
});

describe('fsck — committed corpus fixture', () => {
  it('every sidecar verifies; the only findings are the README + the synthetic orphan cap/', async () => {
    const report = await fsck(FIXTURE_ROOT);
    // The fixture ships 4 real `body` entries (bodies hash-verify) + 3
    // SYNTHETIC bodiless sidecars (empty/redirect/error — no cap/ file, so
    // NOT missingBody) + one SYNTHETIC orphan cap/ file (no sidecar). fsck
    // reads all seven sidecars clean; the only findings are the two
    // documented, explainable non-store shapes.
    only(report, 'foreignRoot', 'orphanCap');
    assert.equal(report.counts.sidecars, 7, '4 real body + 3 synthetic bodiless');
    assert.equal(report.counts.bodies, 4, "only the real entries are status 'body'");
    assert.equal(report.counts.capFiles, 5, '4 real bodies + 1 orphan cap/ file');
    assert.deepEqual(
      report.findings.foreignRoot.map(f => f.name),
      ['README.md'],
      'the fixture ships a README documenting itself — the one non-store entry'
    );
    assert.deepEqual(
      report.findings.orphanCap.map(f => f.hash),
      ['d325db355e2cab506a0005ff77da83a07099ceaa5521e96985c67a726db70032'],
      'the synthetic /orphan cap/ file carries no sidecar (README-documented)'
    );
  });
});
