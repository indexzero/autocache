// backfill — drive a cache root to a COMPLETE asset closure of every capture a
// ledger references: each referenced page AND its requisites (images/CSS/JS),
// not just the HTML. The generic, resumable, self-limiting bulk-fetch engine
// behind `waybackify cache fill` (and any repo's thin shim over it).
//
// Modeled on the retired series/waybackify-words cron so the byte-download pass
// is as polite + convergent as that resolve pass was:
//
//   • DURABLE WORKLIST — the incomplete set is enumerated ONCE (ledger `against`
//     a cache root) and persisted to <root>/.refetch/worklist.jsonl. "Incomplete"
//     is closure-aware, not doc-presence: never-fetched captures AND already-
//     `cached` pages (whose ledger state only means the DOCUMENT sidecar exists
//     — the asset closure may still be short) both go on the list. Reused across
//     runs (no re-enumerate) so pacing + resume accumulate; `refresh` rebuilds.
//   • GENTLE — a real delay paces successive CAPTURES (a page + its requisites
//     are fetched together, browser-style, within one cacheCapture); fully-closed
//     captures skip for free (cacheCapture reads sidecars and fetches only the
//     missing requisites — no network when complete), never spending the delay.
//   • CONVERGENT — a transient reply (498/429/5xx/timeout) DEFERS the capture
//     (left pending; a later run retries it) instead of retry-hammering.
//   • SELF-LIMITING — a run of consecutive CONNECTION failures (archive.org down
//     or blocking us) ABORTS the run rather than firing hundreds of doomed
//     requests. A genuinely-missing capture (404) is recorded in .refetch/
//     gone.jsonl and never retried.
//   • RESUMABLE — killable at any point; the cache root is the done-truth, so a
//     re-run skips what's already fully closed and finishes the rest. `max`
//     caps a single run.
//
// Vocabulary shim: the durable dir is `.refetch/` (not `.backfill/`) so an
// in-progress run started under an earlier `refetch`-style driver keeps its
// worklist + gone ledger — the bytes on disk are the contract, not the name.

import fs from 'node:fs';
import path from 'node:path';
import { discover as defaultDiscover, against as defaultAgainst } from './ledger.js';
import { WaybackMachine } from './index.js';

// A capture earns a worklist slot if refetching it can advance closure:
//   unfetched — no document sidecar yet; must be fetched.
//   cached    — the document sidecar exists, but ledger's `cached` verdict is
//               doc-only and does NOT check the asset closure, so the page may
//               still be missing requisites. Including it lets cacheCapture
//               complete the closure; a fully-closed page costs only local
//               sidecar reads (no network).
// interstitial / error captures need a re-PICK (a different snapshot), not a
// refetch of the same URL — refetching would just re-store the same junk — so
// they are deliberately excluded.
export const WORKLIST_STATES = ['unfetched', 'cached'];

/**
 * The closure worklist from a ledger `against` result: the waybackUrls of every
 * unfetched-or-cached capture, key-sorted for deterministic, resumable order.
 * @param {{unfetched?: object[], cached?: object[]}} worklists
 * @returns {string[]}
 */
export function selectWorklist(worklists) {
  const items = [];
  for (const state of WORKLIST_STATES) {
    for (const item of worklists?.[state] ?? []) {
      if (item?.waybackUrl) items.push(item);
    }
  }
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return items.map(i => i.waybackUrl);
}

/**
 * Classify a fetch failure into the engine's three outcomes:
 *   'gone'      — HTTP 404: the archive genuinely lacks this capture. Terminal:
 *                 never retried (recorded in gone.jsonl).
 *   'transient' — non-200 replay (498/429/5xx) or an unknown error. The server
 *                 answered / the reason is unclear → DEFER, retry next run.
 *   'connfail'  — could not connect (refused/reset/timeout/DNS). archive.org is
 *                 unreachable → counts toward the abort streak.
 * Accepts a thrown Error or a { error: string } record (requisite failures).
 * (Relocated here from the repo driver; typed errors on cacheCapture are a
 * follow-up that would let this classify on `instanceof` instead of message.)
 */
export function classifyFailure(err) {
  const msg = typeof err === 'string'
    ? err
    : `${err?.message ?? ''} ${err?.error ?? ''} ${err?.cause?.message ?? ''} ${err?.cause?.code ?? ''}`;
  // \b so a genuine 404 is terminal but "HTTP 4040" (an incidental longer
  // number) is not mistaken for archive-missing and permanently exiled to gone.
  if (/HTTP 404\b/.test(msg)) return 'gone';
  // Connection-level failures → count toward the abort streak. `timeout` (with
  // /i) also catches impit's ConnectTimeout('request timeout') so a timeout
  // storm aborts instead of resetting the streak as a "transient".
  if (/ECONNREFUSED|ECONNRESET|ConnectionRefused|tcp connect error|connect error|Failed to connect|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed ?out|timeout|dns error/i.test(msg)) {
    return 'connfail';
  }
  return 'transient'; // "transient archive.org trouble" (non-200) + unknowns → safe to defer
}

/** Read the `waybackUrl` of every JSONL line in a file (missing file → []). */
function readUrls(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { const r = JSON.parse(s); if (r.waybackUrl) out.push(r.waybackUrl); } catch { /* skip */ }
  }
  return out;
}

const refetchDir = root => path.join(root, '.refetch');

