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
//                   wayback interstitial (a wrapper stub, a redirect
//                   interstitial, or a .pdf/.txt served as text/html) — a
//                   pre-schema capture that predates cache-time refusal. REPORT
//                   ONLY: the corpus-wide re-commit is the remediation
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
// trash/<run>/cap/<dd>/<digest> inside the root, keeps the relative path, and
// reports each move. <run> is `<ISO timestamp>-<pid>-<random>`, created with
// an exclusive mkdir, so two runs never share a directory, and the move is a
// hard link plus an unlink, so it never replaces an existing file. A move that
// fails stays a finding. trash/ carries a marker file (TRASH_MARKER) that says
// this tool created it. A trash/ without the marker, or a trash/ that is a
// symlink, is not this tool's quarantine: fsck reports it as foreignRoot,
// never inventories it, never moves into it, never follows it, and refuses to
// empty or restore it. A later run never scans trash/ as live content. An
// operator restores a run with `cache verify --restore <run>` (restoreTrash
// below), which moves a body back only when no live file exists at its path
// and otherwise skips it with a report, and empties the quarantine with
// `cache verify --empty-trash` (emptyTrash below). Stale tmp/ files are still deleted: a
// tmp file was never renamed into place, so nothing can name it.
//
// CONCURRENT WRITERS: --fix assumes that no writer runs against the root at
// the same time. The store has no write lock (cache.js is lockless by
// design), so there is nothing for fsck to hold or check. The window between
// the scan and a move is narrowed, not closed: just before each move the
// sidecars are re-read, and a body that one now names is skipped (reported
// in reaped.skipped). After the moves the sidecars are re-read once more, and
// a moved body that one names by then is reported as missingBody with its
// quarantine path, so the run ends unresolved and `--restore <run>` brings
// the body back. A sidecar written after that last re-read shows up as
// missingBody on the next run, with the same quarantine path.
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
  { key: 'interstitialAsBody', label: "status 'body' whose bytes are a wayback interstitial", severity: 'advisory' },
  { key: 'schemaVersion', label: 'sidecar schema version is not the current version', severity: 'advisory' },
  { key: 'foreignRoot', label: 'root entry outside cap/ meta/ tmp/ trash/ (or a trash/ that is not this tool\'s quarantine)', severity: 'advisory' },
  { key: 'orphanCap', label: 'cap/ file with no sidecar (ingest garbage; --fix moves it to trash/)', severity: 'reapable' },
  { key: 'staleTmp', label: 'leftover tmp/ scratch file', severity: 'reapable' }
];

const REAPABLE = new Set(CATEGORIES.filter(c => c.severity === 'reapable').map(c => c.key));

/** The quarantine directory inside a root. fsck never scans it as live content. */
export const TRASH_DIR = 'trash';
/** The marker file inside trash/ that says this tool created the quarantine. */
export const TRASH_MARKER = '.fsck-quarantine';

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
 * The rootless cap/ keys that the sidecars on disk name RIGHT NOW: a cheap
 * re-read (parse only, no hashing) of every sidecar, for the re-checks around
 * a quarantine move. Any sidecar that fails to read or parse may name any
 * body, so `unreadable` is set and the caller treats every body as named.
 * @param {string} root
 * @returns {Promise<{ keys: Set<string>, unreadable: boolean }>}
 */
