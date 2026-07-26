// `waybackify manifest` (surface v2: GENERATION) — offline, zero network.
//
// The pipeline itself (link extraction, universe subset baking, seen-union
// precedence, canonical serialization) is tested where it lives:
// spv/waybackify/test/manifest.test.js. This file pins the CLI contract over
// the REAL library with an injected resolver: argv → files read, ONE
// generate() run, manifest + seen written canonically, one stats line on
// stdout — and the issue's acceptance demonstrations: idempotence (second
// run = zero resolver calls, byte-identical files), --offline failing on
// unanswered urls, and deferral keeping already-obtained verdicts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, run } from '../src/cli.js';
import { manifestHandler } from '../src/commands/manifest.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gen');
const SOURCE = path.join(FIXTURES, 'source.md');
const UNCOVERED = path.join(FIXTURES, 'uncovered.md');
const UNIVERSE = path.join(FIXTURES, 'universe.json');
const SEEN = path.join(FIXTURES, 'seen.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-manifest-'));

/** Run the manifest command with a counting resolver; returns observables. */
async function generate(argv, { resolve } = {}) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  const handler = manifestHandler({
    resolve:
      resolve ??
      (url => {
        calls.push(url);
        throw new Error('unexpected resolver call');
      }),
    log: line => stdout.push(line),
    error: line => stderr.push(line)
  });
  const code = await run(['manifest', ...argv], { handlers: { manifest: handler }, error: line => stderr.push(line) });
  return { code, stdout, stderr, calls };
}

test('covered urls never touch the resolver: universe bakes, seen answers, canonical manifest written', async () => {
  const dir = tmp();
  const seenFile = path.join(dir, 'seen.json');
  const outFile = path.join(dir, 'wayback.json');
  fs.copyFileSync(SEEN, seenFile);

  const { code, stdout, calls } = await generate([SOURCE, '-u', UNIVERSE, '-s', seenFile, '-o', outFile]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls, [], 'every url was answered offline');

  // ONE stats line on stdout, jq-friendly.
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    output: outFile,
    urls: 3,
    fromUniverse: 2,
    fromSeen: 1,
    resolved: 0,
    deferred: 0
  });

  // The written manifest is canonical schema v2 with all three verdicts.
  const manifest = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.rewrites, { 'http://feeds.example.com/blog': 'https://blog.example.net/feed' });
  assert.deepEqual(Object.keys(manifest.entries), ['http://sudomakethought.com/post/123']);
  assert.deepEqual(manifest.exclude, ['https://tracker.example.com/pixel.gif']);
});

test('a never-seen url resolves once and lands in the manifest AND the seen union (read-write)', async () => {
  const dir = tmp();
  const seenFile = path.join(dir, 'seen.json');
  const outFile = path.join(dir, 'wayback.json');
  fs.copyFileSync(SEEN, seenFile);

  const calls = [];
  const { code } = await generate([UNCOVERED, '-u', UNIVERSE, '-s', seenFile, '-o', outFile], {
    resolve: url => {
      calls.push(url);
      return { url: `https://web.archive.org/web/20240101000000/${url}`, timestamp: '20240101000000' };
    }
  });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls, ['http://unknown.example.com/page']);

  const manifest = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(
    manifest.entries['http://unknown.example.com/page'].wayback,
    'https://web.archive.org/web/20240101000000/http://unknown.example.com/page'
  );
  // The seen file grew: its prior verdict is intact, this run's was appended.
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.deepEqual(Object.keys(seen.entries).sort(), [
    'http://sudomakethought.com/post/123',
    'http://unknown.example.com/page'
  ]);
});

