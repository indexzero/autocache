// waybackify CLI surface tests — offline, zero network.
//
// Three layers, per the issue's verification list:
//   1. Help snapshots — root + per-command help pinned byte-for-byte against
//      test/fixtures/help/*.txt (regenerate deliberately with
//      `node test/regen-help-fixtures.js` when the surface changes). The
//      surface is nested: five flat verbs plus the `cache` GROUP and its five
//      subcommands (add · fill · verify · remaster · sync), each snapshotted
//      (`cache.txt`, `cache-add.txt`, …).
//   2. Strict-flag / usage rejection — unknown flags and missing required
//      args/flags exit 2 (paparam is strict by default; pinned here so a
//      paparam upgrade that loosens parsing fails loudly).
//   3. Wiring + exit-code contract — every command parses its full flag
//      surface, hands the parsed payload to its handler, and the defensive
//      missing-handler path still exits 70.
//
// Layer 2/3 exit codes go through the REAL bin (child_process.spawnSync on
// bin/waybackify.js) so the test observes what a shell observes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCLI, EXIT, NotImplementedError, run } from '../src/cli.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG, 'bin', 'waybackify.js');
const FIXTURES = path.join(PKG, 'test', 'fixtures');
const fixture = name => fs.readFileSync(path.join(FIXTURES, 'help', `${name}.txt`), 'utf8');

/** Run the real bin. Returns { status, stdout, stderr }. */
function cli(...argv) {
  const r = spawnSync(process.execPath, [BIN, ...argv], { encoding: 'utf8' });
  assert.equal(r.error, undefined);
  return r;
}

const WB = 'https://web.archive.org/web/20140403040000/http://example.com/';

// Flat verbs (top-level help) + the `cache` group; the group's subcommands are
// snapshotted separately as `cache-<verb>.txt`.
const FLAT = ['manifest', 'rewrite', 'ledger', 'check', 'search'];
const CACHE_VERBS = ['add', 'fill', 'verify', 'remaster', 'sync'];
// Handler keys the bin + createCLI() wire (cache verbs → cacheAdd, cacheFill, …).
const HANDLER_KEYS = ['manifest', 'rewrite', 'ledger', 'check', 'search', 'cacheAdd', 'cacheFill', 'cacheVerify', 'cacheRemaster', 'cacheSync'];

// ---------------------------------------------------------------------------
// 1. Help snapshots
// ---------------------------------------------------------------------------

test('root --help lists the flat verbs and the cache group (snapshot)', () => {
  const { status, stdout, stderr } = cli('--help');
  assert.equal(status, EXIT.OK);
  assert.equal(stderr, '');
  // paparam prints help via console.log, which appends one newline to the
  // help() string (verified: index.js:248 @1.10.1).
  assert.equal(stdout, `${fixture('root')}\n`);
  for (const line of [
    /manifest\s+Generate the manifest for one markdown source/,
    /rewrite\s+Apply a manifest to a markdown source/,
    /ledger\s+Survey the manifests under a tree/,
    /check\s+Full wayback-404 verdict for the exact capture/,
    /search\s+CDX capture query — re-pick a better capture/,
    /cache\s+Cache-store ops: add · fill · verify · remaster · sync/
  ]) {
    assert.match(stdout, line);
  }
  // backfill is gone from the top level (it moved under `cache fill`).
  assert.doesNotMatch(stdout, /^\s*backfill\s/m);
});

// Flat verbs + the cache group itself.
for (const name of [...FLAT, 'cache']) {
  test(`${name} --help matches its snapshot and exits 0`, () => {
    const { status, stdout, stderr } = cli(name, '--help');
    assert.equal(status, EXIT.OK);
    assert.equal(stderr, '');
    assert.equal(stdout, `${fixture(name)}\n`);
  });

  test(`createCLI().help('${name}') equals the live -h output (single source)`, () => {
    assert.equal(createCLI().help(name), fixture(name));
  });
}

