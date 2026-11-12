// backfill — drive a cache root to a COMPLETE asset closure of every capture a
// ledger references: each referenced page AND its requisites (images/CSS/JS),
// not just the HTML. The generic, resumable, self-limiting bulk-fetch engine
// behind `waybackify cache fill` (and any repo's thin shim over it).
//
// Modeled on the retired word-list backfill cron so the byte-download pass
// is as polite + convergent as that resolve pass was:
//
//   • DURABLE WORKLIST — the incomplete set is enumerated ONCE (ledger `against`
//     a cache root) and persisted to <root>/.refetch/worklist.jsonl, stamped
//     with a fingerprint of the ledger that built it (worklist.ledger.json).
//     A run whose ledger no longer matches the stamp rebuilds the list, so a
//     changed ledger — or a different one — is never silently skipped.
//     "Incomplete"
//     is closure-aware, not doc-presence: never-fetched captures AND already-
//     `cached` pages (whose ledger state only means the DOCUMENT sidecar exists
//     — the asset closure may still be short) both go on the list. Reused across
//     runs of an unchanged ledger (no re-enumerate) so pacing + resume
//     accumulate; `refresh` rebuilds. Order is pages first, then (rank, key).
//     A PAGE is a capture named by a flagless replay URL: what a browser asks
//     the archive for. Everything named with a replay flag (`id_` raw bytes,
//     `im_`, `oe_`, …) is CONTENT and comes after every page, so the requests
//     a human reader would never send are the last ones a run makes, and a
//     block on them stops a run that already holds every page. Within each
//     half, a capture list's `rank` puts first what should survive a run cut
//     short.
//   • GENTLE — a real delay paces successive CAPTURES (a page + its requisites
//     are fetched together, browser-style, within one cacheCapture); fully-closed
//     captures skip for free (cacheCapture reads sidecars and fetches only the
//     missing requisites — no network when complete), never spending the delay.
//   • CONVERGENT — a transient reply (498/429/5xx/timeout) DEFERS the capture
//     (left pending; a later run retries it) instead of retry-hammering.
//   • THROTTLE-AWARE — a run of consecutive captures that defer with nothing
//     fetched is a rate-limit spell, not bad luck: the run STOPS (reason
//     `throttled`) instead of deferring its way through the whole worklist.
//     The stop writes a cursor (.refetch/cursor.json); the next run starts
//     AFTER the streak and wraps around, so six captures that always fail can
//     never pin every run to the top of the list.
//   • SELF-LIMITING — a run of consecutive CONNECTION failures (archive.org down
//     or blocking us) ABORTS the run rather than firing hundreds of doomed
//     requests. A genuinely-missing capture (404) is recorded in .refetch/
//     gone.jsonl and never retried. A 404 on a github.com deep link must
//     first survive the GitHub root probe (github.js): a renamed repo
//     goes to .refetch/renamed.jsonl as a rewrite candidate, never to gone.
//   • RESUMABLE — killable at any point; the cache root is the done-truth, so a
//     re-run skips what's already fully closed and finishes the rest. `max`
//     caps a single run.
//
// Vocabulary shim: the durable dir is `.refetch/` (not `.backfill/`) so an
// in-progress run started under an earlier `refetch`-style driver keeps its
// worklist + gone ledger — the bytes on disk are the contract, not the name.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from './audit.js';
import { probeGithub } from './github.js';
import { discover as defaultDiscover, against as defaultAgainst, captures as ledgerCaptures } from './ledger.js';
import { WaybackMachine } from './index.js';
import { NOOP_LOGGER } from './noop-logger.js';

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
 * True when a replay URL names a PAGE: `/web/<timestamp>/<original>`, with no
 * replay flag after the timestamp. A flagged URL (`<timestamp>id_/`, `im_/`,
 * `oe_/`, …) names content.
 * @param {string} waybackUrl
 * @returns {boolean}
 */
