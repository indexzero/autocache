// The Ledger concept — the COLLECTION of manifests under a tree.
//
// Vocabulary (settled): a `wayback.json` file is a MANIFEST (manifest.js —
// one source file's standalone rewrite program); the LEDGER is what you get
// by discovering every manifest under a root. File paths are identity here:
// no directory-layout conventions, no id derivation — any tree that contains
// `wayback.json` files has a ledger.
//
// A ledger holds a second kind of file beside the manifest: the CAPTURE LIST
// (`captures.jsonl`). A manifest is keyed by original URL — one capture per
// URL, because it is a rewrite program. A capture list is keyed by nothing: it
// is one JSON object per line, each naming one capture by its replay URL, so
// it can hold every version of a URL. It is how a source that is not a
// markdown file (a whole-site enumeration, a corpus walk) hands captures to
// the same fetch pipeline. Row shape:
//
//   { "wayback": "<replay-url>",        required, parseable
//     "rank": 0,                        optional, non-negative integer —
//                                       fetch order: lower ranks first
//     ...anything else }                the producer's own provenance
//                                       (mimetype, digest, …), carried, unread
//
// Operations:
//
//   discover(root)            → every manifest and capture list under root,
//                               sorted by path
//   captures(discovered)      → every capture the ledger references, deduped
//                               by capture key (no cache root needed)
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

/** The capture-list file name (the manifest's is `wayback.json`). */
export const CAPTURE_LIST = 'captures.jsonl';

/**
 * @typedef {Object} DiscoveredManifest
 * @property {string} file - Path relative to the discovery root, `/`-joined
 *   (e.g. `a/b/wayback.json`) — deterministic across platforms.
 * @property {ReturnType<import('./manifest.js').validateManifest>} manifest -
 *   for a capture list, the empty manifest (it carries no rewrite program).
 * @property {Array<{wayback: string, rank?: number}>} [captures] - present
 *   IFF the file is a capture list: its rows, in file order.
 */

/**
 * Read + validate a capture list. Every non-blank line must be a JSON object
 * with a parseable `wayback` replay URL; `rank`, when present, a non-negative
 * integer. A bad line fails loud with its file and line number — a capture
 * no mirror could fetch is a defect to fix at the producer, never to skip.
 *
 * @param {string} file
 * @returns {Array<{wayback: string, rank?: number}>}
 */
export function readCaptureList(file) {
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const bad = detail => new Error(`${file}:${i + 1}: invalid capture list — ${detail}`);
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw bad('not JSON');
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw bad('row must be an object');
    if (typeof row.wayback !== 'string' || parseWaybackUrl(row.wayback) === null) {
      throw bad(`unparseable wayback URL: ${row.wayback}`);
    }
    if (row.rank !== undefined && !(Number.isSafeInteger(row.rank) && row.rank >= 0)) {
      throw bad(`rank must be a non-negative integer: ${JSON.stringify(row.rank)}`);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Recursively discover every `wayback.json` manifest and `captures.jsonl`
 * capture list under `root`. Each manifest is read through
 * manifest.js#readManifest (the current version only) and each capture list
 * through readCaptureList, so an invalid file anywhere under the tree fails
 * loud with its path. Hidden directories and node_modules are skipped.
 * Results are sorted by relative path.
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
    } else if (entry.isFile() && entry.name === CAPTURE_LIST) {
      found.push({
        file: path.relative(root, full).split(path.sep).join('/'),
        manifest: emptyManifest(),
        captures: readCaptureList(full)
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
 * representative verdict, not all of them). `exclude` is a set union.
 * `noRewrite` is never unioned: it is one author's intent for one post, not
 * a verdict that another source can reuse. A url
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
 * @property {string} [signature] - the sidecar's interstitial signature
 *   (present IFF status is `interstitial`).
 * @property {number} rank - fetch order, lower first: the lowest `rank` any
 *   capture-list row gives it; 0 for a capture a manifest references.
 */

/**
 * Every capture a discovered ledger references — manifest entries and
 * capture-list rows — deduped by capture key and sorted by it. The
 * capture-level view of a ledger: where `flatten` keeps ONE capture per
 * original URL, this keeps every (timestamp, original) pair, with the files
 * that name it. `status` is null throughout: no cache root is consulted
 * (`against` is the join).
 *
 * @param {DiscoveredManifest[]} discovered
 * @returns {WorklistItem[]}
 */
export function captures(discovered) {
  const byKey = new Map();
  const add = (file, wayback, rank) => {
    // The readers already proved parseability; parse again here only to
    // derive the capture identity.
    const parsed = parseWaybackUrl(wayback);
    const key = captureKey(parsed.timestamp, parsed.original);
    let item = byKey.get(key);
    if (!item) {
      item = {
        key,
        waybackUrl: wayback,
        timestamp: parsed.timestamp,
        originalUrl: parsed.original,
        files: [],
        status: null,
        rank
      };
      byKey.set(key, item);
    }
    if (rank < item.rank) item.rank = rank;
    if (!item.files.includes(file)) item.files.push(file);
  };
  for (const { file, manifest, captures: rows } of discovered) {
    for (const entry of Object.values(manifest.entries)) add(file, entry.wayback, 0);
    for (const row of rows ?? []) add(file, row.wayback, row.rank ?? 0);
  }
  return [...byKey.keys()].sort().map(key => byKey.get(key));
}

/**
 * Join a discovered ledger against a cache root: every capture the ledger's
 * entries and capture lists reference, deduped by capture key and classified by the root's
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
  const byKey = new Map(captures(discovered).map(item => [item.key, item]));

  const worklists = { unfetched: [], cached: [], interstitial: [], error: [] };
  for (const key of [...byKey.keys()].sort()) {
    const item = byKey.get(key);
    const sidecar = await readSidecar(cacheRoot, key);
    if (sidecar === null) {
      worklists.unfetched.push(item);
      continue;
    }
    item.status = sidecar.status;
    if (sidecar.signature !== undefined) item.signature = sidecar.signature;
    if (sidecar.status === 'interstitial') worklists.interstitial.push(item);
    else if (sidecar.status === 'error') worklists.error.push(item);
    else worklists.cached.push(item); // body | redirect | empty — settled
  }
  return worklists;
}