// The cache group's subcommands (nested help).
for (const verb of CACHE_VERBS) {
  test(`cache ${verb} --help matches its snapshot and exits 0`, () => {
    const { status, stdout, stderr } = cli('cache', verb, '--help');
    assert.equal(status, EXIT.OK);
    assert.equal(stderr, '');
    assert.equal(stdout, `${fixture(`cache-${verb}`)}\n`);
  });

  test(`createCLI().help('cache', '${verb}') equals the live -h output (nested, single source)`, () => {
    assert.equal(createCLI().help('cache', verb), fixture(`cache-${verb}`));
  });
}

test('the cache group lists its five subcommands', () => {
  const { stdout } = cli('cache', '--help');
  for (const verb of CACHE_VERBS) assert.match(stdout, new RegExp(`^\\s*${verb}\\s`, 'm'));
});

// ---------------------------------------------------------------------------
// 2. Strict parsing → usage errors (exit 2)
// ---------------------------------------------------------------------------

test('unknown flags are rejected on every command (paparam strict mode)', () => {
  for (const argv of [
    ['manifest', '--nope', 'index.md'],
    ['rewrite', '--nope', 'index.md'],
    ['ledger', '--nope', '.'],
    ['check', '--nope', WB],
    ['search', '--nope', 'http://example.com/'],
    ['cache', 'add', '--nope', '-o', '/tmp/x', WB],
    ['cache', 'verify', '--nope', '-r', '/tmp/x']
  ]) {
    const { status, stderr } = cli(...argv);
    assert.equal(status, EXIT.USAGE, `argv: ${argv.join(' ')}`);
    assert.match(stderr, /UNKNOWN_FLAG: nope/);
  }
});

test('missing required positional exits 2 with the validator message', () => {
  for (const [argv, argName] of [
    [['manifest'], '<source.md>'],
    [['rewrite'], '<source.md>'],
    [['ledger'], '<dir>'],
    [['check'], '<wayback-url>'],
    [['search'], '<original-url>'],
    [['cache', 'add', '-o', '/tmp/x'], '<wayback-url>'],
    [['cache', 'fill', '-r', '/c'], '<dir>'],
    [['cache', 'remaster'], '<hermetic-root>'],
    [['cache', 'remaster', '/h'], '<remastered-root>']
  ]) {
    const { status, stderr } = cli(...argv);
    assert.equal(status, EXIT.USAGE, `argv: ${argv.join(' ')}`);
    assert.match(stderr, new RegExp(`missing required argument: ${argName.replace(/[<>.]/g, '\\$&')}`));
  }
});

test('missing required flags exit 2 with the validator message', () => {
  for (const [argv, flagSpec] of [
    [['manifest', 'index.md'], '--universe\\|-u <file>'],
    [['manifest', 'index.md', '-u', 'universe.json'], '--output\\|-o <file>'],
    [['rewrite', 'index.md'], '--manifest\\|-m <file>'],
    [['rewrite', 'index.md', '-m', 'wayback.json'], '--output\\|-o <file>'],
    [['cache', 'add', WB], '--root\\|-r <root>'],
    [['cache', 'fill', '.'], '--root\\|-r <root>'],
    [['cache', 'verify'], '--root\\|-r <root>'],
    [['cache', 'sync', '--bucket', 'b'], '--root\\|-r <root>'],
    [['cache', 'sync', '-r', '/c'], '--bucket <name>']
  ]) {
    const { status, stderr } = cli(...argv);
    assert.equal(status, EXIT.USAGE, `argv: ${argv.join(' ')}`);
    assert.match(stderr, new RegExp(`missing required flag: ${flagSpec}`));
  }
});

