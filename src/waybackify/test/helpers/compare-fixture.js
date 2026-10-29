// Synthetic roots written through the current cache writer. No network.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitEntry } from '../../cache.js';

export const key = name => `20200102030405/https://example.test/${name}`;
export const fetchedAt = '2026-01-01T00:00:00.000Z';

export async function put(root, name, status = 'body', body = name, extra = {}) {
  return commitEntry(root, {
    key: key(name), status, contentType: 'text/plain', fetchedAt,
    ...(status === 'body' ? { body: new TextEncoder().encode(body) } : {}),
    ...extra
  });
}

export async function roots() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'waybackify-compare-'));
  const base = path.join(dir, 'base');
  const fetch = path.join(dir, 'fetch');
  await fsp.mkdir(base);
  await fsp.mkdir(fetch);
  return { dir, base, fetch };
}

export async function fixture(reverse = false) {
  const pair = await roots();
  const entries = [
    [pair.base, 'old'],
    [pair.fetch, 'new'],
    [pair.base, 'same', 'body', 'equal bytes'],
    [pair.fetch, 'same', 'body', 'equal bytes', { contentType: 'application/octet-stream', fetchedAt: '2026-02-01T00:00:00.000Z', flag: 'im_' }],
    [pair.base, 'empty', 'empty'],
    [pair.fetch, 'empty', 'empty'],
    [pair.base, 'redirect', 'redirect'],
    [pair.fetch, 'redirect', 'redirect'],
    [pair.base, 'error', 'error'],
    [pair.fetch, 'error', 'error'],
    [pair.base, 'interstitial', 'interstitial'],
    [pair.fetch, 'interstitial', 'interstitial'],
    [pair.base, 'z-hash', 'body', 'old bytes'],
    [pair.fetch, 'z-hash', 'body', 'new bytes'],
    [pair.base, 'A-state', 'empty'],
    [pair.fetch, 'A-state', 'redirect'],
    [pair.base, 'é-body', 'body', 'kept bytes'],
    [pair.fetch, 'é-body', 'error']
  ];
  if (reverse) entries.reverse();
  for (const args of entries) await put(...args);
  return pair;
}

// Include directories, names, modes, and raw bytes. Extra empty directories
// and changed sidecars are observable, not only changed body hashes.
export async function snapshot(dir) {
  const result = [];
  async function walk(current, relative = '') {
    const stat = await fsp.lstat(current);
    if (stat.isDirectory()) {
      result.push({ path: relative, type: 'directory', mode: stat.mode });
      for (const name of (await fsp.readdir(current)).sort()) {
        await walk(path.join(current, name), path.posix.join(relative, name));
      }
    } else if (stat.isSymbolicLink()) {
      result.push({ path: relative, type: 'symlink', target: await fsp.readlink(current) });
    } else {
      result.push({ path: relative, type: 'file', mode: stat.mode, bytes: await fsp.readFile(current) });
    }
  }
  await walk(dir);
  return result;
}
