// LIVE cache-population tests — real replay fetches against archive.org.
// Skipped by default (the PR gate stays offline); run with
// WAYBACK_LIVE=1 pnpm test (or pnpm run test:live). Best-effort by design:
// archive.org throttles, so this pins the invariants (verbatim bytes,
// sidecar completion, second-run no-op) on ONE small, corpus-real capture.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheCapture, entryPaths, readSidecar } from '../cache.js';

const skip = !process.env.WAYBACK_LIVE && 'live network — set WAYBACK_LIVE=1 to run';

describe('cacheCapture (live)', { skip }, () => {
  it('caches a real capture, then no-ops on the second run', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'waybackify-cache-live-'));
    // Small, stable, corpus-adjacent capture (same one the live audit uses).
    const url = 'https://web.archive.org/web/20130607080910/http://findluk.com/';

    const first = await cacheCapture(url, { root });
    assert.ok(first.fetched >= 1);
    const side = await readSidecar(root, first.key);
    assert.equal(side.v, 1);
    assert.equal(side.key, first.key);
    if (side.status === 'body') {
      const { body } = await entryPaths(root, first.key);
      const bytes = await fsp.readFile(body);
      assert.equal(bytes.byteLength, side.contentLength);
    }

    const second = await cacheCapture(url, { root });
    assert.equal(second.fetched, 0, 'second run is a fetch-free no-op');
    assert.ok(second.skipped >= 1);
  });
});
