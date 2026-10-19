// `waybackify cache verify` handler — thin-wrapper wiring test. The store fsck
// (src/waybackify/fsck.js) is covered by its own unit + fixture suite. Here we
// prove the handler maps argv → fsck() options, formats the report on stdout
// (--json for the raw record), and maps an unresolved store to domain exit 1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.js';
import { cacheVerifyHandler } from '../src/commands/cache-verify.js';

// A minimal stand-in for the library's fsck surface — enough categories to
// exercise the three severities the report prints (corruption/incomplete/
// reapable) without loading the fetch stack fsck.js pulls in.
const CATEGORIES = [
  { key: 'hashMismatch', label: 'contentHash != stored body bytes', severity: 'corruption' },
  { key: 'incompleteClosure', label: "status 'body' requisite whose sidecar is absent (closure short)", severity: 'incomplete' },
  { key: 'orphanCap', label: 'cap/ file with no sidecar', severity: 'reapable' }
];
const totalFindings = r => CATEGORIES.reduce((n, c) => n + r.findings[c.key].length, 0);
const unresolvedFindings = r => {
  const reaped = r.reaped ? r.reaped.orphanCap.length + r.reaped.staleTmp.length : 0;
  return totalFindings(r) - reaped;
};
const reportOf = (findings = {}, reaped = null) => ({
  root: '/c',
  schemaVersion: 2,
  counts: { sidecars: 1, bodies: 1, capFiles: 1, tmpFiles: 0 },
  findings: Object.fromEntries(CATEGORIES.map(c => [c.key, findings[c.key] ?? []])),
  reaped
});

/** Wire the handler with an injected fsck; capture its call + stdout. */
function handlerFor(report) {
  const calls = [];
  const out = [];
  const emptied = [];
  const restores = [];
  const order = [];
  const handler = cacheVerifyHandler({
    fsck: async (root, options) => { calls.push({ root, options }); order.push('fsck'); return report; },
    emptyTrash: async (root, options) => {
      emptied.push({ root, options });
      order.push('emptyTrash');
      return { path: `${root}/trash`, files: 2, bytes: 10, kept: [{ path: `${root}/trash/run-0/cap/ab/h9`, reason: 'a current sidecar names this body; restore the run instead' }] };
    },
    restoreTrash: async (root, run) => {
      restores.push({ root, run });
      return {
        run: `${root}/trash/${run}`,
        restored: [{ from: `${root}/trash/${run}/cap/ab/h1`, to: `${root}/cap/ab/h1` }],
        skipped: [{ from: `${root}/trash/${run}/cap/cd/h2`, to: `${root}/cap/cd/h2`, reason: 'a live body exists at that path' }]
      };
    },
    CATEGORIES,
    totalFindings,
    unresolvedFindings
  });
  return { handler, calls, out, emptied, restores, order };
}

/** A logger that records every line, info and warn alike. */
function recordingLogger(lines) {
  const push = (o, m) => lines.push(typeof o === 'string' ? o : m);
  return { trace: push, debug: push, info: push, warn: push, error: push, fatal: push, child() { return this; } };
}

test('a clean store: fsck(root,{fix:false}), human report on stdout, exit 0', async () => {
  const { handler, calls, out } = handlerFor(reportOf());
  assert.equal(await run(['cache', 'verify', '-r', '/c'], { handlers: { cacheVerify: handler }, out: l => out.push(l), error: () => {} }), EXIT.OK);
  // run() threads a logger + the silent-loop progress throttle into the payload,
  // and the handler passes them to fsck (§4/§6) alongside the mapped flags.
  assert.equal(calls[0].root, '/c');
  assert.equal(calls[0].options.fix, false);
  assert.equal(calls[0].options.progressEvery, 500);
  assert.ok(calls[0].options.logger, 'logger threaded into fsck');
  assert.ok(out.some(l => l.startsWith('fsck /c')));
  assert.ok(out.some(l => l.includes('clean')));
});

test('--json emits the raw report; still exit 0 when clean', async () => {
  const report = reportOf();
  const { handler, out } = handlerFor(report);
  assert.equal(await run(['cache', 'verify', '-r', '/c', '--json'], { handlers: { cacheVerify: handler }, out: l => out.push(l), error: () => {} }), EXIT.OK);
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), report);
});

test('an unresolved store (short closure) exits 1 (domain), report printed with SHORT', async () => {
  const report = reportOf({ incompleteClosure: [{ aa: 'ab', hash: 'h', key: 'k', child: 'k/im_/x.png' }] });
  const { handler, out } = handlerFor(report);
  assert.equal(await run(['cache', 'verify', '-r', '/c'], { handlers: { cacheVerify: handler }, out: l => out.push(l), error: () => {} }), EXIT.DOMAIN);
  assert.ok(out.some(l => l.includes('SHORT')), 'the incomplete severity prints a SHORT tag');
});

