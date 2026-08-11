// The stdout-is-data invariant (design §7 / §9): `bucket push` pipes its s5cmd
// batch on STDOUT (`… | s5cmd run`), so a logger line on stdout would be piped
// as a command. The logger's human stream is stderr (fd 2), ALWAYS — this test
// spawns the real bin with silent-loop progress ON (--progress-every 1) and
// proves the aggregate progress lands on stderr, never contaminating stdout.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitEntry } from '@autocache/waybackify/cache.js';
import { captureKey } from '@autocache/waybackify/key.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'waybackify.js');

test('bucket push — stdout is PURE batch; progress rides stderr (--progress-every 1)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bucket-'));
  // Three bodied entries → three batch lines, and (at N=1) three progress ticks.
  for (const n of [1, 2, 3]) {
    const key = captureKey('2005051007522' + n, `http://aa.com/asset${n}.gif`);
    await commitEntry(root, { key, status: 'body', contentType: 'image/gif', flag: null, requisites: [], body: new Uint8Array([n, n, n]) });
  }

  const r = spawnSync(process.execPath, [BIN, 'bucket', 'push', '-r', root, '--bucket', 'b', '--progress-every', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  const stdoutLines = r.stdout.split('\n').filter(Boolean);
  // Every stdout line is an s5cmd batch line (`cp …`) — NOTHING else.
  assert.ok(stdoutLines.length >= 3, `expected ≥3 batch lines, got ${stdoutLines.length}`);
  for (const line of stdoutLines) {
    assert.ok(line.startsWith('cp '), `stdout line is not a batch cp line: ${JSON.stringify(line)}`);
  }
  // The logger NEVER touched stdout: no NDJSON record leaked onto the pipe.
  assert.ok(!r.stdout.includes('"evt"'), 'a logger record leaked onto stdout (the s5cmd pipe)');
  assert.ok(!r.stdout.includes('bucket-progress'), 'progress leaked onto stdout');

  // The silent-loop progress DID emit — on stderr (raw NDJSON when piped).
  assert.ok(r.stderr.includes('"evt":"bucket-progress"'), 'expected bucket-progress records on stderr');

  fs.rmSync(root, { recursive: true, force: true });
});