test('cache fill rejects non-numeric / negative pacing flags (exit 2)', () => {
  // paparam does not type flags; a typo'd number must be a usage error, not a
  // silent NaN that disables pacing or the abort ceiling. A NaN value (comma,
  // word) trips our numeric validate; a "-3" value is rejected by paparam
  // itself (a flag value can't start with '-') — both are usage errors.
  for (const argv of [
    ['cache', 'fill', '.', '-r', '/c', '--delay-ms', '1,500'],
    ['cache', 'fill', '.', '-r', '/c', '--abort-after', 'five']
  ]) {
    const { status, stderr } = cli(...argv);
    assert.equal(status, EXIT.USAGE, `argv: ${argv.join(' ')}`);
    assert.match(stderr, /must be non-negative numbers/);
  }
  assert.equal(cli('cache', 'fill', '.', '-r', '/c', '--max', '-3').status, EXIT.USAGE);
});

test('ledger --flatten and --root are mutually exclusive (exit 2)', () => {
  const { status, stderr } = cli('ledger', '.', '--flatten', '--root', '/tmp/root');
  assert.equal(status, EXIT.USAGE);
  assert.match(stderr, /--flatten and --root are mutually exclusive/);
});

test('the deprecated --against alias still selects the cache root (back-compat)', () => {
  // --against maps to the same worklist join as --root; here it collides with
  // --flatten exactly like --root does, proving the alias reaches the validator.
  const { status, stderr } = cli('ledger', '.', '--flatten', '--against', '/tmp/root');
  assert.equal(status, EXIT.USAGE);
  assert.match(stderr, /--flatten and --root are mutually exclusive/);
});

test('a value-required flag with no value exits 2 (INVALID_FLAG)', () => {
  const { status, stderr } = cli('search', 'http://example.com/', '--near');
  assert.equal(status, EXIT.USAGE);
  assert.match(stderr, /INVALID_FLAG: near/);
});

test('unknown subcommand exits 2', () => {
  const { status, stderr } = cli('frobnicate');
  assert.equal(status, EXIT.USAGE);
  assert.match(stderr, /UNKNOWN_ARG: frobnicate/);
});

test('unknown cache subcommand exits 2', () => {
  const { status, stderr } = cli('cache', 'frobnicate');
  assert.equal(status, EXIT.USAGE);
  assert.match(stderr, /UNKNOWN_ARG: frobnicate/);
});

test('bare invocation prints root help to stderr and exits 2', () => {
  const { status, stdout, stderr } = cli();
  assert.equal(status, EXIT.USAGE);
  assert.equal(stdout, '');
  assert.match(stderr, /Commands:/);
});

test('bare `cache` prints the cache group help to stderr and exits 2', () => {
  const { status, stdout, stderr } = cli('cache');
  assert.equal(status, EXIT.USAGE);
  assert.equal(stdout, '');
  assert.match(stderr, /Commands:/);
  assert.match(stderr, /^\s*add\s/m);
});

// ---------------------------------------------------------------------------
// 3. Wiring through the real bin + full flag-surface parsing
// ---------------------------------------------------------------------------

// Every command is wired to a real handler, so the per-command "exits 70"
// enumeration stays retired. The exit-70 contract itself is still pinned
// below: run() maps NotImplementedError → EXIT.NOT_IMPLEMENTED in the
// exit-code mapping test.

test('check is WIRED in the bin: a non-replay URL is a domain failure (1), not a 70', () => {
  // Proves bin/waybackify.js hands `check` the real handler: the library
  // rejects the URL before any network I/O, and run() maps the throw to
  // exit 1. (Offline by construction — parseWaybackUrl fails first.)
  const { status, stderr } = cli('check', 'https://example.com/not-wayback');
  assert.equal(status, EXIT.DOMAIN);
  assert.match(stderr, /not a wayback replay URL/);
});

test('cache add is WIRED in the bin: a non-replay URL is a domain failure (1), not a 70', () => {
  // Proves bin/waybackify.js hands `cache add` the real handler: the
  // library rejects the URL before any I/O, and run() maps the throw to
  // exit 1. (Offline by construction — parseWaybackUrl fails first.)
  const { status, stderr } = cli('cache', 'add', 'https://example.com/not-wayback', '-o', '/tmp/never-created');
  assert.equal(status, EXIT.DOMAIN);
  assert.match(stderr, /not a wayback replay URL/);
});

