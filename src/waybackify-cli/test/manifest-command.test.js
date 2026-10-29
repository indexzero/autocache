// `waybackify manifest` (surface v2: GENERATION) — offline, zero network.
//
// The pipeline itself (link extraction, universe subset baking, seen-union
// precedence, canonical serialization) is tested where it lives:
// src/waybackify/test/manifest.test.js. This file pins the CLI contract over
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

// --- --near passes straight through to generate → resolve(url, { near })

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

test('noRewrite: the prior manifest at -o keeps its authored never-rewrite set across regeneration', async () => {
  const dir = tmp();
  const seenFile = path.join(dir, 'seen.json');
  const outFile = path.join(dir, 'wayback.json');
  fs.copyFileSync(SEEN, seenFile);
  // The author forbids the rewrite that the universe bakes for the feed link.
  fs.writeFileSync(outFile, `${JSON.stringify({ version: 2, noRewrite: ['http://feeds.example.com/blog'], entries: {} })}\n`);

  const { code, calls } = await generate([SOURCE, '-u', UNIVERSE, '-s', seenFile, '-o', outFile]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls, []);
  const manifest = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(manifest.noRewrite, ['http://feeds.example.com/blog']);
  assert.equal(manifest.rewrites, undefined, 'the universe rewrite never baked over the authored set');

  // A second run is byte-identical: the set travels with the post.
  const first = fs.readFileSync(outFile, 'utf8');
  assert.equal((await generate([SOURCE, '-u', UNIVERSE, '-s', seenFile, '-o', outFile])).code, EXIT.OK);
  assert.equal(fs.readFileSync(outFile, 'utf8'), first);
});


const originalA = 'http://original.example/post';
const originalB = 'http://second.example/post';
const snapshot = (url, timestamp = '20140403040000') => ({
  url: `https://web.archive.org/web/${timestamp}/${url}`, timestamp
});
function sourceFixture(text = 'A document with no links.') {
  const dir = tmp();
  const source = path.join(dir, 'post.md');
  const output = path.join(dir, 'wayback.json');
  const seen = path.join(dir, 'seen.json');
  fs.writeFileSync(source, text);
  return { source, output, seen, argv: [source, '-u', UNIVERSE, '-o', output] };
}

test('repeated --source flags resolve once each, forward --near, and write sorted sources', async () => {
  const f = sourceFixture();
  const calls = [];
  const result = await generate([...f.argv, '--source', originalB, '--source', originalA, '--source', originalB, '--near', '20140203'], {
    resolve: (url, opts) => { calls.push([url, opts.near]); return snapshot(url); }
  });
  assert.equal(result.code, EXIT.OK);
  assert.deepEqual(calls, [[originalB, '20140203'], [originalA, '20140203']]);
  const m = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.deepEqual(Object.keys(m.sources), [originalA, originalB]);
  assert.equal(m.sources[originalA].wayback, snapshot(originalA).url);
  assert.equal(m.sources[originalA].timestamp, '20140403040000');
  assert.deepEqual(m.entries, {});
  assert.equal(m.exclude, undefined);
});

test('source reruns preserve bytes and existing captures, including a run without flags', async () => {
  const f = sourceFixture();
  const argv = [...f.argv, '--source', originalA];
  assert.equal((await generate(argv, { resolve: url => snapshot(url) })).code, EXIT.OK);
  const first = fs.readFileSync(f.output, 'utf8');
  const rerun = await generate([...argv, '--offline']);
  assert.equal(rerun.code, EXIT.OK);
  assert.deepEqual(rerun.calls, []);
  assert.equal(fs.readFileSync(f.output, 'utf8'), first);
  assert.equal((await generate(f.argv)).code, EXIT.OK);
  assert.equal(fs.readFileSync(f.output, 'utf8'), first);
  const added = await generate([...f.argv, '--source', originalA, '--source', originalB], { resolve: url => {
    assert.equal(url, originalB);
    return snapshot(url, '20200101000000');
  } });
  assert.equal(added.code, EXIT.OK);
  const m = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.deepEqual(m.sources[originalA], JSON.parse(first).sources[originalA]);
  assert.equal(m.sources[originalB].timestamp, '20200101000000');
});

test('offline sources reuse seen captures independently of link policy', async () => {
  const f = sourceFixture();
  const excluded = 'https://tracker.example.com/pixel.gif';
  const entry = url => ({ wayback: snapshot(url).url, timestamp: '20140403040000' });
  fs.writeFileSync(f.seen, JSON.stringify({
    version: 2, sources: { [originalA]: entry(originalA) }, entries: { [excluded]: entry(excluded) }, exclude: [originalA]
  }));
  const result = await generate([...f.argv, '-s', f.seen, '--source', excluded, '--source', originalA, '--offline']);
  assert.equal(result.code, EXIT.OK);
  assert.deepEqual(result.calls, []);
  const m = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.deepEqual(m.sources, { [originalA]: entry(originalA), [excluded]: entry(excluded) });
  assert.deepEqual(m.entries, {});
  assert.equal(m.exclude, undefined);
});

