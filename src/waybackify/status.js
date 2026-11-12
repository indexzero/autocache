// status — one glance at a cache root against the ledger it is filling.
//
// `ledger --root` prints one row per capture; `cache verify` checks the store
// against itself. Neither answers the question an operator asks between
// passes of `cache fill`: how far along is it, and what will another pass
// not fix? This is that summary — a read-only lens over the ledger join
// (ledger.js#against) and fill's durable state (.refetch/gone.jsonl):
//
//   states      the capture-state histogram: cached | unfetched |
//               interstitial | error
//   groups      the same histogram per top-level directory of the ledger —
//               a site, a series, whatever the ledger's first path segment is
//   unfetched   split into `gone` (the archive 404'd it; fill will never
//               retry) and `pending` (another pass can fetch it)
//   attention   the captures no further pass will fix, each with its remedy:
//               `remediate` (a wrapper stub — `cache remediate` refetches it
//               raw) or `repick` (choose a different capture)
//   store       sidecars, split into ledger documents and requisites, and
//               the bytes under cap/
//
// It touches no network and writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from './audit.js';
import { captureKey } from './key.js';
import { against as defaultAgainst, discover as defaultDiscover } from './ledger.js';
import { RAW_REFETCH_SIGNATURES } from './remediate.js';

const STATES = ['cached', 'unfetched', 'interstitial', 'error'];
const emptyStates = () => Object.fromEntries(STATES.map(s => [s, 0]));

/** Count the files (and their bytes) under one of the root's shard trees. */
function walkShards(dir) {
  let files = 0;
  let bytes = 0;
  let shards;
  try {
    shards = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { files, bytes };
    throw error;
  }
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const ent of fs.readdirSync(path.join(dir, shard.name), { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      files++;
      bytes += fs.statSync(path.join(dir, shard.name, ent.name)).size;
    }
  }
  return { files, bytes };
}

/** The capture keys fill recorded as gone (missing file → empty set). */
function goneKeys(root) {
  const keys = new Set();
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.refetch', 'gone.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return keys;
    throw error;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = parseWaybackUrl(JSON.parse(line).waybackUrl);
      if (parsed) keys.add(captureKey(parsed.timestamp, parsed.original));
    } catch { /* a torn line is not a gone record */ }
  }
  return keys;
}

/**
 * Summarize a cache root against a ledger.
 *
 * @param {string} ledgerDir - tree to discover manifests and capture lists under
 * @param {string} root - cache root
 * @param {Object} [deps] - test seams: { discover, against }
 * @returns {Promise<{ root: string, ledger: string, captures: number,
 *   states: Record<string, number>, groups: Record<string, Record<string, number>>,
 *   unfetched: { gone: number, pending: number },
 *   attention: Array<{ state: string, key: string, signature?: string, remedy: 'remediate'|'repick' }>,
 *   store: { sidecars: number, documents: number, requisites: number, bytes: number },
 *   complete: boolean }>}
 */
export async function status(ledgerDir, root, deps = {}) {
  if (!ledgerDir) throw new TypeError('status: ledgerDir is required');
  if (!root) throw new TypeError('status: root is required');
  const discover = deps.discover ?? defaultDiscover;
  const against = deps.against ?? defaultAgainst;

  const worklists = await against(discover(ledgerDir), root);
  const gone = goneKeys(root);
  const states = emptyStates();
  const groups = {};
  const unfetched = { gone: 0, pending: 0 };
  const attention = [];
  let captures = 0;
  for (const state of STATES) {
    for (const item of worklists[state] ?? []) {
      captures++;
      states[state]++;
      const first = item.files?.[0] ?? '';
      const group = first.includes('/') ? first.slice(0, first.indexOf('/')) : '.';
      (groups[group] ??= emptyStates())[state]++;
      if (state === 'unfetched') unfetched[gone.has(item.key) ? 'gone' : 'pending']++;
      if (state === 'interstitial' || state === 'error') {
        attention.push({
          state,
          key: item.key,
          ...(item.signature ? { signature: item.signature } : {}),
          remedy: state === 'interstitial' && RAW_REFETCH_SIGNATURES.includes(item.signature) ? 'remediate' : 'repick'
        });
      }
    }
  }
  attention.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const meta = walkShards(path.join(root, 'meta'));
  const cap = walkShards(path.join(root, 'cap'));
  const documents = captures - states.unfetched;
  return {
    root,
    ledger: ledgerDir,
    captures,
    states,
    groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    unfetched,
    attention,
    store: { sidecars: meta.files, documents, requisites: Math.max(0, meta.files - documents), bytes: cap.bytes },
    // Nothing another pass could fetch, and nothing that needs a human.
    complete: unfetched.pending === 0 && attention.length === 0
  };
}
