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
// `cache verify` handler (src/waybackify-cli/src/commands/cache-verify.js) is
// an arg-parsing + report-printing wrapper. It walks meta/ (hash = basename
// minus .json, aa = hash[0:2]) and locates each body through key.js#bodyPath
// (cap/<dd>/<digest>, the digest that sidecar.contentHash records). Bodies
// are content-addressed, so one cap/ file can serve many sidecars.
//
// WHAT IT CHECKS (report-only by default; see CATEGORIES for severities):
//   - malformed     sidecar that will not parse (disk rot, NOT absence —
//                   the rename published a whole fsync'd file or nothing) OR a
//                   structurally-bad `dynamic[]` entry (v3): `dynamic` present
//                   but not an array, or an entry that is not an object / has a
//                   non-string or separatorless `key` / a `flag` outside
//                   {im_,cs_,js_,oe_,null} / a `via` outside {remaster-verify,
//                   manual}. Same trust boundary as a malformed requisite — a
//                   bad entry is surfaced, never silently trusted. A `status`
//                   outside {body,empty,redirect,error,interstitial} is also
//                   malformed: such a sidecar cannot say whether it owns a body.
//                   So is a bodiless status that carries contentHash or
//                   contentLength (the schema says present iff status body):
//                   that is a body sidecar whose status rotted, and its body
//                   is on disk unnamed.
//   - hashMismatch  status 'body' whose contentHash != the SRI of the cap/
//                   bytes — the one thing fsync cannot catch (it persists
//                   what was written, not that the right bytes were written)
//   - sizeMismatch  status 'body' whose contentLength != the size of the cap/
//                   file its contentHash names. A sidecar that names another
//                   capture's body shows up here (the digests match by
//                   construction, the sizes rarely do).
//   - keyMismatch   sidecar filed under a hash != sha256hex(sidecar.key)
//                   (misfiled / tampered — readSidecar's authenticity check)
//   - missingBody   status 'body' with no cap/ file at its contentHash
//                   (incomplete entry: the body rename was lost, or a body
//                   was deleted out from under a complete sidecar), or with
//                   a contentHash that is not a sha256 SRI digest
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
//   - schemaVersion sidecar whose v is not the current SIDECAR_VERSION
//   - foreignRoot   an entry in the root that is not cap/ meta/ tmp/ — the
//                   root contract is cap/ + meta/ + tmp/ ONLY (operational
//                   artifacts belong OUTSIDE the store; this is the check
//                   that flags a stray .runs/)
//   - orphanCap     cap/ file that no sidecar's contentHash names (crash
//                   between the body and sidecar renames: ingest garbage,
//                   never served). Reported ONLY when every sidecar proves
//                   its ownership (see OWNERSHIP PROOF below).
//   - staleTmp      leftover tmp/ scratch (an interrupted write's .part file)
//
// OWNERSHIP PROOF: a cap/ file is an orphan only when fsck can prove that no
// sidecar names it. The proof needs every sidecar in the root to parse, to
// carry a known status, and (for status 'body') to name a cap/ file whose
// bytes match its contentHash and whose size equals its contentLength. A
// sidecar that fails any of those checks is a finding (malformed,
// missingBody, hashMismatch, sizeMismatch, or schemaVersion), and it
// suspends orphan detection for the whole run.
//
// QUARANTINE, NOT DELETION: the proof is not complete. Two rot shapes pass it
// and leave a body unnamed: a contentHash rotted to another live body of the
// same size, and a status rotted to a bodiless value that also drops
// contentHash and contentLength. No check can see either one. So --fix never
// deletes a body file. It MOVES each orphan into the quarantine directory
// trash/<run>/cap/<dd>/<digest> inside the root (same filesystem, one
// rename), keeps the relative path, and reports each move. A later run never
// scans trash/ as live content. An operator restores a body by moving it back
// to cap/<dd>/<digest>, and empties the quarantine with `cache verify
// --empty-trash` (emptyTrash below). Stale tmp/ files are still deleted: a
// tmp file was never renamed into place, so nothing can name it.
//
// --fix acts ONLY on the two reapable classes — orphanCap (moved) + staleTmp
// (deleted). Neither is reachable by any reader: an orphan has no completion
// token, a tmp file was never published. It NEVER touches a valid entry and
// REFUSES to "fix" a hashMismatch/sizeMismatch/keyMismatch/missingBody/
// malformed finding: those are corruption to investigate, not garbage to
// sweep. An incompleteClosure finding is likewise never touched — a short
// closure is filled by fetching the missing requisite, never by deleting.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SIDECAR_VERSION, dynamicEntryError, isSidecarObject } from './cache.js';
import { isUnmirrorable } from './beacons.js';
import { bodyPath, captureHash } from './key.js';
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
  { key: 'sizeMismatch', label: 'contentLength != stored body size', severity: 'corruption' },
  { key: 'keyMismatch', label: 'sidecar filed under the wrong hash', severity: 'corruption' },
  { key: 'missingBody', label: "status 'body' with no cap/ file (incomplete)", severity: 'corruption' },
  { key: 'incompleteClosure', label: "status 'body' requisite whose sidecar is absent (closure short)", severity: 'incomplete' },
  { key: 'interstitialAsBody', label: "status 'body' whose bytes are a wayback interstitial (#363)", severity: 'advisory' },
  { key: 'schemaVersion', label: 'sidecar schema version is not the current version', severity: 'advisory' },
  { key: 'foreignRoot', label: 'root entry outside cap/ meta/ tmp/', severity: 'advisory' },
  { key: 'orphanCap', label: 'cap/ file with no sidecar (ingest garbage; --fix moves it to trash/)', severity: 'reapable' },
  { key: 'staleTmp', label: 'leftover tmp/ scratch file', severity: 'reapable' }
];