export function isPage(waybackUrl) {
  return /\/web\/\d+\//.test(String(waybackUrl));
}

/**
 * The closure worklist from a ledger `against` result: the waybackUrls of every
 * unfetched-or-cached capture, pages before content, then sorted by
 * (rank, key) for deterministic, resumable order. An item without a `rank`
 * sorts as rank 0.
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
  const half = item => (isPage(item.waybackUrl) ? 0 : 1);
  items.sort((a, b) => half(a) - half(b) || (a.rank ?? 0) - (b.rank ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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

/**
 * Settle a capture the archive 404'd. A github.com deep link must survive the
 * root probe first: a rename is a rewrite candidate, a probe that cannot
 * answer defers, and only a surviving 404 is gone.
 * @returns {Promise<{ outcome: 'gone'|'renamed'|'deferred', rename?: object }>}
 */
async function settleMissing(url, probe) {
  const original = parseWaybackUrl(url)?.original;
  let verdict;
  try {
    verdict = original ? await probe(original) : null;
  } catch {
    return { outcome: 'deferred' };
  }
  if (!verdict?.renamed) return { outcome: 'gone' };
  return { outcome: 'renamed', rename: { waybackUrl: url, from: verdict.from, to: verdict.to } };
}

const refetchDir = root => path.join(root, '.refetch');

/**
 * A fingerprint of what a discovered ledger asks for: the SHA-256 of every
 * referenced capture's rank and replay URL, in capture-key order. Two ledgers
 * with the same fingerprint build the same worklist against the same root, so
 * the stamp beside a worklist says whether it still answers this ledger.
 * @param {import('./ledger.js').DiscoveredManifest[]} discovered
 * @returns {string} hex digest
 */
export function ledgerFingerprint(discovered) {
  const hash = crypto.createHash('sha256');
  for (const item of ledgerCaptures(discovered)) hash.update(`${item.rank}\t${item.waybackUrl}\n`);
  return hash.digest('hex');
}

/** Read a small JSON state file; absent or unreadable → null. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write a state file atomically (temp + rename), like the worklist itself. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Drive `root` to a complete asset closure of the ledger under `ledgerDir`.
 *
 * @param {Object} opts
 * @param {string} opts.ledgerDir - tree to discover wayback.json manifests under
 * @param {string} opts.root - cache root to populate + measure closure against
 * @param {number} [opts.delayMs=1500] - pacing between captures (a page + its
 *   requisites fetch together within one cacheCapture; the delay is per-capture)
 * @param {number} [opts.abortAfter=5] - consecutive connection failures → abort
 * @param {number} [opts.throttleAfter=6] - consecutive captures that defer with
 *   nothing fetched → stop the run (reason `throttled`); 0 disables
 * @param {number} [opts.requestDelayMs=0] - pacing between the requisite
 *   REQUESTS inside one capture (delayMs paces captures)
 * @param {boolean} [opts.requisites=true] - false stores each named capture
 *   only; its requisite edges are still recorded, never fetched
 * @param {boolean} [opts.pagesOnly=false] - attempt only the pages (flagless
 *   replay URLs); content captures stay pending for a later run
 * @param {number} [opts.max=Infinity] - cap NETWORK attempts this run
 * @param {boolean} [opts.refresh=false] - rebuild the worklist even when the
 *   ledger fingerprint still matches its stamp
 * @param {boolean} [opts.dryRun=false] - build/return the worklist; fetch nothing
 * @param {(ev: object) => void} [opts.onProgress] - progress observer (see events below)
 * @param {Object} [opts.logger] - injected diagnostic logger (default no-op);
 *   threaded into the CDX client + every cacheCapture for the §4 fetch trace
 * @param {Object} [opts.deps] - test seams: { discover, against, cacheCapture, wayback, fetch, sleep, probe }
 * @returns {Promise<{worklist: {built: boolean, reason: string|null, count: number, path: string},
 *   pending: number, gone: number, stats: object|null, aborted: boolean,
 *   reason: 'unreachable'|'throttled'|null, dryRun: boolean,
 *   renames: Array<{waybackUrl: string, from: string, to: string}>}>} `renames`
 *   lists the rewrite candidates that this run found
 */
