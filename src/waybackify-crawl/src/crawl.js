/**
 * The crawl fixpoint (design "The fixpoint — normative algorithm", §C2/§D3).
 *
 *   fetch (static bulk pass) → serve LOCALIZED, report-only → probe the
 *   dynamic tier → map its leaks to captureKeys → recordDynamic → refetch,
 *   until a browser render makes ZERO unexpected web.archive.org requests.
 *
 * The gate is completeness the deployed strict CSP actually enforces: a doc is
 * complete iff its rendered probe requests nothing off-host that the
 * allowed-escapes policy does not sanction. `remaster verify`'s dynamic tier IS
 * the probe (src/probe.js drives it); its `dangling-local` + missing-wayback
 * `non-local` findings are the worklist, its genuinely third-party `non-local`
 * findings the allowlist input.
 *
 * Durability & resume: recordDynamic writes the worklist BEFORE the refetch, so
 * a crash resumes straight into the frontier (cacheCapture's frontier =
 * `requisites ∪ dynamic`). The core (spv/waybackify) owns the facts; this
 * package owns the loop, the run ledgers (`<root>/.crawl/`), and the policy.
 *
 * `crawl(urls, { root, deps })` takes injectable `deps.{ serve, probe,
 * cacheCapture, recordDynamic, readSidecar, loadCorpus }` so the fixpoint
 * unit-tests against a fake probe (findings fixtures) + an in-memory store with
 * zero network and zero browser.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyContentType } from '@charlie.dev/waybackify/rewrite.js';
import {
  cacheCapture as coreCacheCapture,
  recordDynamic as coreRecordDynamic,
  readSidecar as coreReadSidecar,
  dynamicEntryError,
  SIDECAR_VERSION
} from '@charlie.dev/waybackify/cache.js';
import { RULE_VERSION } from '@charlie.dev/waybackify/rewrite.js';
import { captureKey } from '@charlie.dev/waybackify/key.js';
import { parseWaybackUrl } from '@charlie.dev/waybackify/audit.js';
import { WaybackMachine } from '@charlie.dev/waybackify';
import { serveCacheRoot } from '@charlie.dev/waybackify-serve/node';
import { loadCorpusKeySet } from '@charlie.dev/waybackify-serve/corpus';
import { compilePolicy } from './policy.js';
import { isTrackingBeacon, mapFindings } from './mapkeys.js';
import { createBrowserProbe } from './probe.js';
import { ensureCrawlDir, verifiedKeys, stampVerified, invalidateVerified, recordFlaky, writeHar } from './ledger.js';

/** Raised when the per-dispatch archive.org request cap is reached. */
export class CapReachedError extends Error {
  constructor(count, cap) {
    super(`archive.org request cap reached (${count}/${cap})`);
    this.name = 'CapReachedError';
    this.count = count;
    this.cap = cap;
  }
}

/* ------------------------------------------------------------------------ *
 * Default (real) deps — the live wiring
 * ------------------------------------------------------------------------ */

async function defaultServe({ root, localize, cspMode }) {
  const running = await serveCacheRoot({ root, port: 0, localize, cspMode });
  return {
    url: running.url,
    close: () => new Promise((resolve, reject) => running.server.close(err => (err ? reject(err) : resolve())))
  };
}

const defaultDeps = {
  serve: defaultServe,
  probe: undefined, // built per-run from browserCmd (createBrowserProbe)
  cacheCapture: coreCacheCapture,
  recordDynamic: coreRecordDynamic,
  readSidecar: coreReadSidecar,
  loadCorpus: loadCorpusKeySet
};

/**
 * Enumerate the HTML document captureKeys a cache root holds, in stable key
 * order — the corpus-batch worklist and the acceptance sample source. Reads
 * every `<root>/meta/<aa>/*.json` sidecar and keeps the `status:'body'` HTML
 * ones. Defensive: an unreadable/unparseable sidecar is skipped, not fatal.
 *
 * @param {string} root
 * @returns {Promise<string[]>} sorted captureKeys of HTML documents
 */
