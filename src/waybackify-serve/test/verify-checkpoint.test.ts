/**
 * The verify checkpoint file: one JSON file per bucket target under
 * `<root>/.verify/`, written atomically, read back exactly, and removed after a
 * passing run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkpointPath,
  checkpointTarget,
  readCheckpoint,
  removeCheckpoint,
  VERIFY_DIR,
  writeCheckpoint,
  type VerifyCheckpoint
} from '../src/verify-checkpoint.ts';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-verify-checkpoint-'));
}

const TARGET = { endpoint: 'https://acct.r2.example/', bucket: 'captures', prefix: '/orig/' };

function sample(): VerifyCheckpoint {
  return {
    signature: 'sha256-abc',
    target: checkpointTarget(TARGET),
    sample: 3,
    passed: [{ layer: 1, name: 'count parity (per prefix)', pass: true, checked: 14, mismatches: [], counts: { entries: 7, cap: 7, meta: 7 } }],
    bodies: { verified: ['cap/aa/1', 'cap/bb/2'], healed: ['cap/bb/2'] }
  };
}

describe('verify checkpoint — location', () => {
  it('normalizes the target: no trailing endpoint slash, a slash-trimmed prefix', () => {
    assert.deepEqual(checkpointTarget(TARGET), { endpoint: 'https://acct.r2.example', bucket: 'captures', prefix: 'orig' });
    assert.deepEqual(checkpointTarget({ endpoint: 'https://acct.r2.example', bucket: 'captures' }), { endpoint: 'https://acct.r2.example', bucket: 'captures', prefix: '' });
  });

  it('lives under <root>/.verify/ and names the endpoint, bucket, and prefix', () => {
    const file = checkpointPath('/cache', TARGET);
    assert.equal(path.dirname(file), path.join('/cache', VERIFY_DIR));
    assert.equal(VERIFY_DIR, '.verify');
    assert.match(path.basename(file), /^acct\.r2\.example-captures-orig\.[0-9a-f]{12}\.json$/);
  });

  it('gives the naked tier and the orig/ tier separate files', () => {
    const naked = checkpointPath('/cache', { ...TARGET, prefix: undefined });
    const orig = checkpointPath('/cache', TARGET);
    assert.notEqual(naked, orig);
  });

  it('gives two targets whose readable names collide separate files', () => {
    assert.notEqual(
      checkpointPath('/cache', { ...TARGET, prefix: 'a/b' }),
      checkpointPath('/cache', { ...TARGET, prefix: 'a_b' })
    );
  });
});

describe('verify checkpoint — read, write, remove', () => {
  it('round-trips a checkpoint and leaves no temporary file', async () => {
    const root = tempRoot();
    const file = checkpointPath(root, TARGET);
    await writeCheckpoint(file, sample());
    assert.deepEqual(await readCheckpoint(file), sample());
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  });

  it('reads an absent checkpoint as undefined', async () => {
    assert.equal(await readCheckpoint(checkpointPath(tempRoot(), TARGET)), undefined);
  });

  it('rejects a file that is not a checkpoint, and names the file', async () => {
    const root = tempRoot();
    const file = checkpointPath(root, TARGET);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ signature: 'x' }));
    await assert.rejects(readCheckpoint(file), new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not a verify checkpoint`));
  });

  it('removes a checkpoint, and removing an absent one is a no-op', async () => {
    const root = tempRoot();
    const file = checkpointPath(root, TARGET);
    await writeCheckpoint(file, sample());
    await removeCheckpoint(file);
    assert.equal(fs.existsSync(file), false);
    await removeCheckpoint(file);
  });
});
