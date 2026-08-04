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

// A logger whose diagnostics land in `sink` as their human message — so the
// stderr assertions read the same lines the old deps.error sink captured.
function mkLogger(sink) {
  const push = (o, m) => sink.push(typeof o === 'string' ? o : m);
  return { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
}

async function rewrite(argv) {
  const stdout = [];
  const stderr = [];
  const handler = rewriteHandler({});
  const code = await run(['rewrite', ...argv], {
    handlers: { rewrite: handler },
    logger: mkLogger(stderr), // no-verdict warnings now ride the logger
    out: line => stdout.push(line),
    error: line => stderr.push(line) // run()'s bail message (rewrite incomplete)
  });
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

test('--chrome-host threads through to apply: the archived link points at the override host (#453)', async () => {
  const outFile = path.join(tmp(), 'out.md');
  const { code, stderr } = await rewrite([
    path.join(APPLY, 'source.md'),
    '-m',
    path.join(APPLY, 'wayback.json'),
    '-o',
    outFile,
    '--chrome-host',
    'wb.example.test'
  ]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(stderr, []);
  const out = fs.readFileSync(outFile, 'utf8');
  // The resolved entry lands on the override host, never live web.archive.org.
  assert.match(out, /\(https:\/\/wb\.example\.test\/web\/20140403040000\/http:\/\/sudomakethought\.com\/post\/123\)/);
  assert.ok(!out.includes('wayback.example.com'));
  // An already-archived web.archive.org inline link is still left as-is.
  assert.match(out, /\(https:\/\/web\.archive\.org\/web\/19990101000000\//);
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