test('cache fill is WIRED in the bin: --dry-run over an empty ledger exits 0 with a summary', () => {
  // Proves bin/waybackify.js hands `cache fill` the real handler (a typo in the
  // `cacheFill:` wiring key would exit 70 here). Offline: --dry-run + a ledger
  // dir with no wayback.json → an empty worklist, no network.
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-fill-l-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-fill-r-'));
  const { status, stdout } = cli('cache', 'fill', ledger, '--root', root, '--dry-run');
  assert.equal(status, EXIT.OK);
  assert.match(stdout, /"dryRun":true/);
});

test('cache fill then cache verify on ONE root reads clean — .refetch/ is not foreign (exit 0)', () => {
  // Regression for the fill/verify state clash: `cache fill` writes <root>/.refetch/,
  // and `cache verify` must NOT flag it as a foreignRoot (which would be exit 1
  // forever). Offline end-to-end (dry-run fill still creates the .refetch/ dir).
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-fv-l-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-fv-r-'));
  assert.equal(cli('cache', 'fill', ledger, '--root', root, '--dry-run').status, EXIT.OK);
  assert.ok(fs.existsSync(path.join(root, '.refetch')), 'fill wrote its durable state');
  const { status, stdout } = cli('cache', 'verify', '--root', root);
  assert.equal(status, EXIT.OK, 'verify does not flag .refetch/ as foreign');
  assert.match(stdout, /clean/);
});

test('cache verify is WIRED in the bin: a fresh empty root reads clean (exit 0)', () => {
  // Proves bin/waybackify.js hands `cache verify` the real fsck over the real
  // library — offline by construction (an empty root touches no network).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-verify-'));
  const { status, stdout } = cli('cache', 'verify', '--root', dir);
  assert.equal(status, EXIT.OK);
  assert.match(stdout, /clean/);
});

test('cache sync is WIRED in the bin: an empty root emits an empty batch (exit 0)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-sync-'));
  const { status, stdout, stderr } = cli('cache', 'sync', '--root', dir, '--bucket', 'b');
  assert.equal(status, EXIT.OK, stderr);
  assert.equal(stdout, '', 'no objects → no batch lines on stdout');
  assert.match(stderr, /0 objects \(0 bodied, 0 bodiless\)/);
});

test('cache remaster is WIRED in the bin: an empty hermetic root builds an empty remaster (exit 0)', () => {
  const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-rm-in-'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-rm-out-')), 'remastered');
  const { status, stdout, stderr } = cli('cache', 'remaster', hermetic, out);
  assert.equal(status, EXIT.OK, stderr);
  assert.match(stdout, /0 sidecars/);
  assert.ok(fs.existsSync(path.join(out, 'remaster.build.json')));
});

