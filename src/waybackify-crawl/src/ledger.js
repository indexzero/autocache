/**
 * `<root>/.crawl/` run ledgers + probe artifacts (design "Operational policy").
 *
 *   verified.jsonl   one row per document that reached the fixpoint. A CLAIM
 *                    about {root, rules, browser} — NOT a sidecar field ("a
 *                    sidecar is a fact; verified is a claim"). Invalidated by a
 *                    `rewrite.js#RULE_VERSION` bump (a re-remaster changes what
 *                    a correct render looks like) or an fsck SHORT on the doc.
 *   flaky.jsonl      one row per document that did NOT converge (max-iterations
 *                    hit, or a non-empty leak set that stopped adding new keys —
 *                    nondeterministic JS, cache-busters, rotating banners). The
 *                    visible residual class, with the residual URLs, distinct
 *                    from silent incompleteness.
 *   har/             per-document request logs (the raw material a human audits).
 *
 * Appended by crawl ONLY; never committed to git; deletable by the owner
 * (deleting verified.jsonl merely forces re-probes — safe). Writes are plain
 * appends of one canonical JSON object per line.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** The `.crawl/` directory under a cache root. */
export function crawlDir(root) {
  return path.join(root, '.crawl');
}

/** Ensure `<root>/.crawl/` (and, if asked, `har/`) exist. */
export async function ensureCrawlDir(root, { har = false } = {}) {
  const dir = crawlDir(root);
  await fsp.mkdir(dir, { recursive: true });
  if (har) await fsp.mkdir(path.join(dir, 'har'), { recursive: true });
  return dir;
}

async function appendJsonl(file, row) {
  await fsp.appendFile(file, JSON.stringify(row) + '\n');
}

/**
 * Read a `.jsonl` ledger into an array of rows. A missing file is an empty
 * ledger. A malformed line is skipped (a partial append from a crash must not
 * sink the reader — the ledger is a hint, not an authority).
 */
export async function readJsonl(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return rows;
}

/**
 * The set of document keys whose LATEST verified stamp is still valid for the
 * given `ruleVersion`. verified.jsonl is append-only and read latest-row-wins:
 * a later row (a fresh stamp OR a `{ verified: false }` invalidation tombstone)
 * supersedes an earlier one. A key is verified iff its latest row is a real
 * stamp (`verified !== false`) whose `ruleVersion` matches the live one — a
 * re-remaster (RULE_VERSION bump) changes what a correct render looks like, so
 * every prior claim is void, and a `--force` re-probe that did NOT re-verify
 * writes a tombstone so the stale claim never outlives the evidence.
 *
 * @param {string} root
 * @param {number} ruleVersion
 * @returns {Promise<Set<string>>}
 */
export async function verifiedKeys(root, ruleVersion) {
  const rows = await readJsonl(path.join(crawlDir(root), 'verified.jsonl'));
  const latest = new Map();
  for (const row of rows) {
    if (row && typeof row.key === 'string') latest.set(row.key, row);
  }
  const set = new Set();
  for (const [key, row] of latest) {
    if (row.verified !== false && row.ruleVersion === ruleVersion) set.add(key);
  }
  return set;
}

/** Append a verified stamp. */
export async function stampVerified(root, row) {
  await appendJsonl(path.join(crawlDir(root), 'verified.jsonl'), row);
}

/**
 * Invalidate a doc's verified claim (a `{ verified: false }` tombstone). Written
 * BEFORE a `--force` re-probe of a previously-verified doc, so a re-probe that
 * ends flaky/unconverged — or crashes mid-flight — can never leave the stale
 * "verified" as the latest row. If the re-probe re-verifies, the fresh stamp is
 * appended after and wins.
 */
export async function invalidateVerified(root, key, reason = 'force-reprobe') {
  await appendJsonl(path.join(crawlDir(root), 'verified.jsonl'), { key, at: new Date().toISOString(), verified: false, reason });
}

/** Append a flaky/unconverged row. */
export async function recordFlaky(root, row) {
  await appendJsonl(path.join(crawlDir(root), 'flaky.jsonl'), row);
}

/** Write a per-document HAR-ish request log (best-effort; never fails a run). */
export async function writeHar(root, docKey, payload) {
  try {
    const safe = docKey.replace(/[^\w.-]+/g, '_').slice(0, 200);
    await fsp.mkdir(path.join(crawlDir(root), 'har'), { recursive: true });
    await fsp.writeFile(path.join(crawlDir(root), 'har', `${safe}.json`), JSON.stringify(payload, null, 2));
  } catch {
    /* a failed artifact write never fails the audit */
  }
}
