// Cache-store fsck — verify a populated cache root against its own sidecars.
//
// The store is its own authority (CACHE.md: "no authoritative index
// anywhere"), so the only thing that can vouch for it is the store itself:
// re-hash every body, re-derive every path, and look for the shapes a crash,
// a bit-flip, or a stray write leaves behind. This is the verify-on-read
// tool the design debate deferred ("a store without a verify command rots
// silently" — the CACHE.md Verification dissent).
//
// LIBRARY-FIRST (thin-CLI rule): all logic lives here; the CLI's
// `cache verify` handler (spv/waybackify-cli/src/commands/cache-verify.js) is
// an arg-parsing + report-printing wrapper. The layout knowledge is a deliberate LOCAL copy of
// cache.js's derivation (walk meta/, hash = basename minus .json, aa =
// hash[0:2], body at cap/<aa>/<hash>) so a later rebase onto shared
// capturePath/metaPath helpers is a cheap swap, not a rewrite.
//
// WHAT IT CHECKS (report-only by default; see CATEGORIES for severities):
//   - malformed     sidecar that will not parse (disk rot, NOT absence —
//                   the rename published a whole fsync'd file or nothing) OR a
//                   structurally-bad `dynamic[]` entry (v3): `dynamic` present
//                   but not an array, or an entry that is not an object / has a
//                   non-string or separatorless `key` / a `flag` outside
//                   {im_,cs_,js_,oe_,null} / a `via` outside {remaster-verify,
//                   manual}. Same trust boundary as a malformed requisite — a
//                   bad entry is surfaced, never silently trusted.
//   - hashMismatch  status 'body' whose contentHash != the SRI of the cap/
//                   bytes — the one thing fsync cannot catch (it persists
//                   what was written, not that the right bytes were written)
//   - keyMismatch   sidecar filed under a hash != sha256hex(sidecar.key)
//                   (misfiled / tampered — readSidecar's authenticity check)
//   - missingBody   status 'body' with no cap/ file (incomplete entry: the
//                   body rename was lost, or a body was deleted out from
//                   under a complete sidecar)
//   - incompleteClosure  a status 'body' doc that lists a page requisite
//                   (im_/cs_/js_/oe_ captureKey in its sidecar.requisites[]) OR
//                   a browser-discovered dynamic child (a well-formed
//                   sidecar.dynamic[].key, v3 — findings marked `dynamic: true`)
//                   whose own sidecar is absent from THIS store. The frontier is
//                   `requisites ∪ dynamic`: a recorded-but-unfetched dynamic
//                   child is exactly as incomplete as a missing requisite. A
//                   non-deterministic tracking beacon (isTrackingBeacon —
//                   per-render-random query strings, un-mirrorable BY
//                   CONSTRUCTION) is EXCLUDED: the crawl already refuses to chase
//                   it, so the gate agrees rather than hold the store dirty on an
//                   asset that can never converge.
//                   Store-relative
//                   — the check reads the doc's own edge list, no ledger and no
//                   network. It is the reason this pass exists: a mirror can be
//                   free of corruption yet serve a page whose asset closure is
//                   short. REPORT ONLY (--fix never touches it — closure is
//                   filled by re-running `cache add`/`cache fill`, not by
//                   deleting anything), but it DOES keep the store dirty (exit
//                   nonzero) until the closure is complete.
//   - interstitialAsBody  a status 'body' entry whose stored bytes are a
//                   wayback interstitial (#363: a wrapper stub, a redirect
//                   interstitial, or a .pdf/.txt served as text/html) — a
//                   pre-schema capture that predates cache-time refusal. REPORT
//                   ONLY: the corpus-wide re-commit is the #364 remediation
//                   sweep, not fsck's to perform.
//   - schemaVersion sidecar whose v is outside the supported set
//   - foreignRoot   an entry in the root that is not cap/ meta/ tmp/ — the
//                   root contract is cap/ + meta/ + tmp/ ONLY (operational
//                   artifacts belong OUTSIDE the store; this is the check
//                   that flags a stray .runs/)
//   - orphanCap     cap/ file with no sidecar (crash between the body and
//                   sidecar renames: ingest garbage, never served)
//   - staleTmp      leftover tmp/ scratch (an interrupted write's .part file)
//
// --fix reaps ONLY the two safe-to-delete classes — orphanCap + staleTmp
// (neither is reachable by any reader: an orphan has no completion token, a
// tmp file was never renamed into place). It NEVER touches a valid entry and
// REFUSES to "fix" a hashMismatch/keyMismatch/missingBody/malformed finding:
// those are corruption to investigate, not garbage to sweep. An
// incompleteClosure finding is likewise never touched — a short closure is
// filled by fetching the missing requisite, never by deleting.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SIDECAR_VERSION, SUPPORTED_SIDECAR_VERSIONS, dynamicEntryError } from './cache.js';
import { isTrackingBeacon } from './beacons.js';
import { captureHash } from './key.js';
import { detectInterstitial } from './interstitial.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { coerceEvery, emitProgress } from './progress.js';