const REAPABLE = new Set(CATEGORIES.filter(c => c.severity === 'reapable').map(c => c.key));

/** The quarantine directory inside a root. fsck never scans it as live content. */
export const TRASH_DIR = 'trash';

/** Every legal sidecar.status (SERVE.md). A sidecar outside this set is malformed. */
const STATUSES = new Set(['body', 'empty', 'redirect', 'error', 'interstitial']);

/**
 * The finding classes that break the ownership proof. While any of them
 * stands, some sidecar may name a body that fsck cannot see, so no cap/ file
 * is provably an orphan and --fix reaps no body.
 */
const SUSPENDS_REAPING = ['malformed', 'missingBody', 'hashMismatch', 'sizeMismatch', 'schemaVersion'];

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
 * Every regular file under a directory, recursively (the quarantine inventory).
 * A missing directory is empty.
 * @param {string} dir
 * @returns {Promise<Array<{ path: string, size: number }>>}
 */
async function walkFiles(dir) {
  const out = [];
  for (const ent of await readdirSafe(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walkFiles(full)));
    else if (ent.isFile()) out.push({ path: full, size: (await fsp.stat(full)).size });
  }
  return out;
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
 * @param {string} root - store root (contains cap/, meta/, tmp/, and the trash/ quarantine)
 * @param {Object} [options]
 * @param {boolean} [options.fix=false] - move orphan cap/ files to trash/, delete stale tmp/
 * @returns {Promise<{
 *   root: string,
 *   schemaVersion: number,
 *   counts: { sidecars: number, bodies: number, capFiles: number, tmpFiles: number, trashFiles: number },
 *   findings: Record<string, Array<object>>,
 *   reapSuspended: boolean,
 *   reaped: { orphanCap: string[], staleTmp: string[], trash: string | null, moves: Array<{ from: string, to: string }> } | null
 * }>}
 * `reapSuspended` is true when a finding broke the ownership proof, so no
 * cap/ file was classified as an orphan on this run. `reaped.orphanCap` lists
 * the cap/ paths that were MOVED (never deleted) into `reaped.trash`, the
 * quarantine directory of this run (null when nothing moved). `reaped.moves`
 * pairs each source with its destination.
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
  // trash/ is fsck's own quarantine (QUARANTINE, NOT DELETION above). It is
  // part of the root contract, never scanned as live content, and never
  // projected onto a bucket: the sync walks meta/ only.
  const allowed = new Set(['cap', 'meta', 'tmp', TRASH_DIR, '.refetch', '.crawl', 'remaster.build.json']);
  for (const ent of await readdirSafe(root)) {
    if (!allowed.has(ent.name)) {
      findings.foreignRoot.push({ name: ent.name, isDir: ent.isDirectory(), path: path.join(root, ent.name) });
    }
  }

  // ---- inventory: cap/ bodies + tmp/ scratch --------------------------------
  const capFiles = await walkShards(root, 'cap');
  const capKeys = new Set(capFiles.map(f => `cap/${f.aa}/${f.name}`));
  // The rootless cap/ keys that at least one sidecar names. A body shared by
  // many captures is referenced once per sidecar and is never an orphan.
  const referenced = new Set();

  for (const ent of await readdirSafe(path.join(root, 'tmp'))) {
    findings.staleTmp.push({ name: ent.name, isDir: ent.isDirectory(), path: path.join(root, 'tmp', ent.name) });
  }
  // The quarantine is inventoried, never verified: a body in trash/ is not
  // live content, and nothing in it is a finding.
  const trashFiles = (await walkFiles(path.join(root, TRASH_DIR))).length;

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
    // Parsed, but not an object (null, a number, a string, an array): nothing
    // to read a property from. Malformed, and never dereferenced.
    if (!isSidecarObject(sidecar)) {
      findings.malformed.push({ hash, aa, path: metaPath, error: 'not a JSON object' });
      continue;
    }

    if (sidecar.v !== SIDECAR_VERSION) {
      findings.schemaVersion.push({ hash, aa, key: sidecar.key ?? null, v: sidecar.v ?? null });
    }

    // A status outside the schema is malformed. Such a sidecar cannot say
    // whether it owns a body, so it must not pass as bodiless (which is what
    // a plain `status !== 'body'` test makes of it).
    if (!STATUSES.has(sidecar.status)) {
      findings.malformed.push({
        hash,
        aa,
        key: sidecar.key ?? null,
        path: metaPath,
        error: `status ${JSON.stringify(sidecar.status ?? null)} is not one of body, empty, redirect, error, interstitial`
      });
    } else if (sidecar.status !== 'body' && (sidecar.contentHash !== undefined || sidecar.contentLength !== undefined)) {
      // contentHash and contentLength are present iff status is body. A
      // bodiless status that carries them is a body sidecar whose status
      // rotted: its body sits on disk, and nothing else names it. Malformed,
      // so the run moves nothing and the body stays where it is.
      findings.malformed.push({
        hash,
        aa,
        key: sidecar.key ?? null,
        path: metaPath,
        error: `status ${JSON.stringify(sidecar.status)} carries contentHash or contentLength, which are present only when status is body`
      });
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
      let capKey = null;
      try {
        capKey = bodyPath(sidecar.contentHash);
        referenced.add(capKey);
      } catch {
        // No usable digest: the body cannot be located, so it is missing.
      }
      const capPath = capKey === null ? null : path.join(root, capKey);
      if (capKey === null || !capKeys.has(capKey)) {
        findings.missingBody.push({ hash, aa, key: sidecar.key ?? null, contentHash: sidecar.contentHash ?? null });
      } else {
        const actual = await fileSRI(capPath);
        if (actual !== sidecar.contentHash) {
          findings.hashMismatch.push({ hash, aa, key: sidecar.key ?? null, expected: sidecar.contentHash ?? null, actual });
        }
        // The named file's size must equal contentLength. A sidecar that names
        // another capture's body passes the hash check by construction (the
        // digest IS the file name), so the size is the check that catches it.
        const { size } = await fsp.stat(capPath);
        if (sidecar.contentLength !== size) {
          findings.sizeMismatch.push({ hash, aa, key: sidecar.key ?? null, expected: sidecar.contentLength ?? null, actual: size });
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
  // The ownership proof (header): a cap/ file is an orphan only when every
  // sidecar parses, carries a known status, and names a body whose bytes and
  // size agree with it. An unparseable sidecar can name any body. A sidecar
  // with a rotted contentHash names a missing digest, or another capture's
  // body, while its own body sits on disk unnamed. A sidecar of another
  // version has an unknown shape. While any such finding stands, no cap/
  // file is provably unreferenced, so orphan detection (and with it --fix)
  // waits until the finding is resolved. Reaping never destroys evidence.
  const reapSuspended = SUSPENDS_REAPING.some(k => findings[k].length > 0);
  for (const f of reapSuspended ? [] : capFiles) {
    if (!referenced.has(`cap/${f.aa}/${f.name}`)) findings.orphanCap.push({ hash: f.name, aa: f.aa, path: f.path });
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
      if (isUnmirrorable(childKey.slice(childKey.indexOf('/') + 1))) continue;
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
      if (isUnmirrorable(childKey.slice(childKey.indexOf('/') + 1))) continue;
      const childHash = await captureHash(childKey);
      if (!sidecarHashes.has(childHash)) {
        findings.incompleteClosure.push({ hash: doc.hash, aa: doc.aa, key: doc.key, child: childKey, childHash, dynamic: true });
      }
    }
  }

  // ---- --fix: act ONLY on the safe classes ----------------------------------
  // An orphan body is MOVED into this run's quarantine directory, under its
  // own relative path (trash/<run>/cap/<dd>/<digest>), by one rename on the
  // same filesystem. A stale tmp/ file is deleted. See QUARANTINE, NOT
  // DELETION in the header for why a body is never deleted.
  let reaped = null;
  if (fix) {
    reaped = { orphanCap: [], staleTmp: [], trash: null, moves: [] };
    const runDir = path.join(root, TRASH_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    for (const f of findings.orphanCap) {
      const to = path.join(runDir, 'cap', f.aa, f.hash);
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(f.path, to);
        reaped.orphanCap.push(f.path);
        reaped.moves.push({ from: f.path, to });
        reaped.trash = runDir;
      } catch (error) {
        // A move that fails (permissions, race) stays a finding — surface it.
        f.reapError = error.message;
      }
    }
    for (const f of findings.staleTmp) {
      try {
        await fsp.rm(f.path, { recursive: true, force: true });
        reaped.staleTmp.push(f.path);
      } catch (error) {
        f.reapError = error.message;
      }
    }
  }

  return {
    root,
    schemaVersion: SIDECAR_VERSION,
    counts: { sidecars: metaFiles.length, bodies, capFiles: capFiles.length, tmpFiles: findings.staleTmp.length, trashFiles },
    findings,
    reapSuspended,
    reaped
  };
}

/**
 * Empty the quarantine: delete `<root>/trash` and everything under it. This
 * is the ONLY path that deletes a body file, and it runs only when an
 * operator asks for it (`cache verify --empty-trash`). Returns what was
 * removed so the caller can report it. A root with no trash/ removes nothing.
 *
 * @param {string} root
 * @returns {Promise<{ path: string, files: number, bytes: number }>}
 */
export async function emptyTrash(root) {
  const dir = path.join(root, TRASH_DIR);
  const files = await walkFiles(dir);
  await fsp.rm(dir, { recursive: true, force: true });
  return { path: dir, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
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
 * reaped classes drop by however many were moved or removed. This is the
 * exit-status signal: 0 iff the store is clean (or made clean by --fix).
 * @param {{ findings: Record<string, Array<object>>, reaped: object | null }} report
 * @returns {number}
 */
export function unresolvedFindings(report) {
  const reaped = report.reaped ? report.reaped.orphanCap.length + report.reaped.staleTmp.length : 0;
  return totalFindings(report) - reaped;
}