test('manifest is WIRED in the bin, and IDEMPOTENT end-to-end: --offline reruns are byte-identical', () => {
  // Proves bin/waybackify.js hands `manifest` the real handler over the real
  // library — and demonstrates the issue's acceptance criterion at the shell
  // level: with every url answered by the universe + seen union, --offline
  // (zero network BY CONSTRUCTION) succeeds, and the rerun rewrites both
  // artifacts byte-for-byte.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-cli-'));
  const seenFile = path.join(dir, 'seen.json');
  const outFile = path.join(dir, 'wayback.json');
  fs.copyFileSync(path.join(FIXTURES, 'gen', 'seen.json'), seenFile);
  const argv = [
    'manifest',
    path.join(FIXTURES, 'gen', 'source.md'),
    '-u',
    path.join(FIXTURES, 'gen', 'universe.json'),
    '-s',
    seenFile,
    '-o',
    outFile,
    '--offline'
  ];

  const first = cli(...argv);
  assert.equal(first.status, EXIT.OK, first.stderr);
  const stats = JSON.parse(first.stdout.trim());
  assert.deepEqual(stats, { output: outFile, urls: 3, fromUniverse: 2, fromSeen: 1, resolved: 0, deferred: 0 });
  const manifestBytes = fs.readFileSync(outFile);
  const seenBytes = fs.readFileSync(seenFile);

  const second = cli(...argv);
  assert.equal(second.status, EXIT.OK, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(fs.readFileSync(outFile), manifestBytes, 'manifest is byte-identical across runs');
  assert.deepEqual(fs.readFileSync(seenFile), seenBytes, 'seen union is byte-identical across runs');
});

test('rewrite is WIRED in the bin: the apply fixture publishes byte-exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waybackify-cli-'));
  const outFile = path.join(dir, 'out.md');
  const { status, stdout, stderr } = cli(
    'rewrite',
    path.join(FIXTURES, 'apply', 'source.md'),
    '-m',
    path.join(FIXTURES, 'apply', 'wayback.json'),
    '-o',
    outFile
  );
  assert.equal(status, EXIT.OK, stderr);
  assert.equal(stdout, '');
  assert.equal(
    fs.readFileSync(outFile, 'utf8'),
    fs.readFileSync(path.join(FIXTURES, 'apply', 'expected.md'), 'utf8')
  );
});

test('ledger is WIRED in the bin: the fixture tree surveys to JSONL', () => {
  const { status, stdout } = cli('ledger', path.join(FIXTURES, 'tree'));
  assert.equal(status, EXIT.OK);
  const rows = stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => r.file), ['a/wayback.json', 'b/nested/wayback.json']);
});