/**
 * Finding categories, in report order. `severity` drives both the printed
 * grouping and --fix: only `reapable` classes are ever deleted.
 * @type {ReadonlyArray<{ key: string, label: string, severity: 'corruption'|'incomplete'|'advisory'|'reapable' }>}
 */
export const CATEGORIES = [
  { key: 'malformed', label: 'malformed sidecar (will not parse)', severity: 'corruption' },
  { key: 'hashMismatch', label: 'contentHash != stored body bytes', severity: 'corruption' },
  { key: 'keyMismatch', label: 'sidecar filed under the wrong hash', severity: 'corruption' },
  { key: 'missingBody', label: "status 'body' with no cap/ file (incomplete)", severity: 'corruption' },
  { key: 'incompleteClosure', label: "status 'body' requisite whose sidecar is absent (closure short)", severity: 'incomplete' },
  { key: 'interstitialAsBody', label: "status 'body' whose bytes are a wayback interstitial (#363)", severity: 'advisory' },
  { key: 'schemaVersion', label: 'sidecar schema version outside the supported set', severity: 'advisory' },
  { key: 'foreignRoot', label: 'root entry outside cap/ meta/ tmp/', severity: 'advisory' },
  { key: 'orphanCap', label: 'cap/ file with no sidecar (ingest garbage)', severity: 'reapable' },
  { key: 'staleTmp', label: 'leftover tmp/ scratch file', severity: 'reapable' }
];

const REAPABLE = new Set(CATEGORIES.filter(c => c.severity === 'reapable').map(c => c.key));

/** readdir that treats a missing directory as empty (a fresh root has no cap/ yet). */
async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * SRI sha256 of a file, streamed (constant memory over a 12k-entry corpus).
 * Same form cache.js writes: `sha256-<base64>`.
 * @param {string} file
 * @returns {Promise<string>}
 */
