// fsck tests — offline, tmpdir roots built through the REAL commit path so
// "clean" means "what cache.js actually writes verifies", then each defect is
// injected surgically (one category at a time) to pin isolation. Plus a pin
// over the committed corpus fixture. (The bin-level exit-code coverage now
// lives in the CLI's `cache verify` command tests — the library ships no bin.)
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyFile, commitEntry, entryPaths } from '../cache.js';
import { emptyTrash, fsck, totalFindings, unresolvedFindings, CATEGORIES, TRASH_DIR } from '../fsck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(HERE, 'fixtures/cache-root');
const WRAPPER = fs.readFileSync(path.join(HERE, 'fixtures/interstitial/wrapper-stub.html'), 'utf8');

const mkroot = () => fsp.mkdtemp(path.join(os.tmpdir(), 'waybackify-fsck-'));
const bytesOf = s => new TextEncoder().encode(s);

/** Commit a bodied entry and hand back its resolved paths (body by contentHash). */
async function commitBody(root, key, body = `body-for-${key}`) {
  const sidecar = await commitEntry(root, { key, status: 'body', contentType: 'text/html', body: bytesOf(body) });
  return { ...(await entryPaths(root, key)), body: bodyFile(root, sidecar.contentHash) };
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

  it('a body shared by two captures is one cap/ file, referenced, never an orphan', async () => {
    const root = await mkroot();
    const a = await commitBody(root, '20081013100657/http://github.com/s.css', 'body{}');
    const b = await commitBody(root, '20081024183240/http://github.com/s.css', 'body{}');
    assert.equal(a.body, b.body, 'one digest-named file');

    const report = await fsck(root);
    only(report);
    assert.equal(report.counts.sidecars, 2);
    assert.equal(report.counts.bodies, 2);
    assert.equal(report.counts.capFiles, 1);

    // Dropping one sidecar leaves the body referenced by the other.
    await fsp.unlink(a.meta);
    only(await fsck(root, { fix: true }));
    assert.ok(fs.existsSync(b.body), 'a body that a sidecar still names is never reaped');
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
    only(report, 'hashMismatch', 'sizeMismatch');
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

  it('--fix keeps the body when its contentHash rots to another valid SRI (evidence, not an orphan)', async () => {
    const { body, meta } = await commitBody(root, '2011/http://x.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    // Change one character inside the digest: the result is still a valid SRI.
    const rotted = `sha256-${sidecar.contentHash[7] === 'A' ? 'B' : 'A'}${sidecar.contentHash.slice(8)}`;
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, contentHash: rotted }));

    const report = await fsck(root, { fix: true });
    only(report, 'missingBody');
    assert.equal(report.findings.missingBody[0].contentHash, rotted, 'the rotted digest is reported');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
    assert.ok(fs.existsSync(body), 'the true body is kept for investigation');
  });

  it('--fix keeps the body when its contentHash rots to a value that is not an SRI', async () => {
    const { body, meta } = await commitBody(root, '2011/http://x.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, contentHash: 'sha256-unverified' }));

    const report = await fsck(root, { fix: true });
    only(report, 'missingBody');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
    assert.ok(fs.existsSync(body), 'the true body is kept for investigation');
  });

  it("detects status 'body' whose contentHash is not a sha256 SRI (the body cannot be located)", async () => {
    const { body, meta } = await commitBody(root, '2011/http://x.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, contentHash: 'sha256-unverified' }));
    await fsp.unlink(body);

    const report = await fsck(root);
    only(report, 'missingBody');
    assert.equal(report.findings.missingBody[0].contentHash, 'sha256-unverified');
  });

  it('flags a sidecar whose schema version is not the current version', async () => {
    const { meta } = await commitBody(root, '2011/http://x.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, v: 99 }));

    const report = await fsck(root);
    only(report, 'schemaVersion');
    assert.equal(report.findings.schemaVersion[0].v, 99);
  });

  it('flags a v1 or v2 sidecar: only the current version is supported (A6)', async () => {
    const { meta } = await commitBody(root, '2011/http://old.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    for (const v of [1, 2]) {
      await fsp.writeFile(meta, JSON.stringify({ ...sidecar, v }));
      const report = await fsck(root);
      only(report, 'schemaVersion');
      assert.equal(report.findings.schemaVersion[0].v, v);
    }
  });

  it('reports a sidecar that parses to a non-object (null, [], "x", 1) as malformed, without throwing, and --fix moves nothing', async () => {
    const { body, meta } = await commitBody(root, '2011/http://x.example/');
    for (const text of ['null', '[]', '"x"', '1']) {
      await fsp.writeFile(meta, text);
      const report = await fsck(root, { fix: true });
      only(report, 'malformed');
      assert.equal(report.findings.malformed[0].error, 'not a JSON object', text);
      assert.equal(report.reapSuspended, true);
      assert.ok(fs.existsSync(body), `the body survives a sidecar of ${text}`);
    }
  });

  it('reports an unparseable sidecar as malformed, without throwing', async () => {
    const { body, meta } = await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(meta, '{ this is not json');

    only(await fsck(root), 'malformed');
    // The unreadable sidecar can name any body, so --fix reaps no cap/ file.
    only(await fsck(root, { fix: true }), 'malformed');
    assert.ok(fs.existsSync(body), 'the body of an unreadable sidecar is evidence, never reaped');
  });

  it('a sidecar whose contentHash names ANOTHER live body: sizeMismatch, and --fix keeps the unnamed body', async () => {
    // Capture A's sidecar is rewritten to name capture B's body. The digest
    // check passes by construction (the digest IS the file name), so only the
    // size check can tell. A's own body is now unnamed and must survive.
    const a = await commitBody(root, '2014/http://x.example/a.css', 'body { color: red }');
    const b = await commitBody(root, '2016/http://x.example/b.css', 'x');
    const aSidecar = JSON.parse(await fsp.readFile(a.meta, 'utf8'));
    const bSidecar = JSON.parse(await fsp.readFile(b.meta, 'utf8'));
    await fsp.writeFile(a.meta, JSON.stringify({ ...aSidecar, contentHash: bSidecar.contentHash }));

    const report = await fsck(root, { fix: true });
    only(report, 'sizeMismatch');
    assert.deepEqual(report.findings.sizeMismatch[0], {
      hash: path.basename(a.meta, '.json'),
      aa: path.basename(path.dirname(a.meta)),
      key: '2014/http://x.example/a.css',
      expected: aSidecar.contentLength,
      actual: 1
    });
    assert.equal(report.reapSuspended, true);
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
    assert.ok(fs.existsSync(a.body), 'the body A meant to name is kept');
    assert.ok(fs.existsSync(b.body), 'B is untouched');
    assert.equal(unresolvedFindings(report), 1, 'the store stays dirty');
  });

  it('a sidecar whose status is corrupted is malformed, and --fix keeps its body', async () => {
    const { body, meta } = await commitBody(root, '2020/http://x.example/asset', 'irreplaceable captured bytes');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, status: 'b0dy' })); // one byte of metadata rot

    const report = await fsck(root, { fix: true });
    only(report, 'malformed');
    assert.match(report.findings.malformed[0].error, /status "b0dy" is not one of/);
    assert.equal(report.reapSuspended, true);
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
    assert.ok(fs.existsSync(body), 'the body of a sidecar with an unknown status is evidence, never reaped');
    assert.ok(fs.existsSync(meta), 'the sidecar is kept too');
    assert.equal(unresolvedFindings(report), 1, 'the store stays dirty');
  });

  it('a body sidecar whose status rots to a bodiless value but keeps contentHash is malformed, and --fix moves nothing', async () => {
    const { body, meta } = await commitBody(root, '2014/http://x.example/a.css', 'body { color: red }');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    for (const status of ['empty', 'redirect', 'error', 'interstitial']) {
      await fsp.writeFile(meta, JSON.stringify({ ...sidecar, status })); // contentHash + contentLength stay

      const report = await fsck(root, { fix: true });
      only(report, 'malformed');
      assert.match(report.findings.malformed[0].error, new RegExp(`status "${status}" carries contentHash or contentLength`));
      assert.equal(report.reapSuspended, true);
      assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
      assert.ok(fs.existsSync(body), `the body stays in cap/ under status ${status}`);
      assert.equal(unresolvedFindings(report), 1);
    }
    // Either field alone is enough.
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, status: 'empty', contentHash: undefined }));
    only(await fsck(root), 'malformed');
    // A genuine bodiless sidecar (neither field) is clean.
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, status: 'empty', contentHash: undefined, contentLength: undefined }));
    await fsp.unlink(body);
    assert.equal(totalFindings(await fsck(root)), 0);
  });

  it('detects a contentLength that disagrees with the stored body size', async () => {
    const { meta } = await commitBody(root, '2011/http://x.example/');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    await fsp.writeFile(meta, JSON.stringify({ ...sidecar, contentLength: sidecar.contentLength + 1 }));

    const report = await fsck(root);
    only(report, 'sizeMismatch');
    assert.equal(report.findings.sizeMismatch[0].expected, sidecar.contentLength + 1);
    assert.equal(report.findings.sizeMismatch[0].actual, sidecar.contentLength);
  });

  it('a true orphan waits while any sidecar fails a check, and is reaped once the proof holds', async () => {
    const { body } = await commitBody(root, '2011/http://x.example/');
    const good = await fsp.readFile(body);
    await fsp.writeFile(body, 'TAMPERED'); // hashMismatch + sizeMismatch on the valid neighbour
    const hash = crypto.createHash('sha256').update('orphan-key').digest('hex');
    const orphan = path.join(root, 'cap', hash.slice(0, 2), hash);
    await fsp.mkdir(path.dirname(orphan), { recursive: true });
    await fsp.writeFile(orphan, 'garbage');

    const suspended = await fsck(root, { fix: true });
    only(suspended, 'hashMismatch', 'sizeMismatch');
    assert.equal(suspended.reapSuspended, true);
    assert.deepEqual(suspended.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
    assert.ok(fs.existsSync(orphan), 'nothing is reaped while the proof is broken');

    await fsp.writeFile(body, good); // the operator restores the bytes
    const clean = await fsck(root, { fix: true });
    only(clean, 'orphanCap');
    assert.equal(clean.reapSuspended, false);
    assert.deepEqual(clean.reaped.orphanCap, [orphan]);
    assert.ok(!fs.existsSync(orphan), 'the orphan is quarantined once every sidecar proves ownership');
    assert.ok(fs.existsSync(clean.reaped.moves[0].to), 'and it is in trash/, not deleted');
    assert.equal(unresolvedFindings(clean), 0);
  });

  it('--fix REFUSES to touch corruption (leaves the cap file and finding intact)', async () => {
    const { body } = await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(body, 'TAMPERED');

    const report = await fsck(root, { fix: true });
    only(report, 'hashMismatch', 'sizeMismatch');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] });
    assert.ok(fs.existsSync(body), 'corrupt body is preserved for investigation');
    assert.equal(unresolvedFindings(report), 2);
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
    assert.ok(!fs.existsSync(orphan), 'orphan gone from cap/');
    assert.ok(!fs.existsSync(tmp), 'stale tmp deleted');
    assert.ok(fs.existsSync(goodBody) && fs.existsSync(goodMeta), 'valid entry untouched');
    assert.equal(unresolvedFindings(report), 0, 'a fixed store is clean');

    // The orphan was MOVED, not deleted: it sits in this run's quarantine
    // under its own relative path, byte-identical.
    assert.ok(report.reaped.trash.startsWith(path.join(root, TRASH_DIR, '')), 'the quarantine is inside the root');
    const moved = path.join(report.reaped.trash, 'cap', hash.slice(0, 2), hash);
    assert.deepEqual(report.reaped.moves, [{ from: orphan, to: moved }]);
    assert.equal(fs.readFileSync(moved, 'utf8'), 'garbage', 'the bytes survive in quarantine');

    // idempotent: a second pass finds nothing, and never scans trash/ as live content
    const again = await fsck(root);
    assert.equal(totalFindings(again), 0);
    assert.equal(again.counts.capFiles, 1, 'the quarantined body is not a cap/ file');
    assert.equal(again.counts.trashFiles, 1, 'but it is inventoried');
  });

  it('--fix never deletes a body: an operator restores a quarantined body by moving it back, and emptyTrash is the only deletion', async () => {
    const hash = crypto.createHash('sha256').update('orphan-key').digest('hex');
    const orphan = path.join(root, 'cap', hash.slice(0, 2), hash);
    await fsp.mkdir(path.dirname(orphan), { recursive: true });
    await fsp.writeFile(orphan, 'not garbage after all');

    const first = await fsck(root, { fix: true });
    const [{ to }] = first.reaped.moves;
    assert.ok(fs.existsSync(to));

    // Restore: move it back under cap/ (the documented operator step). It is
    // an orphan again, and --fix quarantines it again under a new run dir.
    await fsp.rename(to, orphan);
    const second = await fsck(root, { fix: true });
    assert.equal(second.reaped.moves.length, 1);
    assert.notEqual(second.reaped.trash, first.reaped.trash, 'each run gets its own quarantine directory');
    assert.equal(fs.readFileSync(second.reaped.moves[0].to, 'utf8'), 'not garbage after all');

    // The explicit, separate action empties the quarantine.
    const emptied = await emptyTrash(root);
    assert.equal(emptied.path, path.join(root, TRASH_DIR));
    assert.equal(emptied.files, 1);
    assert.equal(emptied.bytes, 'not garbage after all'.length);
    assert.ok(!fs.existsSync(path.join(root, TRASH_DIR)));
    assert.equal((await fsck(root)).counts.trashFiles, 0);
    assert.deepEqual(await emptyTrash(root), { path: path.join(root, TRASH_DIR), files: 0, bytes: 0 }, 'emptying an empty quarantine is a no-op');
  });

  it('trash/ is part of the root contract: never a foreignRoot finding', async () => {
    await fsp.mkdir(path.join(root, TRASH_DIR, 'old-run', 'cap', 'ab'), { recursive: true });
    await fsp.writeFile(path.join(root, TRASH_DIR, 'old-run', 'cap', 'ab', 'abcd'), 'quarantined');
    const report = await fsck(root);
    assert.equal(totalFindings(report), 0);
    assert.equal(report.counts.trashFiles, 1);
  });
});