async function namedCapKeys(root) {
  const keys = new Set();
  let unreadable = false;
  for (const { path: metaPath } of (await walkShards(root, 'meta')).filter(f => f.name.endsWith('.json'))) {
    let sidecar;
    try {
      sidecar = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch {
      unreadable = true;
      continue;
    }
    if (!isSidecarObject(sidecar)) {
      unreadable = true;
      continue;
    }
    try {
      keys.add(bodyPath(sidecar.contentHash));
    } catch {
      // No usable digest names nothing.
    }
  }
  return { keys, unreadable };
}

/**
 * Move a file without ever replacing an existing destination. A hard link
 * fails with EEXIST when the destination exists, and an unlink of the source
 * completes the move. A filesystem without hard links gets a copy with
 * COPYFILE_EXCL, which fails the same way. Exported for its own tests.
 * @param {string} from
 * @param {string} to
 */
export async function moveNoReplace(from, to) {
  try {
    await fsp.link(from, to);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP'].includes(error.code)) throw error;
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
  await fsp.unlink(from);
}

/**
 * What `<root>/trash` is: absent, this tool's quarantine (a real directory
 * with the marker), a symlink (never followed), or a foreign directory (no
 * marker: an operator's own trash/, not ours).
 * @param {string} root
 * @returns {Promise<'absent'|'quarantine'|'symlink'|'foreign'>}
 */
async function quarantineState(root) {
  const dir = path.join(root, TRASH_DIR);
  let stat;
  try {
    stat = await fsp.lstat(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (!stat.isDirectory()) return 'foreign';
  try {
    await fsp.access(path.join(dir, TRASH_MARKER));
    return 'quarantine';
  } catch {
    return 'foreign';
  }
}

/** Throw unless `<root>/trash` is absent or this tool's quarantine. */
async function assertQuarantineUsable(root, what) {
  const state = await quarantineState(root);
  if (state === 'symlink') throw new Error(`${what}: ${path.join(root, TRASH_DIR)} is a symlink, not this tool's quarantine; it is never followed`);
  if (state === 'foreign') throw new Error(`${what}: ${path.join(root, TRASH_DIR)} exists without the ${TRASH_MARKER} marker, so this tool did not create it and leaves it alone`);
  return state;
}

/**
 * Create this run's quarantine directory, `trash/<ISO timestamp>-<pid>-<random>`,
 * with an exclusive mkdir, so two runs (even in the same millisecond) never
 * share one. Writes the quarantine marker when trash/ is new. Refuses a
 * trash/ that this tool did not create (no marker) or that is a symlink.
 * @param {string} root
 * @returns {Promise<string>} the run directory
 */
async function createRunDir(root) {
  await assertQuarantineUsable(root, 'fsck --fix');
  const trash = path.join(root, TRASH_DIR);
  await fsp.mkdir(trash, { recursive: true });
  const marker = path.join(trash, TRASH_MARKER);
  try {
    await fsp.writeFile(marker, `${JSON.stringify({ tool: 'waybackify cache verify', created: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 16; attempt++) {
    const runDir = path.join(trash, `${stamp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    try {
      await fsp.mkdir(runDir);
      return runDir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`fsck: no unique quarantine directory under ${trash} after 16 attempts`);
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
 * @param {(entry: { key: unknown, path: string }) => void | Promise<void>} [options.onSidecar]
 *   Receives each parsed object's identity during the scan. This does not
 *   certify validity: callers must still check the completed fsck report.
 * @param {Object} [options.hooks] - test seams around the moves: `beforeRecheck(finding)` runs
 *   before each move's sidecar re-read, `beforeMove(finding)` runs after that re-read and right
 *   before the move, `afterMoves()` runs after the last move and before the post-move re-read.
 *   Production passes none.
 * @returns {Promise<{
 *   root: string,
 *   schemaVersion: number,
 *   counts: { sidecars: number, bodies: number, capFiles: number, tmpFiles: number, trashFiles: number },
 *   findings: Record<string, Array<object>>,
 *   reapSuspended: boolean,
 *   reaped: {
 *     orphanCap: string[], staleTmp: string[], trash: string | null,
 *     moves: Array<{ from: string, to: string }>,
 *     skipped: Array<{ path: string, reason: string }>
 *   } | null
 * }>}
 * `reapSuspended` is true when a finding broke the ownership proof, so no
 * cap/ file was classified as an orphan on this run. `reaped.orphanCap` lists
 * the cap/ paths that were MOVED (never deleted) into `reaped.trash`, the
 * quarantine directory of this run (null when nothing moved). `reaped.moves`
 * pairs each source with its destination.
 */
export async function fsck(root, options = {}) {
  const { fix = false, hooks = {} } = options;
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
  //   .verify/             `bucket verify`'s checkpoint, one file per bucket
  //                        target (waybackify-verify verify-checkpoint.ts),
  //                        so that an interrupted verification can resume.
  // fsck must not flag its own sibling commands' state as foreign — else
  // `cache fill`/`cache crawl`/`remaster build`/`bucket verify` then `cache verify` on that
  // root would report unclean forever (a non-reapable advisory). (Filenames are
  // a deliberate local copy, per this file's layout-knowledge note.)
  // trash/ is fsck's own quarantine (QUARANTINE, NOT DELETION above). It is
  // part of the root contract, never scanned as live content, and never
  // projected onto a bucket: the sync walks meta/ only.
  const allowed = new Set(['cap', 'meta', 'tmp', TRASH_DIR, '.refetch', '.crawl', '.verify', 'remaster.build.json']);
  for (const ent of await readdirSafe(root)) {
    if (!allowed.has(ent.name)) {
      findings.foreignRoot.push({ name: ent.name, isDir: ent.isDirectory(), path: path.join(root, ent.name) });
    }
  }
  // trash/ is ours only when it is a real directory with the marker. A symlink
  // is never followed, and a directory without the marker belongs to someone
  // else: both are foreign, left alone, and never inventoried.
  const trashState = await quarantineState(root);
  if (trashState === 'symlink' || trashState === 'foreign') {
    findings.foreignRoot.push({
      name: TRASH_DIR,
      isDir: trashState === 'foreign',
      path: path.join(root, TRASH_DIR),
      reason: trashState === 'symlink' ? 'trash/ is a symlink, never followed' : `trash/ has no ${TRASH_MARKER} marker, so this tool did not create it`
    });
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
  // live content, and nothing in it is a finding. The index by cap/ key lets a
  // missingBody finding say where the body went (the restore hint).
  const trashDir = path.join(root, TRASH_DIR);
  const trashByCapKey = new Map();
  for (const f of trashState === 'quarantine' ? await walkFiles(trashDir) : []) {
    if (path.basename(f.path) === TRASH_MARKER) continue;
    const [, ...rest] = path.relative(trashDir, f.path).split(path.sep); // <run>/cap/<dd>/<digest>
    const capKey = rest.join('/');
    if (!trashByCapKey.has(capKey)) trashByCapKey.set(capKey, []);
    trashByCapKey.get(capKey).push(f.path);
  }
  const trashFiles = [...trashByCapKey.values()].reduce((n, v) => n + v.length, 0);

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

    await options.onSidecar?.({ key: sidecar.key, path: metaPath });

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
        const quarantined = capKey === null ? undefined : trashByCapKey.get(capKey)?.[0];
        findings.missingBody.push({
          hash,
          aa,
          key: sidecar.key ?? null,
          contentHash: sidecar.contentHash ?? null,
          ...(quarantined ? { quarantined } : {})
        });
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
        // interstitial-as-body: a pre-schema `status:body` capture whose
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
  // own relative path (trash/<run>/cap/<dd>/<digest>). The directory is
  // created exclusively (createRunDir) and the move never replaces a file
  // (moveNoReplace), so one run can never overwrite another run's evidence. A
  // stale tmp/ file is deleted. See QUARANTINE, NOT DELETION in the header.
  let reaped = null;
  if (fix) {
    reaped = { orphanCap: [], staleTmp: [], trash: null, moves: [], skipped: [] };
    let runDir = null;
    if (findings.orphanCap.length > 0) {
      try {
        runDir = await createRunDir(root);
      } catch (error) {
        // No quarantine directory, no moves: every orphan stays a finding.
        for (const f of findings.orphanCap) f.reapError = error.message;
      }
    }
    for (const f of runDir === null ? [] : findings.orphanCap) {
      if (hooks.beforeRecheck) await hooks.beforeRecheck(f);
      // CONCURRENT WRITERS (header): re-read the sidecars just before the move.
      // A writer that published a sidecar for these bytes since the scan now
      // names the body, so it is no orphan and the move is skipped.
      const now = await namedCapKeys(root);
      if (now.unreadable) {
        f.reapError = 'a sidecar changed during the run and does not read, so the move was skipped';
        continue;
      }
      if (now.keys.has(`cap/${f.aa}/${f.hash}`)) {
        f.skipped = 'named by a sidecar written after the scan';
        reaped.skipped.push({ path: f.path, reason: f.skipped });
        continue;
      }
      const to = path.join(runDir, 'cap', f.aa, f.hash);
      if (hooks.beforeMove) await hooks.beforeMove(f);
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await moveNoReplace(f.path, to);
        reaped.orphanCap.push(f.path);
        reaped.moves.push({ from: f.path, to });
        reaped.trash = runDir;
      } catch (error) {
        // A move that fails (permissions, an existing destination) stays a
        // finding — surface it. Nothing was replaced.
        f.reapError = error.message;
      }
    }
    // A body a writer named in time is not an orphan: drop it from the findings.
    findings.orphanCap = findings.orphanCap.filter(f => !f.skipped);
    if (hooks.afterMoves) await hooks.afterMoves(reaped);
    // Post-move re-check: a writer that published between the last re-read and
    // the move named a body that is now ONLY in quarantine. Report it as
    // missingBody with the quarantine path, so this run ends unresolved (never
    // 0) and the operator restores the run. A writer that also re-wrote the
    // body lost nothing: the live file is back, and the quarantined copy is a
    // duplicate, so there is no finding.
    if (reaped.moves.length > 0) {
      const after = await namedCapKeys(root);
      for (const move of reaped.moves) {
        const aa = path.basename(path.dirname(move.from));
        const digest = path.basename(move.from);
        if (fs.existsSync(move.from)) continue;
        if (after.unreadable || after.keys.has(`cap/${aa}/${digest}`)) {
          findings.missingBody.push({
            hash: null,
            aa,
            key: null,
            contentHash: null,
            quarantined: move.to,
            error: `a sidecar written during the run names this body, which --fix moved to ${move.to}; restore the run`
          });
        }
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
 * Restore one quarantine run: move every `trash/<run>/cap/<dd>/<digest>` back
 * to `cap/<dd>/<digest>`. A body is moved back ONLY when no live file exists
 * at that path (moveNoReplace), so a restore never replaces a repaired body.
 * Everything else is skipped and reported, and stays in the quarantine. Empty
 * directories under the run are pruned afterwards.
 *
 * @param {string} root
 * @param {string} run - a directory name under trash/ (never a path)
 * @returns {Promise<{
 *   run: string,
 *   restored: Array<{ from: string, to: string }>,
 *   skipped: Array<{ from: string, to: string | null, reason: string }>
 * }>}
 */
export async function restoreTrash(root, run) {
  if (typeof run !== 'string' || run === '' || run === '.' || run === '..' || run.includes('/') || run.includes(path.sep)) {
    throw new Error(`restoreTrash: run must be a directory name under ${TRASH_DIR}/, got ${JSON.stringify(run)}`);
  }
  await assertQuarantineUsable(root, 'restoreTrash');
  const runDir = path.join(root, TRASH_DIR, run);
  let stat;
  try {
    stat = await fsp.lstat(runDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`restoreTrash: no quarantine run at ${runDir}`);
  }
  if (!stat.isDirectory()) throw new Error(`restoreTrash: ${runDir} is not a directory`);

  const restored = [];
  const skipped = [];
  for (const f of await walkFiles(runDir)) {
    const rel = path.relative(runDir, f.path);
    if (!rel.startsWith(`cap${path.sep}`)) {
      skipped.push({ from: f.path, to: null, reason: 'not a cap/ body' });
      continue;
    }
    const to = path.join(root, rel);
    if (fs.existsSync(to)) {
      skipped.push({ from: f.path, to, reason: 'a live body exists at that path' });
      continue;
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
      await moveNoReplace(f.path, to);
      restored.push({ from: f.path, to });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      skipped.push({ from: f.path, to, reason: 'a live body exists at that path' });
    }
  }
  await pruneEmptyDirs(runDir);
  return { run: runDir, restored, skipped };
}

/** Remove empty directories under `dir`, then `dir` itself when it is empty. */
async function pruneEmptyDirs(dir) {
  for (const ent of await readdirSafe(dir)) {
    if (ent.isDirectory()) await pruneEmptyDirs(path.join(dir, ent.name));
  }
  try {
    await fsp.rmdir(dir);
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
  }
}

/**
 * Empty the quarantine: delete the bodies under `<root>/trash`. This is the
 * ONLY path that deletes a body file, and it runs only when an operator asks
 * for it (`cache verify --empty-trash`, after the verify report). Two kinds of
 * body are KEPT and reported instead of deleted: a body that a current sidecar
 * names (its live file is missing, so this copy is the one to restore), and a
 * body that the run named by `keepRun` just moved. When every sidecar reads
 * and nothing is kept, trash/ goes away entirely. A root with no trash/
 * removes nothing.
 *
 * @param {string} root
 * @param {Object} [options]
 * @param {string|null} [options.keepRun] - a run directory whose bodies stay (this run's moves)
 * @returns {Promise<{ path: string, files: number, bytes: number, kept: Array<{ path: string, reason: string }> }>}
 */
export async function emptyTrash(root, options = {}) {
  const { keepRun = null } = options;
  const dir = path.join(root, TRASH_DIR);
  if ((await assertQuarantineUsable(root, 'emptyTrash')) === 'absent') return { path: dir, files: 0, bytes: 0, kept: [] };
  const named = await namedCapKeys(root);
  const kept = [];
  let files = 0;
  let bytes = 0;
  for (const f of await walkFiles(dir)) {
    if (path.basename(f.path) === TRASH_MARKER) continue;
    const [run, ...rest] = path.relative(dir, f.path).split(path.sep);
    if (keepRun !== null && path.join(dir, run) === keepRun) {
      kept.push({ path: f.path, reason: 'moved by this run' });
      continue;
    }
    if (named.unreadable) {
      kept.push({ path: f.path, reason: 'a sidecar does not read, so it may name this body' });
      continue;
    }
    if (named.keys.has(rest.join('/'))) {
      kept.push({ path: f.path, reason: 'a current sidecar names this body; restore the run instead' });
      continue;
    }
    await fsp.unlink(f.path);
    files++;
    bytes += f.size;
  }
  for (const ent of await readdirSafe(dir)) {
    if (ent.isDirectory()) await pruneEmptyDirs(path.join(dir, ent.name));
  }
  if (kept.length === 0) await fsp.rm(dir, { recursive: true, force: true });
  return { path: dir, files, bytes, kept };
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