async function fileSRI(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha256-${hash.digest('base64')}`;
}

/**
 * Walk a `cap/` or `meta/` shard tree: <sub>/<aa>/<name>. Returns the leaf
 * files (aa dir + filename), tolerating a shard dir that holds a stray file.
 * @param {string} root
 * @param {'cap'|'meta'} sub
 * @returns {Promise<Array<{ aa: string, name: string, path: string }>>}
 */
async function walkShards(root, sub) {
  const base = path.join(root, sub);
  const out = [];
  for (const aaEnt of await readdirSafe(base)) {
    if (!aaEnt.isDirectory()) continue;
    const aaDir = path.join(base, aaEnt.name);
    for (const ent of await readdirSafe(aaDir)) {
      if (ent.isFile()) out.push({ aa: aaEnt.name, name: ent.name, path: path.join(aaDir, ent.name) });
    }
  }
  return out;
}

/**
 * fsck a cache root — report by default, reap orphan cap/ + stale tmp/ with
 * `--fix`. Pure read unless `fix` is set; never throws on a bad entry (that
 * entry becomes a finding), only on an unreadable root.
 *
 * @param {string} root - store root (contains cap/, meta/, tmp/)
 * @param {Object} [options]
 * @param {boolean} [options.fix=false] - reap orphan cap/ + stale tmp/
 * @returns {Promise<{
 *   root: string,
 *   schemaVersion: number,
 *   counts: { sidecars: number, bodies: number, capFiles: number, tmpFiles: number },
 *   findings: Record<string, Array<object>>,
 *   reaped: { orphanCap: string[], staleTmp: string[] } | null
 * }>}
 */
export async function fsck(root, options = {}) {
  const { fix = false } = options;
  // Silent-loop progress (design §6): re-hashing every body over a 12k-entry
  // corpus ran dark. A counter + throttled aggregate every N (0 = off).
  const logger = options.logger ?? NOOP_LOGGER;
  const progressEvery = coerceEvery(options.progressEvery);
  const findings = Object.fromEntries(CATEGORIES.map(c => [c.key, []]));

  // ---- foreign root entries -------------------------------------------------
  // The root contract (CACHE.md Layout) is cap/ + meta/ + tmp/ for the store
  // itself — anything else is an operational artifact living where a
  // rebuildable projection should be pure store. Two sibling-command state
  // files are sanctioned exceptions, written INTO the root by design:
  //   .refetch/            `cache fill`'s durable worklist + gone ledger
  //                        (backfill.js) — a resumable bulk fetch's memory.
  //   .crawl/              `cache crawl`'s durable state (verified.jsonl,
  //                        flaky.jsonl, and the optional --har/ dir) — the
  //                        dynamic fixpoint's memory, exactly analogous to
  //                        .refetch/.
  //   remaster.build.json  `remaster build`'s build record (remaster.js
  //                        BUILD_NAME) at a remastered root.
  // fsck must not flag its own sibling commands' state as foreign — else
  // `cache fill`/`cache crawl`/`remaster build` then `cache verify` on that
  // root would report unclean forever (a non-reapable advisory). (Filenames are
  // a deliberate local copy, per this file's layout-knowledge note.)
  const allowed = new Set(['cap', 'meta', 'tmp', '.refetch', '.crawl', 'remaster.build.json']);
  for (const ent of await readdirSafe(root)) {
    if (!allowed.has(ent.name)) {
      findings.foreignRoot.push({ name: ent.name, isDir: ent.isDirectory(), path: path.join(root, ent.name) });
    }
  }

  // ---- inventory: cap/ bodies + tmp/ scratch --------------------------------
  const capFiles = await walkShards(root, 'cap');
  const capHashes = new Set(capFiles.map(f => f.name));

  for (const ent of await readdirSafe(path.join(root, 'tmp'))) {
    findings.staleTmp.push({ name: ent.name, isDir: ent.isDirectory(), path: path.join(root, 'tmp', ent.name) });
  }

  // ---- sidecar sweep (the authority) ---------------------------------------
  const metaFiles = (await walkShards(root, 'meta')).filter(f => f.name.endsWith('.json'));
  const sidecarHashes = new Set();
  // Body docs + their requisite edge lists, collected during the sweep and
  // checked for closure AFTER sidecarHashes is complete (a requisite may be
  // filed under any shard, walked before or after its referrer).
  const bodyDocs = [];
  let bodies = 0;
  let scanned = 0;

  for (const { aa, name, path: metaPath } of metaFiles) {
    const hash = name.slice(0, -'.json'.length);
    sidecarHashes.add(hash);

    scanned++;
    emitProgress(logger, progressEvery, scanned, 'fsck-progress', `cache verify: ${scanned}/${metaFiles.length} sidecars`, { total: metaFiles.length });

    let sidecar;
    try {
      sidecar = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch (error) {
      findings.malformed.push({ hash, aa, path: metaPath, error: error.message });
      continue;
    }

    if (!SUPPORTED_SIDECAR_VERSIONS.has(sidecar.v)) {
      findings.schemaVersion.push({ hash, aa, key: sidecar.key ?? null, v: sidecar.v ?? null });
    }

    // Filed under the wrong hash? sha256hex(key) IS the on-disk name; a
    // divergence is a misfiled or tampered sidecar (readSidecar's check).
    if (typeof sidecar.key === 'string') {
      const derived = await captureHash(sidecar.key);
      if (derived !== hash) findings.keyMismatch.push({ hash, aa, key: sidecar.key, derived });
    }

    // ---- v3 dynamic[] validation (same trust boundary as requisites) ------
    // `dynamic` present but not an array is one malformed finding; an array is
    // validated entry-by-entry. Only entries that PASS feed the closure check
    // below — a malformed entry is surfaced, never trusted into the frontier.
    const dynamicKeys = [];
    if (sidecar.dynamic !== undefined) {
      if (!Array.isArray(sidecar.dynamic)) {
        findings.malformed.push({ hash, aa, key: sidecar.key ?? null, path: metaPath, error: 'dynamic is not an array' });
      } else {
        // The SAME predicate recordDynamic throws on — one shared definition,
        // so a bad entry the writer would reject is exactly what fsck flags.
        sidecar.dynamic.forEach((entry, index) => {
          const why = dynamicEntryError(entry);
          if (why) {
            findings.malformed.push({ hash, aa, key: sidecar.key ?? null, path: metaPath, error: `malformed dynamic entry: ${why}`, index });
          } else {
            dynamicKeys.push(entry.key);
          }
        });
      }
    }

    if (sidecar.status === 'body') {
      bodies++;
      // Record this doc's requisite + dynamic closure for the store-relative
      // check below. Only well-formed dynamic keys (validated above) are carried.
      bodyDocs.push({
        hash,
        aa,
        key: sidecar.key ?? null,
        requisites: Array.isArray(sidecar.requisites) ? sidecar.requisites : [],
        dynamic: dynamicKeys
      });
      const capPath = path.join(root, 'cap', aa, hash);
      if (!capHashes.has(hash)) {
        findings.missingBody.push({ hash, aa, key: sidecar.key ?? null });
      } else {
        const actual = await fileSRI(capPath);
        if (actual !== sidecar.contentHash) {
          findings.hashMismatch.push({ hash, aa, key: sidecar.key ?? null, expected: sidecar.contentHash ?? null, actual });
        }
        // interstitial-as-body (#363): a pre-schema `status:body` capture whose
        // bytes are a wayback interstitial. Read the body only for html-ish
        // entries (the sole ones a body-shape signature can match); the
        // extension signature needs no body. Offline — no CDX injected here.
        const htmlish = !sidecar.contentType || /html|xhtml/i.test(sidecar.contentType);
        const body = htmlish ? await fsp.readFile(capPath) : null;
        const detection = detectInterstitial({ key: sidecar.key, contentType: sidecar.contentType, body });
        if (detection) {
          findings.interstitialAsBody.push({
            hash,
            aa,
            key: sidecar.key ?? null,
            signature: detection.signature,
            ...(detection.target ? { target: detection.target } : {})
          });
        }
      }
    }
  }

  // ---- orphan cap/ files (body present, no completion token) ----------------
  for (const f of capFiles) {
    if (!sidecarHashes.has(f.name)) findings.orphanCap.push({ hash: f.name, aa: f.aa, path: f.path });
  }

  // ---- requisite closure (store-relative — the doc's own edge list) ---------
  // Every body doc names its page requisites in sidecar.requisites[] (verbatim
  // captureKeys). A mirror is only self-contained if each of those requisites
  // has its OWN sidecar in this store. This reads no ledger and touches no
  // network — the doc's edge list IS the closure spec — so it holds for a
  // single-page `cache add` root as much as a whole-ledger `cache fill` one.
  // One finding per missing requisite (a doc short three assets is three
  // findings), each keeping the store dirty.
  for (const doc of bodyDocs) {
    // The frontier is the DEDUPED union `requisites ∪ dynamic`: a key in both
    // (or repeated within either) yields exactly ONE finding. Requisites are
    // walked first, so a key shared with dynamic is attributed to the requisite
    // (no `dynamic: true`); a key SOLELY in dynamic — a recorded-but-unfetched
    // browser child, exactly as `incomplete` as a missing requisite — is marked
    // `dynamic: true` so a reader can tell them apart.
    const seen = new Set();
    for (const childKey of doc.requisites) {
      if (seen.has(childKey)) continue;
      seen.add(childKey);
      // A non-deterministic tracking beacon (per-render-random query strings) is
      // un-mirrorable BY CONSTRUCTION, so its absent sidecar is never a closure
      // gap. The crawl (mapkeys) already refuses to chase these into the
      // frontier; the gate MUST agree or a beacon keeps the store dirty forever.
      // The key is `<ts>/<original>` — test the original exactly as crawl does.
      if (isTrackingBeacon(childKey.slice(childKey.indexOf('/') + 1))) continue;
      const childHash = await captureHash(childKey);
      if (!sidecarHashes.has(childHash)) {
        findings.incompleteClosure.push({ hash: doc.hash, aa: doc.aa, key: doc.key, child: childKey, childHash });
      }
    }
    for (const childKey of doc.dynamic) {
      if (seen.has(childKey)) continue;
      seen.add(childKey);
      // Same beacon exemption as requisites: a browser-discovered dynamic beacon
      // is un-mirrorable, so its missing sidecar is not `incompleteClosure`.
      if (isTrackingBeacon(childKey.slice(childKey.indexOf('/') + 1))) continue;
      const childHash = await captureHash(childKey);
      if (!sidecarHashes.has(childHash)) {
        findings.incompleteClosure.push({ hash: doc.hash, aa: doc.aa, key: doc.key, child: childKey, childHash, dynamic: true });
      }
    }
  }

  // ---- --fix: reap ONLY the safe classes ------------------------------------
  let reaped = null;
  if (fix) {
    reaped = { orphanCap: [], staleTmp: [] };
    for (const category of REAPABLE) {
      for (const f of findings[category]) {
        try {
          await fsp.rm(f.path, { recursive: true, force: true });
          reaped[category].push(f.path);
        } catch (error) {
          // A reap that fails (permissions, race) stays a finding — surface it.
          f.reapError = error.message;
        }
      }
    }
  }

  return {
    root,
    schemaVersion: SIDECAR_VERSION,
    counts: { sidecars: metaFiles.length, bodies, capFiles: capFiles.length, tmpFiles: findings.staleTmp.length },
    findings,
    reaped
  };
}

/**
 * Total findings across every category (what a report-only run flags).
 * @param {{ findings: Record<string, Array<object>> }} report
 * @returns {number}
 */
export function totalFindings(report) {
  return CATEGORIES.reduce((n, c) => n + report.findings[c.key].length, 0);
}

/**
 * Findings still standing after any reap — corruption/advisory always count,
 * reaped classes drop by however many were successfully removed. This is the
 * exit-status signal: 0 iff the store is clean (or made clean by --fix).
 * @param {{ findings: Record<string, Array<object>>, reaped: object | null }} report
 * @returns {number}
 */
export function unresolvedFindings(report) {
  const reaped = report.reaped ? report.reaped.orphanCap.length + report.reaped.staleTmp.length : 0;
  return totalFindings(report) - reaped;
}