for (const [name, resolveBad] of [
  ['unarchived', () => null],
  ['resolver failure', () => { throw new Error('resolver unavailable'); }],
  ['a capture of another original', url => snapshot(url.replace('/post', '/Post'))],
  ['invalid timestamp', url => ({ ...snapshot(url), timestamp: '2014' })]
]) {
  test(`a source with ${name} leaves existing manifest and seen bytes unchanged`, async () => {
    const f = sourceFixture('[Link](http://linked.example/page)');
    const existing = { wayback: snapshot('http://existing.example/post').url, timestamp: '20140403040000' };
    const manifestBytes = JSON.stringify({ version: 2, sources: { 'http://existing.example/post': existing }, entries: {} }, null, 4) + '\n';
    const seenBytes = '{"version":2,"entries":{}}\n';
    fs.writeFileSync(f.output, manifestBytes);
    fs.writeFileSync(f.seen, seenBytes);
    const result = await generate([...f.argv, '-s', f.seen, '--source', originalA, '--source', originalB], {
      resolve: url => url === originalB ? resolveBad(url) : snapshot(url)
    });
    assert.equal(result.code, EXIT.DOMAIN);
    assert.equal(fs.readFileSync(f.output, 'utf8'), manifestBytes);
    assert.equal(fs.readFileSync(f.seen, 'utf8'), seenBytes);
    assert.ok(result.stderr.some(s => s.includes(`unresolved source: ${originalB}`)));
    assert.deepEqual(result.stdout, []);
  });
}

test('unresolved offline sources create neither output file and report every requested source', async () => {
  const f = sourceFixture();
  const result = await generate([...f.argv, '-s', f.seen, '--source', originalA, '--source', originalB, '--offline']);
  assert.equal(result.code, EXIT.DOMAIN);
  assert.deepEqual(result.calls, []);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.existsSync(f.seen), false);
  assert.ok(result.stderr.some(s => s.includes(`unresolved source: ${originalA}`)));
  assert.ok(result.stderr.some(s => s.includes(`unresolved source: ${originalB}`)));
});

test('sources do not alter ordinary link generation', async () => {
  const f = sourceFixture(fs.readFileSync(SOURCE, 'utf8'));
  fs.copyFileSync(SEEN, f.seen);
  assert.equal((await generate([...f.argv, '-s', f.seen, '--offline'])).code, EXIT.OK);
  const ordinary = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.equal((await generate([...f.argv, '-s', f.seen, '--source', originalA], { resolve: url => snapshot(url) })).code, EXIT.OK);
  const withSource = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  delete withSource.sources;
  assert.deepEqual(withSource, ordinary);
});

test('--source rejects non-web and malformed URLs before writing', async () => {
  const f = sourceFixture();
  for (const value of ['not-a-url', 'ftp://original.example/post', 'https://']) {
    assert.equal((await generate([...f.argv, '--source', value])).code, EXIT.USAGE);
  }
  assert.equal(fs.existsSync(f.output), false);
});


const distinctOriginals = [
  ['path case', 'http://identity.example/Post', 'http://identity.example/post'],
  ['query value case', 'http://identity.example/?id=ABC', 'http://identity.example/?id=abc'],
  ['query key case', 'http://identity.example/?ID=abc', 'http://identity.example/?id=abc'],
  ['scheme', 'http://identity.example/post', 'https://identity.example/post'],
  ['www host', 'http://www.identity.example/post', 'http://identity.example/post'],
  ['path slash', 'http://identity.example/post/', 'http://identity.example/post'],
  ['non-default port', 'http://identity.example:8080/post', 'http://identity.example/post'],
  ['http zero port', 'http://identity.example:0/post', 'http://identity.example/post'],
  ['http padded zero port', 'http://identity.example:000/post', 'http://identity.example/post'],
  ['https zero port', 'https://identity.example:0/post', 'https://identity.example/post'],
  ['https padded zero port', 'https://identity.example:000/post', 'https://identity.example/post'],
  ['percent encoding', 'http://identity.example/%50ost', 'http://identity.example/Post'],
  ['percent escape case', 'http://identity.example/?id=%2f', 'http://identity.example/?id=%2F'],
  ['dot segments', 'http://identity.example/a/../post', 'http://identity.example/post']
];