test('handlers receive the fully parsed surface (args + flags)', async () => {
  const seen = {};
  const grab = name => payload => {
    seen[name] = { args: payload.args, flags: payload.flags };
  };
  const handlers = Object.fromEntries(HANDLER_KEYS.map(name => [name, grab(name)]));

  assert.equal(
    await run(
      ['manifest', 'src.md', '-u', 'universe.json', '-s', 'seen.json', '-o', 'wayback.json', '--offline'],
      { handlers, error: () => {} }
    ),
    EXIT.OK
  );
  // `<source.md>` parses to args.source — paparam's arg-name derivation stops
  // at the first non-[a-zA-Z0-9-] char (snakeToCamel, index.js:772-778 @1.10.1).
  assert.equal(seen.manifest.args.source, 'src.md');
  assert.equal(seen.manifest.flags.universe, 'universe.json');
  assert.equal(seen.manifest.flags.seen, 'seen.json');
  assert.equal(seen.manifest.flags.output, 'wayback.json');
  assert.equal(seen.manifest.flags.offline, true);

  assert.equal(
    await run(['rewrite', 'src.md', '-m', 'wayback.json', '-o', 'out.md'], { handlers, error: () => {} }),
    EXIT.OK
  );
  assert.equal(seen.rewrite.args.source, 'src.md');
  assert.equal(seen.rewrite.flags.manifest, 'wayback.json');
  assert.equal(seen.rewrite.flags.output, 'out.md');

  assert.equal(await run(['ledger', 'some/dir', '--flatten'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.ledger.args.dir, 'some/dir');
  assert.equal(seen.ledger.flags.flatten, true);
  assert.equal(await run(['ledger', 'some/dir', '--against', '/tmp/root'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.ledger.flags.against, '/tmp/root');

  assert.equal(await run(['check', WB], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.check.args.waybackUrl, WB);

  assert.equal(
    await run(['search', 'http://example.com/', '--near', '20140403040000', '--limit', '5'], { handlers, error: () => {} }),
    EXIT.OK
  );
  assert.equal(seen.search.args.originalUrl, 'http://example.com/');
  assert.equal(seen.search.flags.near, '20140403040000');
  assert.equal(seen.search.flags.limit, '5');

  // cache add — nested verb; -o is the deprecated alias, requisites-by-default.
  assert.equal(await run(['cache', 'add', WB, '-o', '/tmp/cr'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cacheAdd.args.waybackUrl, WB);
  assert.equal(seen.cacheAdd.flags.output, '/tmp/cr');
  // Requisites-by-default (the cache add command's semantics, pinned at the
  // surface): paparam registers `--no-requisites` under the name `requisites`
  // with default true (parseFlag inversion, index.js:793-799 @1.10.1).
  assert.equal(seen.cacheAdd.flags.requisites, true);
  assert.equal(await run(['cache', 'add', WB, '-o', '/tmp/cr', '--no-requisites'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cacheAdd.flags.requisites, false);

  // cache fill — the whole-ledger form (was `backfill`).
  assert.equal(
    await run(['cache', 'fill', 'words', '-r', '/c', '--delay-ms', '250', '--max', '10', '--refresh', '--dry-run'], { handlers, error: () => {} }),
    EXIT.OK
  );
  assert.equal(seen.cacheFill.args.dir, 'words');
  assert.equal(seen.cacheFill.flags.root, '/c');
  assert.equal(seen.cacheFill.flags.delayMs, '250');
  assert.equal(seen.cacheFill.flags.max, '10');
  assert.equal(seen.cacheFill.flags.refresh, true);
  assert.equal(seen.cacheFill.flags.dryRun, true);

  // cache verify — flag-only.
  assert.equal(await run(['cache', 'verify', '-r', '/c', '--fix', '--json', '--quiet'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cacheVerify.flags.root, '/c');
  assert.equal(seen.cacheVerify.flags.fix, true);
  assert.equal(seen.cacheVerify.flags.json, true);
  assert.equal(seen.cacheVerify.flags.quiet, true);

  // cache remaster — two positional roots (snakeToCamel over the hyphens).
  assert.equal(await run(['cache', 'remaster', '/h', '/o', '--json'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cacheRemaster.args.hermeticRoot, '/h');
  assert.equal(seen.cacheRemaster.args.remasteredRoot, '/o');
  assert.equal(seen.cacheRemaster.flags.json, true);

  // cache sync — --root + --bucket required, --empty-file / --dry-run optional.
  assert.equal(await run(['cache', 'sync', '-r', '/c', '--bucket', 'b', '--empty-file', '/tmp/e', '--dry-run'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cacheSync.flags.root, '/c');
  assert.equal(seen.cacheSync.flags.bucket, 'b');
  assert.equal(seen.cacheSync.flags.emptyFile, '/tmp/e');
  assert.equal(seen.cacheSync.flags.dryRun, true);
});

test('run() maps handler outcomes to the documented exit codes', async () => {
  const silent = { error: () => {} };
  // Domain failure: a handler throw that is neither usage nor scaffold → 1.
  assert.equal(
    await run(['check', WB], { handlers: { check: () => { throw new Error('bad verdict'); } }, ...silent }),
    EXIT.DOMAIN
  );
  // Scaffold: NotImplementedError → 70, whichever handler throws it.
  assert.equal(
    await run(['check', WB], { handlers: { check: () => { throw new NotImplementedError('check'); } }, ...silent }),
    EXIT.NOT_IMPLEMENTED
  );
  // Success → 0.
  assert.equal(await run(['check', WB], { handlers: { check: () => {} }, ...silent }), EXIT.OK);
});

test('thin-CLI rule: the parsing layer imports nothing from spv/waybackify', () => {
  // The library is reached ONLY through src/commands/* wiring modules. The
  // argv surface (src/cli.js) and the bin stay library-free so --help and
  // usage errors never load fetch machinery.
  const src = fs.readFileSync(path.join(PKG, 'src', 'cli.js'), 'utf8');
  const bin = fs.readFileSync(BIN, 'utf8');
  for (const code of [src, bin]) {
    assert.doesNotMatch(code, /import\s*\(?\s*['"][^'"]*\/waybackify\//);
    assert.doesNotMatch(code, /from\s+['"][^'"]*\/waybackify\//);
    assert.doesNotMatch(code, /from\s+['"](@charlie\.dev\/)?waybackify['"]/);
  }
});
