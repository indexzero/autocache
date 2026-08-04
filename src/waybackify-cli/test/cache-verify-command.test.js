// `waybackify cache verify` handler — thin-wrapper wiring test. The store fsck
// (spv/waybackify/fsck.js) is covered by its own unit + fixture suite; here we
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
  const handler = cacheVerifyHandler({
    fsck: async (root, options) => { calls.push({ root, options }); return report; },
    CATEGORIES,
    totalFindings,
    unresolvedFindings
  });
  return { handler, calls, out };
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