describe('fsck — interstitial-as-body (#363, report-only)', () => {
  // A PRE-SCHEMA entry: written before cache-time refusal existed, so a wayback
  // interstitial sits on disk as `status:body`. Build it by committing a benign
  // body (commitEntry would refuse the interstitial today), then swapping the
  // cap/ bytes in and re-pinning contentHash so the ONLY finding is the new
  // category — never a hashMismatch.
  async function plantInterstitial(root, key, body) {
    const { body: benign, meta } = await commitBody(root, key, '<html><body>benign at commit time</body></html>');
    const sidecar = JSON.parse(await fsp.readFile(meta, 'utf8'));
    sidecar.contentHash = `sha256-${crypto.createHash('sha256').update(body).digest('base64')}`;
    sidecar.contentLength = Buffer.byteLength(body);
    // Bodies are content-addressed: the swapped bytes live at their own digest.
    const capPath = bodyFile(root, sidecar.contentHash);
    await fsp.mkdir(path.dirname(capPath), { recursive: true });
    await fsp.writeFile(capPath, body);
    await fsp.unlink(benign);
    await fsp.writeFile(meta, JSON.stringify(sidecar));
    return { capPath, meta };
  }

  it('reports a status:body wrapper stub, with its signature, and never reaps it', async () => {
    const root = await mkroot();
    const { capPath } = await plantInterstitial(root, '2011/http://x.example/', WRAPPER);

    const report = await fsck(root, { fix: true });
    only(report, 'interstitialAsBody');
    assert.equal(report.findings.interstitialAsBody[0].signature, 'wrapper-stub');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] }, 'remediation is #364, not fsck');
    assert.equal(unresolvedFindings(report), 1);
    assert.ok(fs.existsSync(capPath), 'the body is left in place');
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

  it('does NOT flag .refetch/ — it is `cache fill`\'s sanctioned durable state', async () => {
    // Regression: `cache fill` writes <root>/.refetch/{worklist,gone}.jsonl, and
    // `cache verify` (fsck) must treat it as a sibling, not a foreign intrusion —
    // else fill→verify on one root would report unclean (exit 1) forever.
    const root = await mkroot();
    await commitBody(root, '2011/http://x.example/');
    await fsp.mkdir(path.join(root, '.refetch'), { recursive: true });
    await fsp.writeFile(path.join(root, '.refetch', 'worklist.jsonl'), '{"waybackUrl":"https://web.archive.org/web/2011/http://x.example/"}\n');
    await fsp.writeFile(path.join(root, '.refetch', 'gone.jsonl'), '');

    const report = await fsck(root);
    assert.equal(report.findings.foreignRoot.length, 0, '.refetch/ is not foreign');
    assert.equal(unresolvedFindings(report), 0, 'a fill-populated root verifies clean');
  });

  it('does NOT flag .crawl/ — it is `cache crawl`\'s sanctioned durable state', async () => {
    // Regression: `cache crawl` writes <root>/.crawl/{verified,flaky}.jsonl (and
    // an optional --har/ dir); `cache verify` (fsck) must treat it as a sibling,
    // not a foreign intrusion — else crawl→verify on one root would report
    // unclean (exit 1) forever, exactly the .refetch/ case above.
    const root = await mkroot();
    await commitBody(root, '2011/http://x.example/');
    await fsp.mkdir(path.join(root, '.crawl'), { recursive: true });
    await fsp.writeFile(path.join(root, '.crawl', 'verified.jsonl'), '');
    await fsp.writeFile(path.join(root, '.crawl', 'flaky.jsonl'), '');

    const report = await fsck(root);
    assert.equal(report.findings.foreignRoot.length, 0, '.crawl/ is not foreign');
    assert.equal(unresolvedFindings(report), 0, 'a crawl-populated root verifies clean');
  });

  it('does NOT flag remaster.build.json — it is `remaster build`\'s sanctioned build record', async () => {
    // Regression: `remaster build` writes remaster.build.json at the remastered
    // root; `remaster verify` on that root must not report it foreign (exit 1).
    const root = await mkroot();
    await commitBody(root, '2011/http://x.example/');
    await fsp.writeFile(path.join(root, 'remaster.build.json'), '{"schema":1}');

    const report = await fsck(root);
    assert.equal(report.findings.foreignRoot.length, 0, 'remaster.build.json is not foreign');
    assert.equal(unresolvedFindings(report), 0, 'a remastered root verifies clean');
  });
});