export async function enumerateHtmlDocKeys(root) {
  const metaDir = path.join(root, 'meta');
  const keys = [];
  let shards;
  try {
    shards = await fsp.readdir(metaDir);
  } catch {
    return keys;
  }
  for (const aa of shards.sort()) {
    let files;
    try {
      files = await fsp.readdir(path.join(metaDir, aa));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const sidecar = JSON.parse(await fsp.readFile(path.join(metaDir, aa, file), 'utf8'));
        if (sidecar.status === 'body' && classifyContentType(sidecar.contentType) === 'html' && typeof sidecar.key === 'string') {
          keys.push(sidecar.key);
        }
      } catch {
        /* skip a torn/foreign sidecar */
      }
    }
  }
  return keys.sort();
}

/** Map an input wayback URL (or bare key) to `{ url, key }`. */
export function toDoc(input) {
  const parsed = parseWaybackUrl(input);
  if (parsed) return { url: input, key: captureKey(parsed.timestamp, parsed.original) };
  // Accept a bare captureKey `<ts>/<orig>` too (the corpus-batch caller has keys).
  const sep = input.indexOf('/');
  if (sep > 0 && sep < input.length - 1) {
    const ts = input.slice(0, sep);
    const orig = input.slice(sep + 1);
    if (/^\d{4,14}$/.test(ts)) return { url: `https://web.archive.org/web/${ts}/${orig}`, key: input };
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The fixpoint
 * ------------------------------------------------------------------------ */

/**
 * Crawl one or more documents to the fixpoint.
 *
 * @param {string[]} urls - wayback replay URLs (or bare captureKeys).
 * @param {object} options
 * @param {string} options.root - cache root (REQUIRED; must already hold the docs).
 * @param {number} [options.maxIterations=4] - reference-depth cap per doc.
 * @param {boolean} [options.force=false] - re-probe even verified docs.
 * @param {boolean} [options.staticOnly=false] - skip the browser probe; run only
 *   the static bulk pass (closes ALREADY-recorded dynamic[]). Loud: completeness
 *   is NOT verified. The caller warns; this flag just gates the probe.
 * @param {boolean} [options.dryRun=false] - enumerate each doc's recorded
 *   frontier (requisites ∪ well-formed dynamic) and report which children are
 *   absent (`status: 'dry-run'`, `wouldFetch`, `keys`); fetch, probe, and write
 *   NOTHING. Reports the recorded frontier only — new dynamic discovery needs a
 *   real probe.
 * @param {object} [options.policy] - compiled allowed-escapes policy (match(url)).
 * @param {number} [options.maxRequests=Infinity] - archive.org request cap.
 * @param {number} [options.delayMs=1500] - pacing between captures.
 * @param {(e: object) => void} [options.onProgress]
 * @param {() => string} [options.now] - ISO clock (deterministic tests).
 * @param {object} [options.deps] - injectable { serve, probe, cacheCapture,
 *   recordDynamic, readSidecar, loadCorpus }.
 * @param {string} [options.browserCmd='agent-browser']
 * @param {boolean} [options.har=false] - write per-doc request logs to .crawl/har/.
 * @returns {Promise<{ requestCount: number, cap: number, results: object[] }>}
 */
export async function crawl(urls, options = {}) {
  const {
    root,
    maxIterations = 4,
    force = false,
    staticOnly = false,
    dryRun = false,
    policy = compilePolicy({ escapes: [] }),
    maxRequests = Infinity,
    delayMs = 1500,
    onProgress = () => {},
    now = () => new Date().toISOString(),
    browserCmd = 'agent-browser',
    har = false
  } = options;
  if (!root) throw new TypeError('crawl: options.root is required');
  // Bound the loop, hard. `Number('Infinity')` is a real number (not NaN), so a
  // bare NaN check would let `--max-iterations Infinity` disable the ONLY
  // termination bound and let a cache-busting page spin forever. Require a
  // finite, non-negative integer here AND in the CLI.
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
    throw new TypeError(`crawl: maxIterations must be a non-negative integer, got ${maxIterations}`);
  }
  if (maxRequests !== Infinity && (!Number.isSafeInteger(maxRequests) || maxRequests < 0)) {
    throw new TypeError(`crawl: maxRequests must be a non-negative integer (or omitted), got ${maxRequests}`);
  }

  const deps = { ...defaultDeps, ...(options.deps ?? {}) };
  const probe = deps.probe ?? createBrowserProbe({ browserCmd, onProgress: line => onProgress({ type: 'probe', line }) });
  const { cacheCapture, recordDynamic, readSidecar, loadCorpus, serve } = deps;

  // Parse + de-duplicate inputs by capture key, first occurrence wins (a doc
  // passed twice must not cost two probes / two archive budgets).
  const docs = [];
  const seenKeys = new Set();
  for (const input of urls) {
    const doc = toDoc(input);
    if (!doc) {
      onProgress({ type: 'skip', reason: 'unparseable-input', input });
      continue;
    }
    if (seenKeys.has(doc.key)) continue;
    seenKeys.add(doc.key);
    docs.push(doc);
  }

  await ensureCrawlDir(root, { har });
  // Read the prior verified set regardless of --force: without --force it drives
  // the fast-path skip; WITH --force it drives the invalidation tombstone so a
  // re-probe that does not re-verify cannot leave a stale claim standing.
  const priorVerified = await verifiedKeys(root, RULE_VERSION);
  const verified = force ? new Set() : priorVerified;

  // One archive.org client + a counting fetch for the whole run (shared session
  // is gentler on the IA; the count is the exact request tally for the cap).
  const wayback = new WaybackMachine({ timeout: 60000 });
  let requestCount = 0;
  // Enforce the cap AT THE FETCH SEAM, not just between docs: cacheCapture fans
  // a doc's whole frontier out in one loop, so a between-docs check alone could
  // overshoot a small cap by a whole requisite set. Throwing here means the
  // request is never issued — the archive.org ceiling is authoritative. A throw
  // on a requisite fetch is caught by cacheCapture into summary.failures (retried
  // next run, nothing committed); a throw on the doc fetch propagates to
  // crawlDoc, which marks the doc cap-skipped.
  const countingFetch = async url => {
    if (requestCount >= maxRequests) throw new CapReachedError(requestCount, maxRequests);
    requestCount++;
    return wayback.impit.fetch(url);
  };

  // The live corpus key-set the localize server rewrites against. Mutated in
  // place as captures land so the SAME server localizes newly-fetched children
  // on the next probe (no restart).
  const corpus = await loadCorpus(root);

  const results = [];

  // --dry-run: enumerate each doc's ALREADY-recorded frontier (requisites ∪
  // well-formed dynamic children) and report which children are absent — the
  // exact set a real run would fetch — without touching the network, the
  // browser, or the store. Mirrors `cache fill --dry-run` (build/show the
  // worklist, fetch nothing). It reports the RECORDED frontier ONLY: discovering
  // NEW dynamic requisites needs a live probe, so a dry-run never renders.
  if (dryRun) {
    for (const doc of docs) {
      const sidecar = await readSidecar(root, doc.key);
      if (!sidecar) {
        results.push({ key: doc.key, status: 'dry-run', present: false, frontier: 0, wouldFetch: 0, keys: [] });
        continue;
      }
      const requisites = Array.isArray(sidecar.requisites) ? sidecar.requisites : [];
      // Same well-formedness filter cacheCapture applies to the fetch frontier
      // (dynamicEntryError) so the count matches what a real run would attempt.
      const dynamicKeys = (Array.isArray(sidecar.dynamic) ? sidecar.dynamic : [])
        .filter(d => !dynamicEntryError(d))
        .map(d => d.key);
      const frontier = [...new Set([...requisites, ...dynamicKeys])];
      const wouldFetch = [];
      for (const childKey of frontier) {
        if (!(await readSidecar(root, childKey))) wouldFetch.push(childKey);
      }
      results.push({ key: doc.key, status: 'dry-run', present: true, frontier: frontier.length, wouldFetch: wouldFetch.length, keys: wouldFetch });
      onProgress({ type: 'dry-run', key: doc.key, frontier: frontier.length, wouldFetch: wouldFetch.length });
    }
    return { requestCount: 0, cap: maxRequests, results };
  }

  // --static-only: no server, no browser — just close each doc's ALREADY
  // recorded frontier. Completeness is not verified; the caller warns.
  if (staticOnly) {
    for (const doc of docs) {
      if (requestCount >= maxRequests) {
        results.push({ key: doc.key, status: 'cap-skipped' });
        continue;
      }
      try {
        const summary = await cacheCapture(doc.url, { root, fetch: countingFetch, onEntry: addCommitted });
        results.push({ key: doc.key, status: 'static', fetched: summary.fetched, failures: summary.failures.length });
      } catch (error) {
        if (error instanceof CapReachedError) results.push({ key: doc.key, status: 'cap-skipped', error: error.message });
        else results.push({ key: doc.key, status: 'error', error: error?.message ?? String(error) });
      }
      if (delayMs) await sleep(delayMs);
    }
    return { requestCount, cap: maxRequests, results };
  }

  // The verified fast-path is truly free: a doc whose stamp is valid is answered
  // WITHOUT booting a server, opening a browser, or touching the network. Only
  // when there is uncached work do we require a browser (fail LOUD if absent)
  // and boot the server + probe.
  const toProbe = docs.filter(doc => !verified.has(doc.key));
  for (const doc of docs) {
    if (verified.has(doc.key)) results.push({ key: doc.key, status: 'verified-cached' });
  }
  if (toProbe.length === 0) {
    return { requestCount, cap: maxRequests, results };
  }
  if (!probe.available()) {
    throw new Error(
      'agent-browser not available: the dynamic probe cannot run, so completeness ' +
        'cannot be verified. Install agent-browser, or re-run with --static-only.'
    );
  }

  const server = await serve({ root, localize: corpus, cspMode: 'report-only' });
  try {
    await probe.open();
    for (const doc of toProbe) {
      if (requestCount >= maxRequests) {
        results.push({ key: doc.key, status: 'cap-skipped' });
        continue;
      }
      // --force re-probe of a previously-verified doc: invalidate the old claim
      // FIRST (crash-safe), so a re-probe that does not re-verify cannot leave a
      // stale "verified" as the latest ledger row.
      if (force && priorVerified.has(doc.key)) await invalidateVerified(root, doc.key);
      try {
        results.push(
          await crawlDoc(doc, {
            root,
            corpus,
            maxIterations,
            policy,
            now,
            har,
            onProgress,
            serverUrl: server.url,
            probe,
            cacheCapture,
            recordDynamic,
            readSidecar,
            countingFetch,
            addCommitted,
            delayMs,
            getCount: () => requestCount,
            maxRequests
          })
        );
      } catch (error) {
        if (error instanceof CapReachedError) {
          results.push({ key: doc.key, status: 'cap-skipped', error: error.message });
        } else {
          results.push({ key: doc.key, status: 'error', error: error?.message ?? String(error) });
        }
      }
    }
  } finally {
    await probe.close();
    await server.close();
  }
  return { requestCount, cap: maxRequests, results };

  // Add every child that now has a sidecar (body OR terminal) to the live
  // corpus set — the next probe then sees it as a corpus HIT / localizes it,
  // never re-flagging it as a leak. Failed (transient, no sidecar) children are
  // NOT added: they must re-leak next iteration and be retried.
  function addCommitted(entry) {
    if (entry && typeof entry.key === 'string' && entry.action !== 'failed') corpus.add(entry.key);
  }
}

/** One document to its fixpoint. See the module header for the algorithm. */
async function crawlDoc(doc, ctx) {
  const {
    root,
    corpus,
    maxIterations,
    policy,
    now,
    har,
    onProgress,
    serverUrl,
    probe,
    cacheCapture,
    recordDynamic,
    readSidecar,
    countingFetch,
    addCommitted,
    delayMs,
    getCount,
    maxRequests
  } = ctx;

  const capGuard = () => {
    if (getCount() >= maxRequests) throw new CapReachedError(getCount(), maxRequests);
  };

  // 1. Static bulk pass. On a cached doc this is local-only (closes any
  //    previously-recorded dynamic[] frontier); on a fresh doc it fetches.
  const first = await cacheCapture(doc.url, { root, fetch: countingFetch, onEntry: addCommitted });
  onProgress({ type: 'capture', key: doc.key, fetched: first.fetched, iter: 0 });

  // Every dynamic child EVER recorded for this doc (prior runs + this run) that
  // does not yet have a sidecar is UNRESOLVED — recorded-but-unfetched. A doc is
  // not complete while any recorded child is unresolved, even if the browser has
  // since STOPPED requesting it (nondeterministic JS): fsck's closure would flag
  // it, so verifying it would contradict the very stamp. Seed from the doc's
  // existing dynamic[] so a prior run's failed fetch also blocks verification.
  const recordedKeys = new Set();
  const docSidecar = await readSidecar(root, doc.key);
  for (const d of Array.isArray(docSidecar?.dynamic) ? docSidecar.dynamic : []) {
    if (!d || typeof d.key !== 'string') continue;
    // A recorded tracking-beacon key is un-fetchable by construction: a prior
    // run recorded a per-render-random GA/ad pixel (e.g. `.../__utm.gif?utmn=…`)
    // that no capture exists for, so it never gets a sidecar → it would strand
    // this doc as permanently `unresolved` (blocking completeness) even though
    // the browser has since stopped requesting it. The persisted entry shape is
    // `{ key, flag, via, firstSeen? }` — no original-url field — so recover the
    // original from the key (`<ts>/<original>`, the ts having no slash) and skip
    // beacons HERE at the seed, before they can enter recordedKeys → unresolved
    // (mirrors the mapFindings drop that keeps NEW beacons off the frontier).
    if (isTrackingBeacon(d.key.slice(d.key.indexOf('/') + 1))) continue;
    recordedKeys.add(d.key);
  }

  let dynamicCount = 0;
  let iter = 0;

  while (true) {
    // 3a. probe the dynamic tier over the localized server.
    const findings = await probe.render(serverUrl, doc.key, corpus);

    // 3b. Fail CLOSED on a no-evidence render. A real render issues at least the
    //     top-level document request, so zero observed requests means navigation
    //     or log collection failed under the tolerant runner — an empty finding
    //     set that must NEVER read as "clean".
    if (findings.observed === 0) {
      await recordFlaky(root, { key: doc.key, at: now(), reason: 'probe-error', iterations: iter });
      return { key: doc.key, status: 'probe-error', iterations: iter, dynamicRecorded: dynamicCount };
    }

    const mapped = mapFindings(
      { dangling: findings.dangling, nonLocal: findings.nonLocal },
      { now, log: line => onProgress({ type: 'drop', key: doc.key, line }) }
    );
    const unmatchedEscapes = mapped.escapes.filter(e => !policy.match(e.url));
    const matchedEscapes = mapped.escapes.filter(e => policy.match(e.url));
    // Fail-closed residuals: an unparseable candidate the crawler cannot prove
    // harmless, and a non-`/web/` archive.org chrome URL (an actual, if aborted,
    // web.archive.org request under the strict CSP). Neither is a key we can
    // fetch our way out of, so both block verification and force a visible flaky.
    const hardResidual = [...mapped.chrome, ...mapped.unparseable];

    // A non-empty `findings.csp` is a fail-closed residual: the archived doc's
    // own `<meta http-equiv="Content-Security-Policy">` refused a (foreign
    // Wayback) asset, so the browser never issued the request — it appears in NO
    // request log, only as a CSP violation. The CSP-violation target strings are
    // inconsistent, so we do NOT parse them into the worklist (that would risk a
    // fabricated key); instead the doc is genuinely incomplete → block
    // verification and force a visible flaky (`csp-residual`, carrying the
    // messages).
    const cspResidual = Array.isArray(findings.csp) ? findings.csp : [];

    // 3c. worklist = FRESH missing keys (no sidecar, never recorded). A missing
    //     key that already has a sidecar (body OR terminal) is held/archive-
    //     absent — excluded, never looped. A missing key already recorded shows
    //     up as UNRESOLVED below, not as new work.
    const worklist = [];
    for (const entry of mapped.entries) {
      if (recordedKeys.has(entry.key)) continue;
      const sidecar = await readSidecar(root, entry.key);
      if (sidecar) continue;
      worklist.push(entry);
    }

    // 3d. Recompute unresolved: recorded children still lacking a sidecar.
    const unresolved = [];
    for (const key of recordedKeys) {
      if ((await readSidecar(root, key)) === null) unresolved.push(key);
    }

    if (har) {
      await writeHar(root, `${doc.key}#${iter}`, {
        key: doc.key,
        iter,
        observed: findings.observed,
        requests: findings.requests,
        csp: findings.csp,
        worklist: worklist.map(e => e.key),
        unresolved,
        hardResidual,
        allowedEscapes: matchedEscapes.map(e => e.url),
        unmatchedEscapes: unmatchedEscapes.map(e => e.url)
      });
    }

    // 3e. FIXPOINT — nothing new to fetch, every recorded child resolved, no
    //     unsanctioned escape, no unprovable/chrome residual → zero unexpected
    //     web.archive.org requests. Matched escapes are expected (reported,
    //     non-failing). Stamp verified.
    if (
      worklist.length === 0 &&
      unresolved.length === 0 &&
      unmatchedEscapes.length === 0 &&
      hardResidual.length === 0 &&
      cspResidual.length === 0
    ) {
      await stampVerified(root, {
        key: doc.key,
        at: now(),
        iterations: iter,
        dynamicCount,
        allowedEscapes: matchedEscapes.length,
        ruleVersion: RULE_VERSION,
        sidecarV: SIDECAR_VERSION
      });
      return {
        key: doc.key,
        status: 'verified',
        iterations: iter,
        dynamicRecorded: dynamicCount,
        allowedEscapes: matchedEscapes.length
      };
    }

    // 3f. No NEW keys to fetch, yet the doc is not complete → no progress is
    //     possible by fetching (a fetch that keeps failing, an unmatched
    //     third-party escape, an unprovable/chrome residual, or nondeterministic
    //     JS adding no new key). Ledger it, visible, and stop THIS doc.
    if (worklist.length === 0) {
      const reason =
        cspResidual.length > 0
          ? 'csp-residual'
          : hardResidual.length > 0
            ? 'unexpected-archive-request'
            : unresolved.length > 0
              ? 'no-progress'
              : 'unmatched-escapes';
      await recordFlaky(root, {
        key: doc.key,
        at: now(),
        reason,
        iterations: iter,
        residualMissing: unresolved,
        residualEscapes: unmatchedEscapes.map(e => e.url),
        residualHard: hardResidual,
        residualCsp: cspResidual
      });
      return {
        key: doc.key,
        status: 'flaky',
        iterations: iter,
        dynamicRecorded: dynamicCount,
        residualMissing: unresolved.length,
        residualEscapes: unmatchedEscapes.length,
        residualHard: hardResidual.length,
        residualCsp: cspResidual.length
      };
    }

    // 3g. depth cap — reached only with genuine NEW work still pending.
    if (iter >= maxIterations) {
      await recordFlaky(root, {
        key: doc.key,
        at: now(),
        reason: 'unconverged',
        iterations: iter,
        residualMissing: [...new Set([...worklist.map(e => e.key), ...unresolved])],
        residualEscapes: unmatchedEscapes.map(e => e.url)
      });
      return {
        key: doc.key,
        status: 'unconverged',
        iterations: iter,
        dynamicRecorded: dynamicCount,
        residualMissing: worklist.length + unresolved.length,
        residualEscapes: unmatchedEscapes.length
      };
    }

    // 3h. record BEFORE fetch (crash-resume via the frontier), then refetch
    //     exactly the new keys.
    await recordDynamic(root, doc.key, worklist);
    for (const entry of worklist) recordedKeys.add(entry.key);
    dynamicCount += worklist.length;

    capGuard();
    const cap = await cacheCapture(doc.url, { root, fetch: ctx.countingFetch, onEntry: addCommitted });
    onProgress({ type: 'capture', key: doc.key, fetched: cap.fetched, iter: iter + 1, recorded: worklist.length });
    iter++;
    if (delayMs) await sleep(delayMs);
  }
}