test('corruption exits 1 (domain) and prints a FAIL tag', async () => {
  const report = reportOf({ hashMismatch: [{ aa: 'ab', hash: 'h', key: 'k', expected: 'sha256-a', actual: 'sha256-b' }] });
  const { handler, out } = handlerFor(report);
  assert.equal(await run(['cache', 'verify', '-r', '/c'], { handlers: { cacheVerify: handler }, out: l => out.push(l), error: () => {} }), EXIT.DOMAIN);
  assert.ok(out.some(l => l.includes('FAIL')));
});

test('--fix is passed through to fsck; a fully reaped store exits 0', async () => {
  const report = reportOf(
    { orphanCap: [{ aa: 'ab', hash: 'h', path: '/c/cap/ab/h' }] },
    { orphanCap: ['/c/cap/ab/h'], staleTmp: [] }
  );
  const { handler, calls, out } = handlerFor(report);
  assert.equal(await run(['cache', 'verify', '-r', '/c', '--fix'], { handlers: { cacheVerify: handler }, out: l => out.push(l), error: () => {} }), EXIT.OK);
  assert.equal(calls[0].options.fix, true);
  assert.equal(calls[0].options.progressEvery, 500);
});

test('--fix output names the quarantine directory the orphans moved to', async () => {
  const report = reportOf(
    { orphanCap: [{ aa: 'ab', hash: 'h', path: '/c/cap/ab/h' }] },
    { orphanCap: ['/c/cap/ab/h'], staleTmp: [], trash: '/c/trash/run-1', moves: [{ from: '/c/cap/ab/h', to: '/c/trash/run-1/cap/ab/h' }] }
  );
  const { handler, out } = handlerFor(report);
  assert.equal(await run(['cache', 'verify', '-r', '/c', '--fix'], { handlers: { cacheVerify: handler }, out: l => out.push(l), error: () => {} }), EXIT.OK);
  assert.ok(out.some(l => l.includes('moved ') && l.includes('cap/ file with no sidecar')), 'the orphan row is tagged moved');
  assert.ok(out.some(l => l.includes('1 orphan cap/ file(s) moved to /c/trash/run-1')), 'the summary names the quarantine');
});

test('--empty-trash runs AFTER the verify report, keeps this run\'s moves, and reports every kept body', async () => {
  const report = reportOf(
    { orphanCap: [{ aa: 'ab', hash: 'h', path: '/c/cap/ab/h' }] },
    { orphanCap: ['/c/cap/ab/h'], staleTmp: [], trash: '/c/trash/run-1', moves: [{ from: '/c/cap/ab/h', to: '/c/trash/run-1/cap/ab/h' }], skipped: [] }
  );
  const { handler, calls, out, emptied, order } = handlerFor(report);
  const logs = [];
  assert.equal(
    await run(['cache', 'verify', '-r', '/c', '--fix', '--empty-trash'], { handlers: { cacheVerify: handler }, out: l => out.push(l), logger: recordingLogger(logs), error: () => {} }),
    EXIT.OK
  );
  assert.deepEqual(order, ['fsck', 'emptyTrash'], 'the verify runs first');
  assert.deepEqual(emptied, [{ root: '/c', options: { keepRun: '/c/trash/run-1' } }], 'this run\'s quarantine directory is kept');
  assert.equal(calls.length, 1);
  assert.ok(out.some(l => l.includes('moved to /c/trash/run-1')), 'the report is printed before the deletion');
  assert.ok(logs.some(l => l === 'cache verify: kept /c/trash/run-0/cap/ab/h9 (a current sidecar names this body; restore the run instead)'));
  assert.ok(logs.some(l => l.includes('emptied /c/trash (2 file(s), 10 bytes deleted, 1 kept)')));
});

test('without --empty-trash the quarantine is never touched', async () => {
  const { handler, emptied } = handlerFor(reportOf());
  await run(['cache', 'verify', '-r', '/c', '--fix'], { handlers: { cacheVerify: handler }, out: () => {}, error: () => {} });
  assert.deepEqual(emptied, []);
});

test('--restore <run> runs the restore before the verify and reports each restored and skipped body', async () => {
  const { handler, calls, out, restores } = handlerFor(reportOf());
  const logs = [];
  assert.equal(
    await run(['cache', 'verify', '-r', '/c', '--restore', 'run-1'], { handlers: { cacheVerify: handler }, out: l => out.push(l), logger: recordingLogger(logs), error: () => {} }),
    EXIT.OK
  );
  assert.deepEqual(restores, [{ root: '/c', run: 'run-1' }]);
  assert.equal(calls.length, 1, 'the verify still runs');
  assert.ok(logs.some(l => l === 'cache verify: restored /c/cap/ab/h1'));
  assert.ok(logs.some(l => l === 'cache verify: kept /c/trash/run-1/cap/cd/h2 in quarantine (a live body exists at that path)'));
  assert.ok(logs.some(l => l.includes('restore of /c/trash/run-1: 1 restored, 1 skipped')));
});

test('without --restore the quarantine is never restored', async () => {
  const { handler, restores } = handlerFor(reportOf());
  await run(['cache', 'verify', '-r', '/c'], { handlers: { cacheVerify: handler }, out: () => {}, error: () => {} });
  assert.deepEqual(restores, []);
});
