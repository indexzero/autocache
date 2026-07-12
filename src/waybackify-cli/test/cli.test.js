// waybackify CLI scaffold tests (#266) — offline, zero network.
//
// Three layers, per the issue's verification list:
//   1. Help snapshots — root + per-command help pinned byte-for-byte against
//      test/fixtures/help/*.txt (regenerate deliberately with
//      `node test/regen-help-fixtures.js` when the surface changes).
//   2. Strict-flag / usage rejection — unknown flags and missing required
//      args/flags exit 2 (paparam is strict by default; pinned here so a
//      paparam upgrade that loosens parsing fails loudly).
//   3. Not-implemented contract — every command parses its full flag surface,
//      hands the parsed payload to its handler, and the scaffold handlers
//      exit 70.
//
// Layer 2/3 exit codes go through the REAL bin (child_process.spawnSync on
// bin/waybackify.js) so the test observes what a shell observes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCLI, EXIT, NotImplementedError, run } from '../src/cli.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG, 'bin', 'waybackify.js');
const fixture = name => fs.readFileSync(path.join(PKG, 'test', 'fixtures', 'help', `${name}.txt`), 'utf8');

/** Run the real bin. Returns { status, stdout, stderr }. */
function cli(...argv) {
  const r = spawnSync(process.execPath, [BIN, ...argv], { encoding: 'utf8' });
  assert.equal(r.error, undefined);
  return r;
}

const WB = 'https://web.archive.org/web/20140403040000/http://example.com/';

// ---------------------------------------------------------------------------
// 1. Help snapshots
// ---------------------------------------------------------------------------

test('root --help lists all four commands with one-line descriptions (snapshot)', () => {
  const { status, stdout, stderr } = cli('--help');
  assert.equal(status, EXIT.OK);
  assert.equal(stderr, '');
  // paparam prints help via console.log, which appends one newline to the
  // help() string (verified: index.js:248 @1.10.1).
  assert.equal(stdout, `${fixture('root')}\n`);
  for (const line of [
    /check\s+Full wayback-404 verdict for the exact capture/,
    /search\s+CDX capture query — re-pick a better capture/,
    /manifest\s+Per-file enumeration of wayback refs/,
    /cache\s+Fetch the capture into a local bucket image/
  ]) {
    assert.match(stdout, line);
  }
});

for (const name of ['check', 'search', 'manifest', 'cache']) {
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

// ---------------------------------------------------------------------------
// 2. Strict parsing → usage errors (exit 2)
// ---------------------------------------------------------------------------

test('unknown flags are rejected on every command (paparam strict mode)', () => {
  for (const argv of [
    ['check', '--nope', WB],
    ['search', '--nope', 'http://example.com/'],
    ['manifest', '--nope', 'index.md'],
    ['cache', '--nope', '-o', '/tmp/x', WB]
  ]) {
    const { status, stderr } = cli(...argv);
    assert.equal(status, EXIT.USAGE, `argv: ${argv.join(' ')}`);
    assert.match(stderr, /UNKNOWN_FLAG: nope/);
  }
});

test('missing required positional exits 2 with the validator message', () => {
  for (const [name, argName] of [
    ['check', '<wayback-url>'],
    ['search', '<original-url>'],
    ['manifest', '<file.md>'],
    ['cache', '<wayback-url>']
  ]) {
    const args = name === 'cache' ? [name, '-o', '/tmp/x'] : [name];
    const { status, stderr } = cli(...args);
    assert.equal(status, EXIT.USAGE, `command: ${name}`);
    assert.match(stderr, new RegExp(`missing required argument: ${argName.replace(/[<>.]/g, '\\$&')}`));
  }
});

test('cache without --output|-o exits 2', () => {
  const { status, stderr } = cli('cache', WB);
  assert.equal(status, EXIT.USAGE);
  assert.match(stderr, /missing required flag: --output\|-o <root>/);
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

test('bare invocation prints root help to stderr and exits 2', () => {
  const { status, stdout, stderr } = cli();
  assert.equal(status, EXIT.USAGE);
  assert.equal(stdout, '');
  assert.match(stderr, /Commands:/);
});

// ---------------------------------------------------------------------------
// 3. Not-implemented contract (exit 70) + full flag-surface parsing
// ---------------------------------------------------------------------------

test('every command with valid usage exits 70 (not implemented)', () => {
  for (const argv of [
    ['check', WB],
    ['search', 'http://example.com/'],
    ['search', 'http://example.com/', '--near', '20140403', '--limit', '5'],
    ['manifest', 'words/1/001/index.md'],
    ['manifest', 'words/1/001/index.md', '--ledger'],
    ['cache', WB, '-o', '/tmp/cache-root'],
    ['cache', WB, '--output', '/tmp/cache-root', '--no-requisites']
  ]) {
    const { status, stderr } = cli(...argv);
    assert.equal(status, EXIT.NOT_IMPLEMENTED, `argv: ${argv.join(' ')}`);
    assert.match(stderr, /not implemented/);
  }
});

test('handlers receive the fully parsed surface (args + flags)', async () => {
  const seen = {};
  const grab = name => payload => {
    seen[name] = { args: payload.args, flags: payload.flags };
  };
  const handlers = { check: grab('check'), search: grab('search'), manifest: grab('manifest'), cache: grab('cache') };

  assert.equal(await run(['check', WB], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.check.args.waybackUrl, WB);

  assert.equal(
    await run(['search', 'http://example.com/', '--near', '20140403040000', '--limit', '5'], { handlers, error: () => {} }),
    EXIT.OK
  );
  assert.equal(seen.search.args.originalUrl, 'http://example.com/');
  assert.equal(seen.search.flags.near, '20140403040000');
  assert.equal(seen.search.flags.limit, '5');

  assert.equal(await run(['manifest', 'index.md', '--ledger'], { handlers, error: () => {} }), EXIT.OK);
  // `<file.md>` parses to args.file — paparam's arg-name derivation stops at
  // the first non-[a-zA-Z0-9-] char (snakeToCamel, index.js:772-778 @1.10.1).
  assert.equal(seen.manifest.args.file, 'index.md');
  assert.equal(seen.manifest.flags.ledger, true);

  assert.equal(await run(['cache', WB, '-o', '/tmp/cr'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cache.args.waybackUrl, WB);
  assert.equal(seen.cache.flags.output, '/tmp/cr');
  // Requisites-by-default (#267 semantics, pinned at the surface now):
  // paparam registers `--no-requisites` under the name `requisites` with
  // default true (parseFlag inversion, index.js:793-799 @1.10.1).
  assert.equal(seen.cache.flags.requisites, true);

  assert.equal(await run(['cache', WB, '-o', '/tmp/cr', '--no-requisites'], { handlers, error: () => {} }), EXIT.OK);
  assert.equal(seen.cache.flags.requisites, false);
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

test('thin-CLI rule: the package imports nothing from spv/waybackify yet', () => {
  const src = fs.readFileSync(path.join(PKG, 'src', 'cli.js'), 'utf8');
  const bin = fs.readFileSync(BIN, 'utf8');
  for (const code of [src, bin]) {
    assert.doesNotMatch(code, /from\s+['"](?:\.\.\/)*\.\.\/waybackify\//);
    assert.doesNotMatch(code, /from\s+['"]waybackify['"]/);
  }
});