export async function backfill(opts = {}) {
  const {
    ledgerDir,
    root,
    delayMs = 1500,
    abortAfter = 5,
    throttleAfter = 6,
    requestDelayMs = 0,
    requisites = true,
    pagesOnly = false,
    max = Infinity,
    refresh = false,
    dryRun = false,
    onProgress = () => {},
    logger = NOOP_LOGGER,
    deps = {}
  } = opts;
  if (!root) throw new TypeError('backfill: options.root is required');
  if (!ledgerDir) throw new TypeError('backfill: options.ledgerDir is required');

  const discover = deps.discover ?? defaultDiscover;
  const against = deps.against ?? defaultAgainst;
  const cacheCapture = deps.cacheCapture ?? (await import('./cache.js')).cacheCapture;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const probe = deps.probe ?? probeGithub;
  // The injected logger flows into BOTH the CDX client (retry firehose) and each
  // per-capture fetch (the doc + requisite trace) — the two halves of §4.
  const wayback = deps.wayback ?? new WaybackMachine({ timeout: 60000, logger });

  const dir = refetchDir(root);
  const worklistPath = path.join(dir, 'worklist.jsonl');
  const gonePath = path.join(dir, 'gone.jsonl');
  const renamedPath = path.join(dir, 'renamed.jsonl');

  const stampPath = path.join(dir, 'worklist.ledger.json');
  const cursorPath = path.join(dir, 'cursor.json');

  // 1. Durable worklist — built ONCE per ledger, otherwise reused. The stamp
  //    beside it records the fingerprint of the ledger that built it; a
  //    mismatch (the ledger changed, or this is another ledger) rebuilds, and
  //    so does a worklist with no stamp (written before stamps existed — it
  //    cannot say which ledger it answers). Rebuilding is always safe: the
  //    cache root is the done-truth, the worklist only derived state.
  const discovered = discover(ledgerDir);
  const fingerprint = ledgerFingerprint(discovered);
  let buildReason = null;
  if (refresh) buildReason = 'refresh';
  else if (!fs.existsSync(worklistPath)) buildReason = 'absent';
  else {
    const stamp = readJson(stampPath);
    if (!stamp) buildReason = 'unstamped';
    else if (stamp.fingerprint !== fingerprint) buildReason = 'ledger-changed';
  }
  let urls;
  const built = buildReason !== null;
  if (built) {
    urls = selectWorklist(await against(discovered, root));
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: a kill mid-write must not leave a TRUNCATED worklist that a
    // later run silently trusts (skipping the lost captures forever without a
    // re-enumerate). Write to a temp file, then rename into place — the reader
    // sees either the old complete file or the new complete file, never a
    // partial one. The stamp lands AFTER the worklist: a kill between the two
    // leaves a stale stamp, which only costs one more rebuild.
    writeAtomic(worklistPath, urls.map(u => `${JSON.stringify({ waybackUrl: u })}\n`).join(''));
    writeAtomic(stampPath, `${JSON.stringify({ ledger: path.resolve(ledgerDir), fingerprint })}\n`);
    fs.rmSync(cursorPath, { force: true }); // a cursor indexes the list it was written against
  } else {
    urls = readUrls(worklistPath);
  }
  onProgress({ type: 'worklist', built, reason: buildReason, count: urls.length, path: worklistPath });

  const gone = new Set(readUrls(gonePath));
  // A recorded rename waits for a rewrite policy. Refetching the old URL
  // cannot advance it, so it leaves the pending set like a gone capture.
  const renamed = new Set(readUrls(renamedPath));
  let pending = urls.filter(u => !gone.has(u) && !renamed.has(u));
  // pagesOnly: this run sends only what a browser would. The content half of
  // the worklist stays pending and the worklist itself is untouched.
  const held = pagesOnly ? pending.filter(u => !isPage(u)).length : 0;
  if (pagesOnly) pending = pending.filter(isPage);
  // A run that stopped on a throttle or an outage left a cursor: start after
  // the capture it stopped on and wrap around, so the streak that stopped it
  // is retried LAST instead of first.
  const cursor = readJson(cursorPath);
  const cursorAt = cursor?.after ? pending.indexOf(cursor.after) : -1;
  if (cursorAt >= 0) pending = [...pending.slice(cursorAt + 1), ...pending.slice(0, cursorAt + 1)];
  onProgress({ type: 'plan', pending: pending.length, gone: gone.size, renamed: renamed.size, total: urls.length, held });

  const worklist = { built, reason: buildReason, count: urls.length, path: worklistPath };
  const renames = [];
  if (dryRun) {
    onProgress({ type: 'dry-run', pending: pending.length });
    return { worklist, pending: pending.length, gone: gone.size, stats: null, aborted: false, reason: null, dryRun: true, renames };
  }

  // 2. Process — cacheCapture in-process, paced, deferring transients, aborting
  //    on a connection-failure streak.
  const stats = { attempted: 0, fetched: 0, cached: 0, deferred: 0, gone: 0 };
  let connStreak = 0;
  let stallStreak = 0; // consecutive captures that deferred with nothing fetched
  let aborted = false;
  let reason = null;
  let capped = false;
  const stop = (why, idx, url) => {
    aborted = true;
    reason = why;
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(cursorPath, `${JSON.stringify({ after: url, reason: why })}\n`);
    onProgress({ type: 'abort', reason: why, streak: why === 'throttled' ? stallStreak : connStreak, pending: pending.length - (idx + 1) });
  };

  for (const [idx, url] of pending.entries()) {
    if (stats.attempted >= max) {
      onProgress({ type: 'max', max });
      capped = true;
      break;
    }

    let outcome; // 'fetched' | 'cached' | 'deferred' | 'gone' | 'renamed' | 'connfail'
    let progressed = false; // did this capture put ANY bytes in the root?
    try {
      const summary = await cacheCapture(url, { root, wayback, fetch: deps.fetch, logger, requisites, requestDelayMs, sleep });
      progressed = summary.fetched > 0;
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
      else if (outcome === 'gone') {
        const settled = await settleMissing(url, probe);
        outcome = settled.outcome;
        if (outcome === 'gone') fs.appendFileSync(gonePath, `${JSON.stringify({ waybackUrl: url })}\n`);
        if (settled.rename) {
          fs.appendFileSync(renamedPath, `${JSON.stringify(settled.rename)}\n`);
          renames.push(settled.rename);
          onProgress({ type: 'rename', ...settled.rename });
        }
      }
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
        stop('unreachable', idx, url);
        break;
      }
    } else {
      connStreak = 0; // a real reply (fetched / 404-gone / renamed) breaks the streak
      if (outcome === 'fetched') stats.fetched++;
      else if (outcome === 'gone') stats.gone++;
      else if (outcome !== 'renamed') stats.deferred++;
    }
    // The throttle streak: a deferral that fetched nothing is the archive
    // answering 429/5xx (or not at all). Any capture that stored bytes, or
    // settled as gone/renamed, proves the archive is serving and resets it.
    if ((outcome === 'deferred' || outcome === 'connfail') && !progressed) stallStreak++;
    else stallStreak = 0;
    if (throttleAfter > 0 && stallStreak >= throttleAfter && !aborted) {
      stop('throttled', idx, url);
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  // A run that walked the whole pending list owes no cursor to the next one.
  if (!aborted && !capped) fs.rmSync(cursorPath, { force: true });

  onProgress({ type: 'summary', stats, aborted });
  return { worklist, pending: pending.length, gone: gone.size, stats, aborted, reason, dryRun: false, renames };
}

/**
 * Run `backfill` passes until the worklist converges — the loop every driver
 * of `cache fill` otherwise writes for itself. A pass that fetched nothing and
 * deferred nothing is convergence. A pass that stopped (archive.org
 * unreachable, or throttling) or made no progress is followed by a backoff
 * that doubles from `backoffMs` to `backoffMaxMs`; a pass that fetched resets
 * it. `maxStall` consecutive no-progress passes give up with the deferrals
 * named in the result — what still defers after that many backoffs is not
 * transient. A throttle stop that fetched nothing counts as a no-progress
 * pass; an outage does not.
 *
 * @param {Object} opts - every `backfill` option, plus:
 * @param {number} [opts.backoffMs=300000] - first backoff
 * @param {number} [opts.backoffMaxMs=1800000] - backoff ceiling
 * @param {number} [opts.maxStall=6] - consecutive no-progress passes → give up
 * @param {number} [opts.maxPasses=Infinity] - hard cap on passes
 * @param {number} [opts.restMs=5000] - pause between two productive passes
 * @param {Object} [opts.deps] - backfill's seams, plus { backfill } itself
 * @returns {Promise<{ converged: boolean, stalled: boolean, passes: number,
 *   totals: { attempted: number, fetched: number, deferred: number, gone: number },
 *   last: Awaited<ReturnType<typeof backfill>> }>}
 */
export async function converge(opts = {}) {
  const {
    backoffMs = 300000,
    backoffMaxMs = 1800000,
    maxStall = 6,
    maxPasses = Infinity,
    restMs = 5000,
    onProgress = () => {},
    deps = {},
    ...passOpts
  } = opts;
  const run = deps.backfill ?? backfill;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const totals = { attempted: 0, fetched: 0, deferred: 0, gone: 0 };
  let backoff = backoffMs;
  let stall = 0;
  let passes = 0;
  let last = null;
  let converged = false;
  let stalled = false;
  const nap = async why => {
    onProgress({ type: 'backoff', reason: why, ms: backoff, pass: passes });
    await sleep(backoff);
    backoff = Math.min(backoff * 2, backoffMaxMs);
  };

  while (passes < maxPasses) {
    // Only the first pass honors `refresh`; the ledger fingerprint keeps the
    // rest honest.
    last = await run({ ...passOpts, refresh: passes === 0 && Boolean(passOpts.refresh), dryRun: false, onProgress, deps });
    passes++;
    const stats = last.stats ?? { attempted: 0, fetched: 0, deferred: 0, gone: 0 };
    totals.attempted += stats.attempted;
    totals.fetched += stats.fetched;
    totals.gone += stats.gone;
    totals.deferred = stats.deferred; // what the LAST pass left pending, not a sum
    onProgress({ type: 'pass', pass: passes, stats, aborted: last.aborted, reason: last.reason });

    if (!last.aborted && (stats.attempted === 0 || (stats.fetched === 0 && stats.deferred === 0))) {
      converged = true;
      break;
    }
    if (passes >= maxPasses) break;
    if (last.aborted) {
      // A throttle stop that fetched nothing is a no-progress pass: it counts
      // toward maxStall, so a block that outlasts the backoffs ends the loop
      // instead of being retried forever. An outage (`unreachable`) does not
      // count: the archive being down is worth waiting out.
      if (last.reason === 'throttled' && stats.fetched === 0) {
        stall++;
        if (stall >= maxStall) {
          stalled = true;
          break;
        }
      } else if (stats.fetched > 0) {
        stall = 0;
      }
      await nap(last.reason ?? 'aborted');
      continue;
    }
    if (stats.fetched === 0) {
      stall++;
      if (stall >= maxStall) {
        stalled = true;
        break;
      }
      await nap('no-progress');
      continue;
    }
    stall = 0;
    backoff = backoffMs;
    if (restMs > 0) await sleep(restMs);
  }
  onProgress({ type: 'converge', converged, stalled, passes, totals });
  return { converged, stalled, passes, totals, last };
}