describe('fsck — incomplete requisite closure (store-relative, report-only)', () => {
  let root;
  beforeEach(async () => {
    root = await mkroot();
  });

  /** Commit a body doc that names `children` as its page requisites. */
  async function commitDocWithRequisites(key, children) {
    const sidecar = await commitEntry(root, {
      key,
      status: 'body',
      contentType: 'text/html',
      requisites: children,
      body: new TextEncoder().encode(`doc-for-${key}`)
    });
    return { ...(await entryPaths(root, key)), body: bodyFile(root, sidecar.contentHash) };
  }

  it('flags a body doc whose requisite child sidecar is absent from the store', async () => {
    // The doc names two requisites; neither is committed → closure is short.
    await commitDocWithRequisites('2011/http://x.example/', [
      '2011/http://x.example/im_/logo.png',
      '2011/http://x.example/cs_/screen.css'
    ]);

    const report = await fsck(root);
    only(report, 'incompleteClosure');
    assert.equal(report.findings.incompleteClosure.length, 2, 'one finding per missing requisite');
    const children = report.findings.incompleteClosure.map(f => f.child).sort();
    assert.deepEqual(children, ['2011/http://x.example/cs_/screen.css', '2011/http://x.example/im_/logo.png']);
    // The category severity is 'incomplete' and it keeps the store dirty.
    assert.equal(CATEGORIES.find(c => c.key === 'incompleteClosure').severity, 'incomplete');
    assert.equal(unresolvedFindings(report), 2);
  });

  it('does NOT flag a doc whose requisites are all present in the store', async () => {
    // Commit the two children first, then the doc that references them.
    await commitBody(root, '2011/http://x.example/im_/logo.png');
    await commitBody(root, '2011/http://x.example/cs_/screen.css');
    await commitDocWithRequisites('2011/http://x.example/', [
      '2011/http://x.example/im_/logo.png',
      '2011/http://x.example/cs_/screen.css'
    ]);

    only(await fsck(root)); // clean: the closure is satisfied
  });

  it('closure is order-independent — a requisite filed under any shard counts', async () => {
    // Commit the doc BEFORE its child; the walk order must not matter.
    await commitDocWithRequisites('2011/http://doc.example/', ['2011/http://doc.example/asset.js']);
    only(await fsck(root), 'incompleteClosure');
    await commitBody(root, '2011/http://doc.example/asset.js');
    only(await fsck(root)); // now satisfied regardless of shard placement
  });

  it('--fix NEVER touches a short closure (report-only; nothing reaped)', async () => {
    const { body, meta } = await commitDocWithRequisites('2011/http://x.example/', ['2011/http://x.example/im_/gone.png']);

    const report = await fsck(root, { fix: true });
    only(report, 'incompleteClosure');
    assert.deepEqual(report.reaped, { orphanCap: [], staleTmp: [], trash: null, moves: [] }, 'a short closure is filled by fetching, never by reaping');
    assert.ok(fs.existsSync(body) && fs.existsSync(meta), 'the doc is left in place');
    assert.equal(unresolvedFindings(report), 1, 'closure gap keeps the store dirty through --fix');
  });

  it('does NOT flag an absent tracking-beacon child (un-mirrorable, so never a closure gap)', async () => {
    // A body doc whose dynamic[] carries an un-mirrorable tracking beacon (per-
    // render-random query strings → an unconvergeable key) ALONGSIDE a genuine
    // absent asset. The crawl (mapkeys) already refuses to chase the beacon, so
    // the gate must agree — else the beacon holds the store dirty forever.
    const beacon = '20180101000000/https://csi.gstatic.com/csi?v=3'; // Google CSI timing pixel
    const beaconTwo = '20150311160456/http://ib.adnxs.com/seg?t=2&add=752311'; // AppNexus ad beacon
    const real = '20110101000000/https://example.com/real.css'; // the control: a genuine missing asset
    await commitEntry(root, {
      key: '2011/http://x.example/',
      status: 'body',
      contentType: 'text/html',
      dynamic: [
        { key: beacon, flag: 'oe_', via: 'remaster-verify', firstSeen: '2026-07-29T00:00:00.000Z' },
        { key: beaconTwo, flag: 'im_', via: 'remaster-verify', firstSeen: '2026-07-29T00:00:00.000Z' },
        { key: real, flag: 'cs_', via: 'remaster-verify', firstSeen: '2026-07-29T00:00:00.000Z' }
      ],
      body: new TextEncoder().encode('doc-with-beacon-child')
    });

    const report = await fsck(root);
    only(report, 'incompleteClosure');
    const children = report.findings.incompleteClosure.map(f => f.child);
    assert.deepEqual(children, [real], 'only the real absent asset is a gap; the beacons are exempt');
    assert.equal(unresolvedFindings(report), 1);
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
      ['1258fb5b5b6c0365c1ddf64a4937bed1e4500efbb7fbc83e5bc7abc73e2d2653'],
      'the synthetic /orphan cap/ file is named by no sidecar contentHash (README-documented)'
    );
  });
});
