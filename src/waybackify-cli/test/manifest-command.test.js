// `waybackify manifest` wiring tests — offline, library injected.
//
// The ENUMERATION (balanced-paren scanner, ledger schema, dedupe, order,
// post-id derivation) is tested where it lives: spv/waybackify/test/
// enumerate.test.js. This file pins the thin-wrapper contract only: argv
// payload → enumerateFile(file, { ledger }) per file, one JSONL row per ref
// on stdout, extra files (an xargs batch) processed in order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { manifestHandler } from '../src/commands/manifest.js';

const refOf = over => ({
  post: '1/043',
  source: 'inline',
  timestamp: '20140403040000',
  originalUrl: 'http://example.com/',
  waybackUrl: 'https://web.archive.org/web/20140403040000/http://example.com/',
  ...over
});

test('inline-only by default: passes ledger:false and prints one JSONL row per ref', async () => {
  const seen = [];
  const out = [];
  const handler = manifestHandler({
    enumerateFile: (file, options) => {
      seen.push({ file, options });
      return [refOf({}), refOf({ source: 'inline', timestamp: '20150101000000' })];
    },
    log: line => out.push(line)
  });

  assert.equal(await run(['manifest', 'words/1/043/index.md'], { handlers: { manifest: handler }, error: () => {} }), EXIT.OK);
  assert.deepEqual(seen, [{ file: 'words/1/043/index.md', options: { ledger: false } }]);
  assert.equal(out.length, 2);
  assert.deepEqual(JSON.parse(out[0]), refOf({}));
  // Exactly the five contract fields, in order.
  assert.deepEqual(Object.keys(JSON.parse(out[0])), ['post', 'source', 'timestamp', 'originalUrl', 'waybackUrl']);
});

test('--ledger passes ledger:true through to the library', async () => {
  const seen = [];
  const handler = manifestHandler({
    enumerateFile: (file, options) => {
      seen.push(options);
      return [];
    },
    log: () => {}
  });

  assert.equal(
    await run(['manifest', '--ledger', 'words/1/043/index.md'], { handlers: { manifest: handler }, error: () => {} }),
    EXIT.OK
  );
  assert.deepEqual(seen, [{ ledger: true }]);
});

test('an xargs batch: every file enumerated in argv order', async () => {
  const files = [];
  const out = [];
  const handler = manifestHandler({
    enumerateFile: file => {
      files.push(file);
      return [refOf({ post: file })];
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
  const handler = manifestHandler({ enumerateFile: () => [], log: line => out.push(line) });
  assert.equal(await run(['manifest', 'empty.md'], { handlers: { manifest: handler }, error: () => {} }), EXIT.OK);
  assert.equal(out.length, 0);
});
