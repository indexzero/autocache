// Read-only set comparison of two quiescent, fsck-clean cache roots.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { entryPaths, readSidecar } from './cache.js';
import { CATEGORIES, fsck, totalFindings } from './fsck.js';

/** The fixed conflict projection. Missing optional fields are explicit nulls. */
function identity(sidecar) {
  return {
    v: sidecar.v,
    key: sidecar.key,
    status: sidecar.status,
    contentHash: sidecar.contentHash ?? null,
    contentLength: sidecar.contentLength ?? null,
    contentType: sidecar.contentType ?? null,
    flag: sidecar.flag ?? null,
    fetchedAt: sidecar.fetchedAt ?? null,
    signature: sidecar.signature ?? null,
    target: sidecar.target ?? null
  };
}

async function inventory(root, label) {
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error(`compareRoots: ${label} root is not a directory: ${root}`);

  // fsck already parses the whole store. Its visitor supplies identities so
  // this consumer needs no separate parser or directory-layout walker.
  const entries = [];
  const report = await fsck(root, { fix: false, onSidecar: entry => { entries.push(entry); } });
  if (totalFindings(report) > 0) {
    const categories = CATEGORIES.filter(c => report.findings[c.key].length > 0).map(c => c.key);
    throw new Error(`compareRoots: ${label} root failed fsck (${categories.join(', ')}): ${root}`);
  }

  const records = new Map();
  for (const { key, path: file } of entries) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`compareRoots: ${label} sidecar has no string key: ${file}`);
    }
    const { meta } = await entryPaths(root, key);
    if (path.resolve(meta) !== path.resolve(file)) {
      throw new Error(`compareRoots: ${label} sidecar is misplaced: ${file}`);
    }
    const sidecar = await readSidecar(root, key);
    if (sidecar === null) throw new Error(`compareRoots: ${label} sidecar vanished: ${file}`);
    records.set(key, identity(sidecar));
  }
  return records;
}

/**
 * Compare two existing cache roots without changing either root.
 * Both roots must remain quiescent and pass fsck without fixes. Any finding
 * or read error rejects the call. Equal body hashes or equal bodiless
 * statuses agree. No other metadata affects agreement. See docs/COMPARE.md.
 *
 * @param {string} baseRoot - original cache directory
 * @param {string} fetchRoot - second cache directory
 * @returns {Promise<{
 *   counts: { newOnly: number, oldOnly: number, bothAgreeing: number, bothConflicting: number },
 *   conflicts: Array<{ key: string, base: object, fetch: object }>
 * }>}
 */
export async function compareRoots(baseRoot, fetchRoot) {
  const base = await inventory(baseRoot, 'base');
  const fetch = await inventory(fetchRoot, 'fetch');
  const counts = { newOnly: 0, oldOnly: 0, bothAgreeing: 0, bothConflicting: 0 };
  const conflicts = [];

  for (const key of [...new Set([...base.keys(), ...fetch.keys()])].sort()) {
    const oldEntry = base.get(key);
    const newEntry = fetch.get(key);
    if (!oldEntry) counts.newOnly++;
    else if (!newEntry) counts.oldOnly++;
    else if (oldEntry.status === newEntry.status &&
      (oldEntry.status !== 'body' || oldEntry.contentHash === newEntry.contentHash)) {
      counts.bothAgreeing++;
    } else {
      counts.bothConflicting++;
      conflicts.push({ key, base: oldEntry, fetch: newEntry });
    }
  }
  return { counts, conflicts };
}