/**
 * Drive `root` to a complete asset closure of the ledger under `ledgerDir`.
 *
 * @param {Object} opts
 * @param {string} opts.ledgerDir - tree to discover wayback.json manifests under
 * @param {string} opts.root - cache root to populate + measure closure against
 * @param {number} [opts.delayMs=1500] - pacing between captures (a page + its
 *   requisites fetch together within one cacheCapture; the delay is per-capture)
 * @param {number} [opts.abortAfter=5] - consecutive connection failures → abort
 * @param {number} [opts.max=Infinity] - cap NETWORK attempts this run
 * @param {boolean} [opts.refresh=false] - rebuild the worklist from a fresh enumerate
 * @param {boolean} [opts.dryRun=false] - build/return the worklist; fetch nothing
 * @param {(ev: object) => void} [opts.onProgress] - progress observer (see events below)
 * @param {Object} [opts.deps] - test seams: { discover, against, cacheCapture, wayback, fetch, sleep }
 * @returns {Promise<{worklist: {built: boolean, count: number, path: string},
 *   pending: number, gone: number, stats: object|null, aborted: boolean, dryRun: boolean}>}
 */
export async function backfill(opts = {}) {
  const {
    ledgerDir,
    root,
    delayMs = 1500,
    abortAfter = 5,
    max = Infinity,
    refresh = false,
    dryRun = false,
    onProgress = () => {},
    deps = {}
  } = opts;
  if (!root) throw new TypeError('backfill: options.root is required');
  if (!ledgerDir) throw new TypeError('backfill: options.ledgerDir is required');

  const discover = deps.discover ?? defaultDiscover;
  const against = deps.against ?? defaultAgainst;
  const cacheCapture = deps.cacheCapture ?? (await import('./cache.js')).cacheCapture;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const wayback = deps.wayback ?? new WaybackMachine({ timeout: 60000 });

  const dir = refetchDir(root);
  const worklistPath = path.join(dir, 'worklist.jsonl');
  const gonePath = path.join(dir, 'gone.jsonl');

  // 1. Durable worklist — build ONCE (or refresh), otherwise reuse.
  let urls;
  let built;
  if (refresh || !fs.existsSync(worklistPath)) {
    urls = selectWorklist(await against(discover(ledgerDir), root));
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: a kill mid-write must not leave a TRUNCATED worklist that a
    // later run silently trusts (skipping the lost captures forever without a
    // re-enumerate). Write to a temp file, then rename into place — the reader
    // sees either the old complete file or the new complete file, never a
    // partial one.
    const tmp = `${worklistPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, urls.map(u => `${JSON.stringify({ waybackUrl: u })}\n`).join(''));
    fs.renameSync(tmp, worklistPath);
    built = true;
  } else {
    urls = readUrls(worklistPath);
    built = false;
  }
  onProgress({ type: 'worklist', built, count: urls.length, path: worklistPath });

  const gone = new Set(readUrls(gonePath));
  const pending = urls.filter(u => !gone.has(u));
  onProgress({ type: 'plan', pending: pending.length, gone: gone.size, total: urls.length });

  const worklist = { built, count: urls.length, path: worklistPath };
  if (dryRun) {
    onProgress({ type: 'dry-run', pending: pending.length });
    return { worklist, pending: pending.length, gone: gone.size, stats: null, aborted: false, dryRun: true };
  }

  // 2. Process — cacheCapture in-process, paced, deferring transients, aborting
  //    on a connection-failure streak.
  const stats = { attempted: 0, fetched: 0, cached: 0, deferred: 0, gone: 0 };
  let connStreak = 0;
  let aborted = false;

  for (const [idx, url] of pending.entries()) {
    if (stats.attempted >= max) {
      onProgress({ type: 'max', max });
      break;
    }

    let outcome; // 'fetched' | 'cached' | 'deferred' | 'gone' | 'connfail'
    try {
      const summary = await cacheCapture(url, { root, wayback, fetch: deps.fetch });
      const failures = summary.failures ?? [];
      if (failures.length > 0) {
        // Requisites failed. If ANYTHING fetched this round the server was
        // reachable, so a requisite-level connection failure is NOT an outage:
        // defer (retry the rest next run) and let the success reset the abort
        // streak. Only a round that fetched NOTHING and hit a connection
        // failure counts toward abort — the "archive.org is down" signal.
        outcome =
          summary.fetched === 0 && failures.some(f => classifyFailure(f) === 'connfail')
            ? 'connfail'
            : 'deferred';
      } else if (summary.fetched > 0) {
        outcome = 'fetched';
      } else {
        outcome = 'cached'; // fully closed: no network happened
      }
    } catch (err) {
      outcome = classifyFailure(err);
      if (outcome === 'transient') outcome = 'deferred';
      else if (outcome === 'gone') fs.appendFileSync(gonePath, `${JSON.stringify({ waybackUrl: url })}\n`);
    }

    onProgress({ type: 'entry', url, outcome });

    // cached is free (no attempt, no pacing); everything else is a network op.
    if (outcome === 'cached') {
      stats.cached++;
      continue;
    }
    stats.attempted++;
    if (outcome === 'connfail') {
      connStreak++;
      stats.deferred++;
      onProgress({ type: 'connfail', url, streak: connStreak, abortAfter });
      if (connStreak >= abortAfter) {
        aborted = true;
        onProgress({ type: 'abort', streak: connStreak, pending: pending.length - (idx + 1) });
        break;
      }
    } else {
      connStreak = 0; // a real reply (fetched / 404-gone) breaks the streak
      if (outcome === 'fetched') stats.fetched++;
      else if (outcome === 'gone') stats.gone++;
      else stats.deferred++;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  onProgress({ type: 'summary', stats, aborted });
  return { worklist, pending: pending.length, gone: gone.size, stats, aborted, dryRun: false };
}
