// `waybackify rewrite` (surface v2: APPLICATION) — offline, real library.
//
// The rewrite semantics (precedence, fence/link-text guards, match key) are
// tested where they live: spv/waybackify/test/manifest.test.js (apply). This
// file pins the CLI contract: argv → source + manifest read, apply()'s output
// at -o, nothing on stdout, and the conservative no-verdict path (warn on
// stderr, exit 1, output still written with the url untouched).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, run } from '../src/cli.js';
import { rewriteHandler } from '../src/commands/rewrite.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const APPLY = path.join(FIXTURES, 'apply');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-rewrite-'));

async function rewrite(argv) {
  const stdout = [];
  const stderr = [];
  const handler = rewriteHandler({ log: line => stdout.push(line), error: line => stderr.push(line) });
  const code = await run(['rewrite', ...argv], { handlers: { rewrite: handler }, error: line => stderr.push(line) });
  return { code, stdout, stderr };
}

test('applies the manifest: entries + rewrites hit, exclude/link-text/fences/archived untouched (byte-exact)', async () => {
  const outFile = path.join(tmp(), 'out.md');
  const { code, stdout, stderr } = await rewrite([
    path.join(APPLY, 'source.md'),
    '-m',
    path.join(APPLY, 'wayback.json'),
    '-o',
    outFile
  ]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(stdout, [], 'the artifact IS the output; stdout stays empty');
  assert.deepEqual(stderr, []);
  assert.equal(fs.readFileSync(outFile, 'utf8'), fs.readFileSync(path.join(APPLY, 'expected.md'), 'utf8'));
});

test('a url with no verdict: warned on stderr, exit 1, output still written untouched', async () => {
  const outFile = path.join(tmp(), 'out.md');
  const { code, stderr } = await rewrite([
    path.join(FIXTURES, 'gen', 'uncovered.md'),
    '-m',
    path.join(APPLY, 'wayback.json'),
    '-o',
    outFile
  ]);
  assert.equal(code, EXIT.DOMAIN);
  assert.ok(stderr.includes('no verdict: http://unknown.example.com/page'));
  assert.ok(stderr.some(l => /rewrite incomplete: 1 url\(s\) had no verdict/.test(l)));
  // Best-available published form: the file exists, the url passed through.
  assert.match(fs.readFileSync(outFile, 'utf8'), /\(http:\/\/unknown\.example\.com\/page\)/);
});

test('a v1 manifest reads through: wayback:null means exclude, so the url stays live without warning', async () => {
  const dir = tmp();
  const sourceFile = path.join(dir, 'source.md');
  const outFile = path.join(dir, 'out.md');
  fs.writeFileSync(sourceFile, 'A [gone](http://never-captured.example.com/) link.\n');

  const { code, stderr } = await rewrite([
    sourceFile,
    '-m',
    path.join(FIXTURES, 'tree', 'b', 'nested', 'wayback.json'), // version 1, null entry
    '-o',
    outFile
  ]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(stderr, []);
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'A [gone](http://never-captured.example.com/) link.\n');
});
