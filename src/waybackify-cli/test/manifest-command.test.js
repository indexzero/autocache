// `waybackify manifest` wiring tests — offline, library injected.
//
// The ENUMERATION (balanced-paren scanner, manifest schema, dedupe, order)
// is tested where it lives: spv/waybackify/test/manifest.test.js. This file
// pins the thin-wrapper contract only: argv payload →
// sourceRefs(file, { manifest }) per file, one JSONL row per ref on stdout
// in the PINNED v1 output vocabulary (`post` = the file path,
// source: inline|ledger — see the handler's vocabulary-shim note; #386
// replaces this surface), extra files (an xargs batch) processed in order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { manifestHandler } from '../src/commands/manifest.js';

const refOf = over => ({
  path: 'docs/a/index.md',
  source: 'inline',
  timestamp: '20140403040000',
  originalUrl: 'http://example.com/',
  waybackUrl: 'https://web.archive.org/web/20140403040000/http://example.com/',
  ...over
});

test('inline-only by default: passes manifest:false and prints one JSONL row per ref', async () => {
  const seen = [];
  const out = [];
  const handler = manifestHandler({
    sourceRefs: (file, options) => {
      seen.push({ file, options });
      return [refOf({}), refOf({ timestamp: '20150101000000' })];
    },
    log: line => out.push(line)
  });

  assert.equal(await run(['manifest', 'docs/a/index.md'], { handlers: { manifest: handler }, error: () => {} }), EXIT.OK);
  assert.deepEqual(seen, [{ file: 'docs/a/index.md', options: { manifest: false } }]);
  assert.equal(out.length, 2);
  // The pinned output shape: `post` carries the file path.
  assert.deepEqual(JSON.parse(out[0]), {
    post: 'docs/a/index.md',
    source: 'inline',
    timestamp: '20140403040000',
    originalUrl: 'http://example.com/',
    waybackUrl: 'https://web.archive.org/web/20140403040000/http://example.com/'
  });
  // Exactly the five contract fields, in order.
  assert.deepEqual(Object.keys(JSON.parse(out[0])), ['post', 'source', 'timestamp', 'originalUrl', 'waybackUrl']);
});

test('--ledger passes manifest:true through, and a manifest ref prints as source "ledger"', async () => {
  const seen = [];
  const out = [];
  const handler = manifestHandler({
    sourceRefs: (file, options) => {
      seen.push(options);
      return [refOf({ source: 'manifest' })];
    },
    log: line => out.push(line)
  });

  assert.equal(
    await run(['manifest', '--ledger', 'docs/a/index.md'], { handlers: { manifest: handler }, error: () => {} }),
    EXIT.OK
  );
  assert.deepEqual(seen, [{ manifest: true }]);
  // The pinned v1 vocabulary on the wire (the library says 'manifest').
  assert.equal(JSON.parse(out[0]).source, 'ledger');
});

test('an xargs batch: every file enumerated in argv order', async () => {
  const files = [];
  const out = [];
  const handler = manifestHandler({
    sourceRefs: file => {
      files.push(file);
      return [refOf({ path: file })];
    },
    log: line => out.push(line)
  });

  assert.equal(
    await run(['manifest', 'a/index.md', 'b/index.md', 'c/index.md'], { handlers: { manifest: handler }, error: () => {} }),
    EXIT.OK
  );
  assert.deepEqual(files, ['a/index.md', 'b/index.md', 'c/index.md']);
  assert.deepEqual(out.map(l => JSON.parse(l).post), ['a/index.md', 'b/index.md', 'c/index.md']);
});

test('a file with no refs emits nothing (exit 0)', async () => {
  const out = [];
  const handler = manifestHandler({ sourceRefs: () => [], log: line => out.push(line) });
  assert.equal(await run(['manifest', 'empty.md'], { handlers: { manifest: handler }, error: () => {} }), EXIT.OK);
  assert.equal(out.length, 0);
});
