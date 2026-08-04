// `waybackify ledger` (surface v2: the COLLECTION) — offline, real library.
//
// Discovery/union/join semantics are tested where they live:
// spv/waybackify/test/ledger.test.js. This file pins the CLI contract over
// the committed fixture tree (one v2 manifest, one v1 with a null entry):
// JSONL survey rows by default, ONE canonical union manifest under
// --flatten, key-sorted worklist rows under --against, and a loud domain
// failure for a typo'd <dir>.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, run } from '../src/cli.js';
import { ledgerHandler } from '../src/commands/ledger.js';

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tree');

async function ledger(argv) {
  const stdout = [];
  const stderr = [];
  const handler = ledgerHandler({});
  const code = await run(['ledger', ...argv], { handlers: { ledger: handler }, out: line => stdout.push(line), error: line => stderr.push(line) });
  return { code, stdout, stderr };
}

test('discovery: one JSONL survey row per manifest, path-sorted, file paths as identity', async () => {
  const { code, stdout } = await ledger([TREE]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(stdout.map(l => JSON.parse(l)), [
    // v2 manifest: sections counted as written.
    { file: 'a/wayback.json', entries: 1, rewrites: 1, exclude: 1 },
    // v1 manifest: the null entry reads as exclude (2 entries + 1 exclude).
    { file: 'b/nested/wayback.json', entries: 2, rewrites: 0, exclude: 1 }
  ]);
});

test('--flatten: ONE canonical union manifest on stdout; first verdict per url wins', async () => {
  const { code, stdout } = await ledger([TREE, '--flatten']);
  assert.equal(code, EXIT.OK);
  const union = JSON.parse(stdout.join('\n'));
  assert.equal(union.version, 2);
  assert.deepEqual(union.rewrites, { 'http://feeds.example.com/blog': 'https://blog.example.net/feed' });
  // a/ merges before b/nested (sorted paths), so a/'s capture of the shared
  // url wins the union.
  assert.equal(
    union.entries['http://sudomakethought.com/post/123'].timestamp,
    '20140403040000'
  );
  assert.ok(union.entries['http://registry.nodejitsu.com/']);
  // Set-union exclude, sorted: a/'s policy prefix + b/'s migrated null.
  assert.deepEqual(union.exclude, ['http://never-captured.example.com/', 'https://tracker.example.com/']);
});

test('--flatten output is the seen-file bootstrap: byte-compatible with writeManifest', async () => {
  const { stdout } = await ledger([TREE, '--flatten']);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-ledger-')), 'seen.json');
  const { readManifest, writeManifest } = await import('@charlie.dev/waybackify/manifest.js');
  fs.writeFileSync(file, `${stdout.join('\n')}\n`);
  const bytes = fs.readFileSync(file);
  writeManifest(file, readManifest(file)); // read + canonical rewrite
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('--against an empty cache root: every referenced capture is an unfetched worklist row, key-sorted', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-ledger-root-'));
  const { code, stdout } = await ledger([TREE, '--against', cacheRoot]);
  assert.equal(code, EXIT.OK);
  const rows = stdout.map(l => JSON.parse(l));
  // Three distinct captures (the shared url appears at TWO timestamps — a
  // capture, not a url, is the join identity), all unfetched, none with a
  // sidecar status.
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.state === 'unfetched' && r.status === null));
  assert.deepEqual([...rows.map(r => r.key)].sort(), rows.map(r => r.key), 'rows are key-sorted');
  const byOriginal = Object.fromEntries(rows.map(r => [`${r.timestamp} ${r.originalUrl}`, r.files]));
  assert.deepEqual(byOriginal['20140403040000 http://sudomakethought.com/post/123'], ['a/wayback.json']);
  assert.deepEqual(byOriginal['20200101000000 http://sudomakethought.com/post/123'], ['b/nested/wayback.json']);
});

test('a missing <dir> is a loud domain failure (exit 1), not an empty ledger', async () => {
  const { code, stdout, stderr } = await ledger([path.join(TREE, 'no-such-subtree')]);
  assert.equal(code, EXIT.DOMAIN);
  assert.deepEqual(stdout, []);
  assert.ok(stderr.some(l => /no such directory:/.test(l)));
});