for (const [name, first, second] of distinctOriginals) {
  test(`sources with distinct ${name} resolve separately and exact duplicate flags stay idempotent`, async () => {
    const f = sourceFixture();
    const calls = [];
    const argv = [...f.argv, '-s', f.seen, '--source', first, '--source', second, '--source', first];
    const result = await generate(argv, { resolve: url => { calls.push(url); return snapshot(url); } });
    assert.equal(result.code, EXIT.OK);
    assert.deepEqual(calls, [first, second]);
    const output = fs.readFileSync(f.output, 'utf8');
    const seen = fs.readFileSync(f.seen, 'utf8');
    const manifest = JSON.parse(output);
    assert.deepEqual(Object.keys(manifest.sources), [first, second].sort());
    assert.equal(manifest.sources[first].wayback, snapshot(first).url);
    assert.equal(manifest.sources[second].wayback, snapshot(second).url);
    assert.deepEqual(manifest.entries, {});
    assert.equal((await generate([...argv, '--offline'])).code, EXIT.OK);
    assert.equal(fs.readFileSync(f.output, 'utf8'), output);
    assert.equal(fs.readFileSync(f.seen, 'utf8'), seen);
  });
}

for (const [name, known, requested] of distinctOriginals) {
  for (const section of ['sources', 'entries']) {
    test(`offline ${section} do not answer a distinct ${name} source or write either file`, async () => {
      for (const existingOutput of [false, true]) {
        const f = sourceFixture();
        const capture = { wayback: snapshot(known).url, timestamp: '20140403040000' };
        const seenBytes = JSON.stringify({ version: 2, [section]: { [known]: capture } }, null, 4) + '\n';
        const outputBytes = '{"version":2,"entries":{}}\n';
        fs.writeFileSync(f.seen, seenBytes);
        if (existingOutput) fs.writeFileSync(f.output, outputBytes);
        const result = await generate([
          ...f.argv, '-s', f.seen, '--source', known, '--source', requested, '--offline'
        ]);
        assert.equal(result.code, EXIT.DOMAIN);
        assert.deepEqual(result.calls, []);
        assert.ok(result.stderr.some(message => message.includes(`unresolved source: ${requested}`)));
        assert.deepEqual(result.stdout, []);
        assert.equal(fs.readFileSync(f.seen, 'utf8'), seenBytes);
        if (existingOutput) assert.equal(fs.readFileSync(f.output, 'utf8'), outputBytes);
        else assert.equal(fs.existsSync(f.output), false);
      }
    });
  }
}

for (const section of ['sources', 'entries']) {
  test(`a ${section} key cannot disguise a capture of another original as a source`, async () => {
    const f = sourceFixture(`[Link](${originalA})`);
    const wrong = snapshot(originalA.replace('/post', '/Post'));
    const bytes = JSON.stringify({ version: 2, [section]: {
      [originalA]: { wayback: wrong.url, timestamp: wrong.timestamp }
    } }) + '\n';
    fs.writeFileSync(f.seen, bytes);
    const result = await generate([...f.argv, '-s', f.seen, '--source', originalA, '--offline']);
    assert.equal(result.code, EXIT.DOMAIN);
    assert.equal(fs.existsSync(f.output), false);
    assert.equal(fs.readFileSync(f.seen, 'utf8'), bytes);
    assert.ok(result.stderr.some(message => message.includes(`unresolved source: ${originalA}`)));
  });
}


for (const [name, first, second] of distinctOriginals) {
  for (const section of ['sources', 'entries']) {
    test(`offline sources reuse the correct cached ${name} captures from ${section}`, async () => {
      const f = sourceFixture();
      const entry = (url, timestamp) => ({ wayback: snapshot(url, timestamp).url, timestamp });
      const captures = { [first]: entry(first, '20140401000000'), [second]: entry(second, '20140402000000') };
      fs.writeFileSync(f.seen, JSON.stringify({ version: 2, [section]: captures }));
      const result = await generate([
        ...f.argv, '-s', f.seen, '--source', first, '--source', second, '--source', first, '--offline'
      ]);
      assert.equal(result.code, EXIT.OK);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')).sources, captures);
    });
  }
}

test('a source can reuse a known capture by its actual original despite an aliased link key', async () => {
  const f = sourceFixture();
  const capture = { wayback: snapshot(originalA).url, timestamp: '20140403040000' };
  fs.writeFileSync(f.seen, JSON.stringify({ version: 2, entries: { [originalB]: capture } }));
  const result = await generate([...f.argv, '-s', f.seen, '--source', originalA, '--offline']);
  assert.equal(result.code, EXIT.OK);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')).sources, { [originalA]: capture });
});


