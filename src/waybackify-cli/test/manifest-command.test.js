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
      })
  });
  // Diagnostics (unresolved-url warnings) now ride the logger; land their human
  // message in the same stderr array the old deps.error sink captured.
  const push = (o, m) => stderr.push(typeof o === 'string' ? o : m);
  const logger = { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
  const code = await run(['manifest', ...argv], {
    handlers: { manifest: handler },
    logger,
    out: line => stdout.push(line),
    error: line => stderr.push(line)
  });
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

// --- #404: --near passes straight through to generate → resolve(url, { near })

test('--near passes through to the resolver as { near } for a never-seen url', async () => {
  const dir = tmp();
  const outFile = path.join(dir, 'wayback.json');

  const nears = [];
  const { code } = await generate([UNCOVERED, '-u', UNIVERSE, '-o', outFile, '--near', '20180615'], {
    // The library invokes the injected resolver as resolve(url, { near }); the
    // flag value must arrive verbatim as the second-arg near.
    resolve: (url, opts) => {
      nears.push(opts?.near);
      return { url: `https://web.archive.org/web/20180615000000/${url}`, timestamp: '20180615000000' };
    }
  });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(nears, ['20180615'], 'the resolver saw the exact --near value');
  // The picked capture is the one the resolver returned under that anchor.
  assert.equal(
    JSON.parse(fs.readFileSync(outFile, 'utf8')).entries['http://unknown.example.com/page'].timestamp,
    '20180615000000'
  );
});

test('--near accepts both the 8-digit date and the 14-digit datetime shapes', async () => {
  for (const ts of ['20180615', '20180615120000']) {
    const dir = tmp();
    const outFile = path.join(dir, 'wayback.json');
    const nears = [];
    const { code } = await generate([UNCOVERED, '-u', UNIVERSE, '-o', outFile, '--near', ts], {
      resolve: (url, opts) => {
        nears.push(opts?.near);
        return { url: `https://web.archive.org/web/${ts.padEnd(14, '0')}/${url}`, timestamp: ts.padEnd(14, '0') };
      }
    });
    assert.equal(code, EXIT.OK, `shape ${ts} is accepted`);
    assert.deepEqual(nears, [ts]);
  }
});

test('a malformed --near is a usage error (exit 2), never a NaN capture pick', async () => {
  // Not-a-timestamp, wrong digit counts, and a mixed alnum value — each a
  // usage error surfaced BEFORE any resolver call or file write.
  for (const ts of ['2018', '201806', '2018061', '201806150', '2018-06-15', '20180615T12', 'yesterday', '']) {
    const dir = tmp();
    const outFile = path.join(dir, 'wayback.json');
    const calls = [];
    const { code } = await generate([UNCOVERED, '-u', UNIVERSE, '-o', outFile, '--near', ts], {
      resolve: url => {
        calls.push(url);
        throw new Error('resolver must not run for a malformed --near');
      }
    });
    assert.equal(code, EXIT.USAGE, `--near ${JSON.stringify(ts)} is a usage error`);
    assert.deepEqual(calls, [], 'no resolver call for a malformed --near');
    assert.equal(fs.existsSync(outFile), false, 'no manifest written for a malformed --near');
  }
});
