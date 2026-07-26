// The Ledger concept — the COLLECTION of manifests under a tree.
//
// Vocabulary (settled): a `wayback.json` file is a MANIFEST (manifest.js —
// one source file's standalone rewrite program); the LEDGER is what you get
// by discovering every manifest under a root. File paths are identity here:
// no directory-layout conventions, no id derivation — any tree that contains
// `wayback.json` files has a ledger.
//
// Three operations:
//
//   discover(root)            → every manifest under root, sorted by path
//   flatten(discovered)       → the union manifest (the seen-file bootstrap
//                               for manifest.js#generate)
//   against(discovered, cacheRoot)
//                             → the fetch-worklist join: every capture the
//                               ledger references, classified by the cache
//                               root's sidecars (cache.js — the library's
//                               own reader; no second parser)

import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from './audit.js';
import { readSidecar } from './cache.js';
import { captureKey } from './key.js';
import { emptyManifest, readManifest } from './manifest.js';

/**
 * @typedef {Object} DiscoveredManifest
 * @property {string} file - Path relative to the discovery root, `/`-joined
 *   (e.g. `a/b/wayback.json`) — deterministic across platforms.
 * @property {ReturnType<import('./manifest.js').validateManifest>} manifest
 */

/**
 * Recursively discover every `wayback.json` manifest under `root`. Each file
 * is read through manifest.js#readManifest (versions {1, 2}; v1 nulls read
 * as `exclude`), so an invalid manifest anywhere under the tree fails loud
 * with its path. Hidden directories and node_modules are skipped; results
 * are sorted by relative path.
 *
 * @param {string} root
 * @returns {DiscoveredManifest[]}
 */
export function discover(root) {
  const found = [];
  walk(root, root, found);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

function walk(root, dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === 'wayback.json') {
      found.push({
        file: path.relative(root, full).split(path.sep).join('/'),
        manifest: readManifest(full)
      });
    } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      walk(root, full, found);
    }
  }
}

/**
 * Union a discovered ledger into ONE manifest — the seen-file bootstrap:
 * every verdict any manifest under the tree already holds, so generation
 * over a migrated corpus starts with zero unknown urls.
 *
 * Determinism: manifests merge in sorted-path order and the FIRST verdict
 * for a url key wins (a url two manifests resolved to different captures —
 * each near its own source's date — keeps the first; a union file needs one
 * representative verdict, not all of them). `exclude` is a set union. A url
 * that lands in more than one section is harmless: consumers look up with
 * apply's precedence (exclude → rewrites → entries), which fails safe.
 *
 * @param {DiscoveredManifest[]} discovered
 * @returns {object} a normalized in-memory manifest
 */
export function flatten(discovered) {
  const out = emptyManifest();
  const exclude = new Set();
  for (const { manifest } of discovered) {
    for (const [url, target] of Object.entries(manifest.rewrites)) {
      if (!Object.hasOwn(out.rewrites, url)) out.rewrites[url] = target;
    }
    for (const [url, entry] of Object.entries(manifest.entries)) {
      if (!Object.hasOwn(out.entries, url)) out.entries[url] = { ...entry };
    }
    for (const url of manifest.exclude) exclude.add(url);
  }
  out.exclude = [...exclude].sort();
  return out;
}

/**
 * @typedef {Object} WorklistItem
 * @property {string} key - captureKey (`<timestamp>/<original>`) — the cache
 *   store identity.
 * @property {string} waybackUrl - a replay URL for the capture (the first
 *   manifest spelling encountered).
 * @property {string} timestamp
 * @property {string} originalUrl
 * @property {string[]} files - every manifest (relative path) referencing it.
 * @property {string|null} status - the sidecar's status, null when unfetched.
 */

/**
 * Join a discovered ledger against a cache root: every capture the ledger's
 * entries reference, deduped by capture key and classified by the root's
 * sidecars into worklists —
 *
 *   unfetched     no sidecar: `cache` still has to fetch it
 *   cached        a servable/settled entry (status body | redirect | empty)
 *   interstitial  stored as a refused interstitial — needs a re-pick
 *   error         the archive permanently lacks it — needs a re-pick
 *
 * Sidecars are read through cache.js#readSidecar (the completion-token
 * reader with its version/key authenticity checks) — the library has ONE
 * sidecar parser and this is it. `exclude` and `rewrites` reference no
 * captures and take no part in the join.
 *
 * @param {DiscoveredManifest[]} discovered
 * @param {string} cacheRoot
 * @returns {Promise<{ unfetched: WorklistItem[], cached: WorklistItem[],
 *   interstitial: WorklistItem[], error: WorklistItem[] }>}
 */
export async function against(discovered, cacheRoot) {
  const byKey = new Map();
  for (const { file, manifest } of discovered) {
    for (const entry of Object.values(manifest.entries)) {
      // readManifest already proved parseability; parse again here only to
      // derive the capture identity.
      const parsed = parseWaybackUrl(entry.wayback);
      const key = captureKey(parsed.timestamp, parsed.original);
      let item = byKey.get(key);
      if (!item) {
        item = {
          key,
          waybackUrl: entry.wayback,
          timestamp: parsed.timestamp,
          originalUrl: parsed.original,
          files: [],
          status: null
        };
        byKey.set(key, item);
      }
      if (!item.files.includes(file)) item.files.push(file);
    }
  }

  const worklists = { unfetched: [], cached: [], interstitial: [], error: [] };
  for (const key of [...byKey.keys()].sort()) {
    const item = byKey.get(key);
    const sidecar = await readSidecar(cacheRoot, key);
    if (sidecar === null) {
      worklists.unfetched.push(item);
      continue;
    }
    item.status = sidecar.status;
    if (sidecar.status === 'interstitial') worklists.interstitial.push(item);
    else if (sidecar.status === 'error') worklists.error.push(item);
    else worklists.cached.push(item); // body | redirect | empty — settled
  }
  return worklists;
}