test('IDEMPOTENT: the second run makes zero resolver calls and writes byte-identical output', async () => {
  const dir = tmp();
  const seenFile = path.join(dir, 'seen.json'); // does not exist yet — first run bootstraps it
  const outFile = path.join(dir, 'wayback.json');

  const first = await generate([UNCOVERED, '-u', UNIVERSE, '-s', seenFile, '-o', outFile], {
    resolve: url => ({ url: `https://web.archive.org/web/20240101000000/${url}`, timestamp: '20240101000000' })
  });
  assert.equal(first.code, EXIT.OK);
  const manifestBytes = fs.readFileSync(outFile);
  const seenBytes = fs.readFileSync(seenFile);

  // Second run: the DEFAULT counting resolver throws on any call, so a zero
  // network rerun is proven by exit 0 alone; byte-compare both artifacts.
  const second = await generate([UNCOVERED, '-u', UNIVERSE, '-s', seenFile, '-o', outFile]);
  assert.equal(second.code, EXIT.OK);
  assert.deepEqual(second.calls, [], 'second run = zero resolver calls');
  assert.deepEqual(fs.readFileSync(outFile), manifestBytes, 'manifest is byte-identical');
  assert.deepEqual(fs.readFileSync(seenFile), seenBytes, 'seen union is byte-identical');
});

test('--offline: an unanswered url defers — exit 1, urls on stderr, partial manifest still written', async () => {
  const dir = tmp();
  const outFile = path.join(dir, 'wayback.json');

  const { code, stdout, stderr } = await generate([UNCOVERED, '-u', UNIVERSE, '-o', outFile, '--offline']);
  assert.equal(code, EXIT.DOMAIN);
  assert.ok(stderr.some(l => l.startsWith('unresolved: http://unknown.example.com/page')));
  assert.ok(stderr.some(l => /manifest incomplete: 1 url\(s\) unresolved — rerun without --offline/.test(l)));
  assert.equal(JSON.parse(stdout[0]).deferred, 1);
  // The partial manifest exists (nothing to say yet, but canonically shaped).
  const manifest = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.entries, {});
});

test('a resolver failure defers without losing obtained verdicts; the rerun resumes', async () => {
  const dir = tmp();
  const sourceFile = path.join(dir, 'two.md');
  const seenFile = path.join(dir, 'seen.json');
  const outFile = path.join(dir, 'wayback.json');
  fs.writeFileSync(
    sourceFile,
    'Links: [a](http://alpha.example.com/) and [b](http://beta.example.com/).\n'
  );

  // First run: alpha resolves, beta throws (transient archive trouble).
  const first = await generate([sourceFile, '-u', UNIVERSE, '-s', seenFile, '-o', outFile], {
    resolve: url => {
      if (url.includes('alpha')) {
        return { url: `https://web.archive.org/web/20240101000000/${url}`, timestamp: '20240101000000' };
      }
      throw new Error('CDX 503');
    }
  });
  assert.equal(first.code, EXIT.DOMAIN);
  assert.ok(first.stderr.some(l => l === 'unresolved: http://beta.example.com/: CDX 503'));
  // Alpha's verdict was kept in BOTH artifacts.
  assert.ok(JSON.parse(fs.readFileSync(outFile, 'utf8')).entries['http://alpha.example.com/']);
  assert.ok(JSON.parse(fs.readFileSync(seenFile, 'utf8')).entries['http://alpha.example.com/']);

  // Rerun: only beta costs a resolver call.
  const calls = [];
  const second = await generate([sourceFile, '-u', UNIVERSE, '-s', seenFile, '-o', outFile], {
    resolve: url => {
      calls.push(url);
      return { url: `https://web.archive.org/web/20240102000000/${url}`, timestamp: '20240102000000' };
    }
  });
  assert.equal(second.code, EXIT.OK);
  assert.deepEqual(calls, ['http://beta.example.com/']);
  const manifest = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(Object.keys(manifest.entries).sort(), ['http://alpha.example.com/', 'http://beta.example.com/']);
});

test('a "clean not archived" verdict (resolver null) lands in exclude, and the seen file remembers it', async () => {
  const dir = tmp();
  const seenFile = path.join(dir, 'seen.json');
  const outFile = path.join(dir, 'wayback.json');

  const first = await generate([UNCOVERED, '-u', UNIVERSE, '-s', seenFile, '-o', outFile], {
    resolve: () => null
  });
  assert.equal(first.code, EXIT.OK);
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')).exclude, ['http://unknown.example.com/page']);

  // The verdict is remembered: an --offline rerun now succeeds.
  const second = await generate([UNCOVERED, '-u', UNIVERSE, '-s', seenFile, '-o', outFile, '--offline']);
  assert.equal(second.code, EXIT.OK);
});