for (const [name, first, second] of [
  ['HTTP default port', 'http://identity.example/Post', 'http://identity.example:80/Post'],
  ['HTTPS default port', 'https://identity.example/Post', 'https://identity.example:443/Post'],
  ['HTTP empty port', 'http://identity.example/Post', 'http://identity.example:/Post'],
  ['HTTPS empty port', 'https://identity.example/Post', 'https://identity.example:/Post'],
  ['HTTP padded default port', 'http://identity.example/Post', 'http://identity.example:080/Post'],
  ['HTTPS padded default port', 'https://identity.example/Post', 'https://identity.example:0443/Post'],
  ['HTTP twice-padded default port', 'http://identity.example/Post', 'http://identity.example:0080/Post'],
  ['HTTPS twice-padded default port', 'https://identity.example/Post', 'https://identity.example:00443/Post'],
  ['bare root', 'http://identity.example', 'http://identity.example/'],
  ['root with query', 'https://identity.example?ID=%2f', 'https://identity.example:443/?ID=%2f'],
  ['scheme and host case', 'HTTP://Identity.Example/Post', 'http://identity.example/Post'],
  ['combined spellings', 'HTTPS://Identity.Example:443', 'https://identity.example/']
]) {
  for (const section of ['sources', 'entries']) {
    test(`offline sources reuse ${name} in ${section} without migrating keys or metadata`, async () => {
      for (const [known, requested] of [[first, second], [second, first]]) {
        const f = sourceFixture();
        const capture = {
          wayback: snapshot(known).url, timestamp: '20140403040000',
          checkedAt: '2020-01-02T03:04:05Z', note: 'keep prior capture metadata'
        };
        const alias = 'http://unrelated.example/alias';
        const prior = { version: 2, [section]: { [known]: capture, [alias]: capture } };
        fs.writeFileSync(f.seen, JSON.stringify(prior));
        const argv = [...f.argv, '-s', f.seen, '--source', requested, '--source', requested, '--offline'];
        const result = await generate(argv);
        assert.equal(result.code, EXIT.OK);
        assert.deepEqual(result.calls, []);
        const manifest = JSON.parse(fs.readFileSync(f.output, 'utf8'));
        const seen = JSON.parse(fs.readFileSync(f.seen, 'utf8'));
        assert.deepEqual(manifest.sources, { [requested]: capture });
        assert.deepEqual(manifest.entries, {});
        assert.deepEqual(seen[section][known], capture);
        assert.deepEqual(seen[section][alias], capture);
        assert.deepEqual(seen.sources[requested], capture);
        const outputBytes = fs.readFileSync(f.output, 'utf8');
        const seenBytes = fs.readFileSync(f.seen, 'utf8');
        assert.equal((await generate(argv)).code, EXIT.OK);
        assert.equal(fs.readFileSync(f.output, 'utf8'), outputBytes);
        assert.equal(fs.readFileSync(f.seen, 'utf8'), seenBytes);
      }
    });
  }
}

test('equivalent requested spellings share one resolved capture while retaining both source keys', async () => {
  const f = sourceFixture();
  const first = 'HTTP://Identity.Example:80/Post';
  const second = 'http://identity.example/Post';
  const calls = [];
  const result = await generate([...f.argv, '--source', first, '--source', second, '--source', first], {
    resolve: url => { calls.push(url); return snapshot(second); }
  });
  assert.equal(result.code, EXIT.OK);
  assert.deepEqual(calls, [first]);
  const manifest = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.deepEqual(Object.keys(manifest.sources), [first, second].sort());
  assert.deepEqual(manifest.sources[first], manifest.sources[second]);
  assert.equal(manifest.sources[first].wayback, snapshot(second).url);
});

test('an existing source keeps its capture when an equivalent seen source has a newer capture', async () => {
  const f = sourceFixture();
  const requested = 'http://identity.example/Post';
  const known = 'HTTP://Identity.Example:80/Post';
  const prior = { wayback: snapshot(requested).url, timestamp: '20140403040000', note: 'preserve' };
  const newer = { wayback: snapshot(known, '20200101000000').url, timestamp: '20200101000000' };
  fs.writeFileSync(f.output, JSON.stringify({ version: 2, sources: { [requested]: prior }, entries: {} }));
  fs.writeFileSync(f.seen, JSON.stringify({ version: 2, sources: { [known]: newer }, entries: {} }));
  const result = await generate([...f.argv, '-s', f.seen, '--source', requested, '--source', known, '--offline']);
  assert.equal(result.code, EXIT.OK);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')).sources, { [requested]: prior, [known]: newer });
});
