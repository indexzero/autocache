// `waybackify check` wiring tests — offline, library injected.
//
// The verdict ENGINE (CDX statuscode signal, chrome stripping, soft-404
// heuristics, the good/wayback404/suspect classification) is tested where it
// lives: spv/waybackify/test/audit.test.js. This file pins the thin-wrapper
// contract only: argv payload → auditCapture(url), the verdict object printed
// to stdout VERBATIM (one JSON line, nothing else), and the exit-code mapping
//   good → 0 · wayback404 → 1 · suspect → 3 · missing arg → 2.
//
// suspect is nonzero ON PURPOSE (conservative composition — `manifest | xargs
// check` must not silently pass junk).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, run } from '../src/cli.js';
import { checkHandler } from '../src/commands/check.js';

const WB = 'https://web.archive.org/web/20081221144742/http://blogs.example.com:80/post.aspx';

// A verdict shaped exactly like auditCapture's return (index-order preserved so
// the "printed verbatim" assertion is meaningful).
const verdictOf = over => ({
  verdict: 'good',
  statuscode: '200',
  reason: 'content heuristics clean',
  evidence: 'title: A Real Post | text: lorem ipsum dolor sit amet …',
  url: WB,
  timestamp: '20081221144742',
  original: 'http://blogs.example.com:80/post.aspx',
  checkedAt: '2020-01-01T00:00:00.000Z',
  ...over
});

/** Injected handler over a canned verdict. Output seams are run()-wired now. */
const harness = verdict => {
  const seen = {};
  const handler = checkHandler({
    auditCapture: async url => {
      seen.url = url;
      return verdict;
    }
  });
  return { handler, seen };
};

const exitFor = async (verdict, extraArgv = []) => {
  const { handler, seen } = harness(verdict);
  const out = []; // stdout result sink, injected at run()
  const err = []; // run()'s bail/usage stderr sink
  const code = await run(['check', WB, ...extraArgv], {
    handlers: { check: handler },
    out: l => out.push(l),
    error: l => err.push(l)
  });
  return { code, out, err, seen };
};

// ---------------------------------------------------------------------------
// Exit-code mapping — one canned verdict per class, each code pinned.
// ---------------------------------------------------------------------------

test('good verdict → exit 0, verdict JSON on stdout, url passed through', async () => {
  const { code, out, seen } = await exitFor(verdictOf({ verdict: 'good' }));
  assert.equal(code, EXIT.OK);
  assert.equal(seen.url, WB);
  assert.equal(out.length, 1, 'exactly one stdout line');
});

test('wayback404 verdict → exit 1 (a bad verdict is a domain failure)', async () => {
  const { code, out } = await exitFor(verdictOf({ verdict: 'wayback404', reason: 'soft-404 body marker' }));
  assert.equal(code, EXIT.DOMAIN);
  assert.equal(out.length, 1, 'verdict still printed before the nonzero exit');
});

test('suspect verdict → exit 3 (nonzero ON PURPOSE — distinct from 1)', async () => {
  const { code, out } = await exitFor(verdictOf({ verdict: 'suspect', reason: 'near-empty body' }));
  assert.equal(code, EXIT.SUSPECT);
  assert.equal(code, 3);
  assert.notEqual(code, EXIT.DOMAIN);
  assert.equal(out.length, 1, 'verdict still printed before the nonzero exit');
});

test('missing <wayback-url> → usage exit 2, handler never runs', async () => {
  const { handler, seen } = harness(verdictOf({}));
  const out = [];
  const code = await run(['check'], { handlers: { check: handler }, out: l => out.push(l), error: () => {} });
  assert.equal(code, EXIT.USAGE);
  assert.equal(out.length, 0, 'nothing on stdout for a usage error');
  assert.equal(seen.url, undefined, 'auditCapture not called');
});

test('library throws (not a wayback replay URL) → domain exit 1', async () => {
  const handler = checkHandler({
    auditCapture: async () => {
      throw new TypeError('auditCapture: not a wayback replay URL: nope');
    }
  });
  assert.equal(await run(['check', WB], { handlers: { check: handler }, error: () => {} }), EXIT.DOMAIN);
});

// ---------------------------------------------------------------------------
// Verbatim contract — stdout is the library object unmodified, nothing else.
// ---------------------------------------------------------------------------

test('prints the library verdict object VERBATIM (no reshaping) and nothing else', async () => {
  const verdict = verdictOf({ verdict: 'wayback404', statuscode: '404', reason: 'capture archived as HTTP 404' });
  const { out, err } = await exitFor(verdict);
  assert.equal(out.length, 1, 'exactly one stdout line');
  assert.deepEqual(JSON.parse(out[0]), verdict, 'stdout is the library object, key-for-key');
  // Diagnostics (the throw message for the nonzero verdict) go to stderr only.
  assert.ok(!out.some(l => l.includes('wayback404 —')), 'no diagnostics on stdout');
  assert.ok(err.length > 0, 'nonzero verdict logs a diagnostic to stderr');
});

// ---------------------------------------------------------------------------
// Composability proof — stdout pipes through `jq -r .verdict` cleanly.
// ---------------------------------------------------------------------------

const jqSkip = spawnSync('jq', ['--version'], { encoding: 'utf8' }).error && 'jq not installed';

test('check output pipes through `jq -r .verdict`', { skip: jqSkip }, async () => {
  const { out } = await exitFor(verdictOf({ verdict: 'suspect' }));
  const jq = spawnSync('jq', ['-r', '.verdict'], { input: out[0], encoding: 'utf8' });
  assert.equal(jq.status, 0, 'jq parsed the stdout line');
  assert.equal(jq.stdout.trim(), 'suspect');
});

// ---------------------------------------------------------------------------
// Live smoke — real bin, real archive.org. Skipped unless WAYBACK_LIVE=1.
// ---------------------------------------------------------------------------

const liveSkip = !process.env.WAYBACK_LIVE && 'live network — set WAYBACK_LIVE=1 to run';
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'waybackify.js');
// A real archived capture (also exercised by the library's live audit tests).
const LIVE_WB =
  'https://web.archive.org/web/20081221144742/http://blogs.msdn.com:80/mharsh/archive/2008/03/05/slides-and-demos-from-my-mix-08-talk.aspx';

test('live: real bin verdicts a known-good capture, stdout is JSON, exit matches verdict', { skip: liveSkip }, () => {
  const r = spawnSync(process.execPath, [BIN, 'check', LIVE_WB], { encoding: 'utf8' });
  assert.equal(r.error, undefined);
  const verdict = JSON.parse(r.stdout.trim());
  assert.ok(['good', 'wayback404', 'suspect'].includes(verdict.verdict), `unexpected verdict: ${verdict.verdict}`);
  assert.equal(verdict.timestamp, '20081221144742');
  assert.ok(verdict.reason.length > 0);
  const expected = { good: EXIT.OK, wayback404: EXIT.DOMAIN, suspect: EXIT.SUSPECT }[verdict.verdict];
  assert.equal(r.status, expected, `exit code should match the ${verdict.verdict} verdict`);
});
