// Local mirror-image cache store — the population path for a
// wayback capture mirror. `waybackify cache` is a thin
// wrapper over cacheCapture() below; everything load-bearing lives here.
//
// ON-DISK LAYOUT (normative — the design debate's position E;
// field-by-field docs in spv/waybackify-cli/docs/CACHE.md):
//
//   <root>/cap/<aa>/<hash>        body bytes, verbatim, NO extension
//   <root>/meta/<aa>/<hash>.json  authoritative sidecar (canonical JSON)
//   <root>/tmp/                   ingest scratch — same filesystem as cap/
//                                 and meta/ so rename(2) stays atomic
//
//   hash = sha256hex(captureKey), captureKey = `${timestamp}/${originalUrl}`
//   aa   = hash.slice(0, 2)
//
// <hash> is byte-identical to the bucket object key's <hash> (both derive
// from key.js's captureHash), and sidecar.key is the verbatim capture key —
// the root IS the deploy artifact.
//
// WRITE PROTOCOL (normative; per entry):
//   1. stream body → tmp/<hash>.<pid>-<rand>.part, hashing as bytes flow
//   2. fsync the temp file (filehandle.sync() → POSIX fsync(2):
//      https://nodejs.org/api/fs.html#filehandlesync — "Request that all
//      data for the open file descriptor is flushed to the storage device")
//   3. atomic rename → cap/<aa>/<hash>
//      (https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath;
//      atomicity is the POSIX rename(2) guarantee for same-filesystem
//      renames — https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html:
//      "if the link named by the new argument exists, it shall be removed
//      and old renamed to new ... the link named new shall remain visible
//      to other threads throughout the renaming operation". Cross-device
//      renames fail EXDEV, which is WHY tmp/ lives inside <root>.)
//   4. build sidecar (embedding the hash from step 1) → tmp/*.json.part,
//      fsync
//   5. atomic rename → meta/<aa>/<hash>.json — LAST. Sidecar presence is
//      the SOLE completion token.
//
// Bodiless entries (status != 'body') skip 1–3; the sidecar rename is still
// the completion act. A crash between steps 3 and 5 leaves an orphan cap/
// file: ingest garbage — reported absent, re-fetched on resume, never
// served.
//
// One strengthening beyond the minimum protocol (doubt-cycle finding): after
// the body rename, the body's PARENT DIRECTORY is fsync'd before the sidecar
// is written. A process crash cannot reorder the two renames, but a power
// cut can persist the sidecar rename while losing the body rename — which
// would fabricate a complete-looking bodied entry with no body. Fsyncing
// cap/<aa> pins the ordering: the body rename is durable before the
// completion token can ever become durable. The FINAL (meta) directory
// fsync stays omitted on purpose — losing the sidecar rename merely
// re-exposes the entry as absent, which is exactly the resume path.
// (fsync of a directory persists its entries on Linux — see
// https://man7.org/linux/man-pages/man2/fsync.2.html: "Calling fsync() does
// not necessarily ensure that the entry in the directory containing the
// file has also reached disk. For that an explicit fsync() on a file
// descriptor for the directory is also needed." macOS fsync is best-effort
// without F_FULLFSYNC; acceptable — the mirror's ground truth is re-fetchable.)
//
// INTEGRITY: contentHash is the W3C SRI form `sha256-<base64>` over the
// stored bytes (https://www.w3.org/TR/sri-1/#integrity-metadata-description — an
// integrity metadata entry is "hash-algo, a dash, and the base64-encoded
// digest"; also https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity),
// computed DURING the streaming write via crypto.createHash's streaming
// update/digest API (https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options,
// https://nodejs.org/api/crypto.html#hashupdatedata-inputencoding).
// Integrity, not addressing: the filename stays the identity hash.
//
// RESUME: completion signal = sidecar exists, nothing else. The fetch
// frontier on re-run = `requisites[] ∪ dynamic[].key` — the document's
// static edge-list children PLUS its browser-discovered dynamic children
// (v3) — restricted to those whose child sidecar is missing. Fetch URLs for
// missing REQUISITE children are recovered by re-extracting the flagged refs
// from the STORED document body (the requisites[] edge list is normatively
// flagless captureKeys, and the im_/cs_/js_/oe_ flag is required to fetch an
// asset's raw bytes — the stored body is the authoritative place the flags
// live). Fetch URLs for missing DYNAMIC children are built from the flag
// PERSISTED in each dynamic entry, NOT re-extracted: a browser-discovered
// requisite never appears in the stored bytes, which is the whole reason its
// flag is recorded in the sidecar.
//
// CONCURRENCY: no locks. Same-key writers use distinct temp names and both
// rename onto the final name — last-writer-wins on identical bytes (the
// wayback timestamp pins content). Distinct keys never share paths.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WaybackMachine } from './index.js';
import { parseWaybackUrl } from './audit.js';
import { assertMetadataSafe, captureHash, captureKey, capturePath, metaPath } from './key.js';
import { extractRequisites } from './requisites.js';
import { detectInterstitial } from './interstitial.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { isUnmirrorable } from './beacons.js';

// cacheCapture's fetch path is half of the §4 request/response trace (the doc +
// requisite firehose; WaybackMachine's #cdxRows is the other half). The library
// never constructs pino (design §1) — it defaults to NOOP_LOGGER.

// The version new writes stamp. Bumped to 2 for the `interstitial` status
// (#363): a v2 sidecar may carry `status: "interstitial"` (+ `signature`, and a
// redirect's decoded `target`), an enum value a strictly-v1 reader would not
// understand — hence the coordinated bump the schema discipline requires
// (CACHE.md §sidecar). Bumped to 3 for the optional `dynamic[]` array: a doc's
// browser-discovered requisites (recorded by recordDynamic from the `remaster
// verify` dynamic probe). v3 is a backward-compatible SUPERSET of v2 — it only
// ADDS one optional array whose entries carry a persisted replay `flag`
// (unrecoverable from stored bytes), so every v2/v1 field keeps its meaning and
// a v3 write with no dynamic data is byte-identical to the v2 it would have
// been (the field is ABSENT, never invented empty).
export const SIDECAR_VERSION = 3;

// Readers accept a v3, v2, OR legacy v1 sidecar: each newer version is a
// backward-compatible SUPERSET (v2 ADDS the interstitial status + its fields;
// v3 ADDS the optional `dynamic[]` array), so a v1 root — the whole existing
// corpus — still reads, as does a v2 one. A version outside this set is
// genuinely unknown and must fail loud, never be treated as complete-current.
// Old v1 `status:body` entries that HIDE an interstitial are surfaced by
// `fsck`'s interstitial-as-body category, not by rejecting them here.
export const SUPPORTED_SIDECAR_VERSIONS = Object.freeze(new Set([1, 2, 3]));

/** Content types the requisite extractor runs over (documents). */
const isHtmlish = ct => !ct || /html|xhtml/i.test(ct);

/** The replay flags a v3 `dynamic[]` entry may carry (null = flagless). */
const DYNAMIC_FLAGS = new Set(['im_', 'cs_', 'js_', 'oe_', null]);

/** The provenance enum a v3 `dynamic[]` entry's `via` must be one of. */
const DYNAMIC_VIA = new Set(['remaster-verify', 'manual']);

/**
 * ISO-8601 date-time shape a v3 `dynamic[]` entry's OPTIONAL `firstSeen` must
 * match: `YYYY-MM-DDThh:mm:ss[.sss](Z|±hh:mm)` — the same form
 * `new Date().toISOString()` emits. The shape check pairs with a `Date.parse`
 * validity check (a shape-legal but impossible calendar value like month 13
 * still parses to NaN), so a bare `"not-a-date"` — or any non-ISO string — is
 * rejected rather than silently persisted as an audit field nothing can read.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Normalize a (already well-formed) v3 `dynamic[]` entry to the documented
 * persisted shape `{ key, flag, via, firstSeen? }`: `flag` is ALWAYS present,
 * `null` when the caller omitted it — a dynamic child's replay flag is
 * unrecoverable from the stored bytes, so an unknown flag is recorded as an
 * explicit `null`, NEVER a missing key (CACHE.md: `flag` presence is "always").
 * `firstSeen` rides through only when present (it is optional). This is the ONE
 * place a persisted entry is shaped, so every writer emits byte-identical meta
 * and the shape can never drift between a fresh write and an existing-wins
 * merge. `via` is required by `dynamicEntryError`, so it is carried verbatim.
 * @param {{ key: string, flag?: 'im_'|'cs_'|'js_'|'oe_'|null,
 *   via: 'remaster-verify'|'manual', firstSeen?: string }} entry
 * @returns {{ key: string, flag: 'im_'|'cs_'|'js_'|'oe_'|null,
 *   via: 'remaster-verify'|'manual', firstSeen?: string }}
 */
export function normalizeDynamicEntry(entry) {
  const normalized = { key: entry.key, flag: entry.flag ?? null, via: entry.via };
  if (entry.firstSeen !== undefined) normalized.firstSeen = entry.firstSeen;
  return normalized;
}

/**
 * The SINGLE well-formedness predicate for a v3 `dynamic[]` entry — the one
 * definition BOTH the writer (recordDynamic, which THROWS on a bad entry) and
 * the verifier (fsck.js, which FLAGS one `malformed` finding per bad entry)
 * share, so writer and verifier can never disagree about what "well-formed"
 * means. A well-formed entry is an object whose `key` is a string with a valid
 * `<ts>/<orig>` separator (both parts non-empty), whose `flag` (after `?? null`)
 * is in `{im_,cs_,js_,oe_,null}`, and whose `via` provenance is in
 * `{remaster-verify,manual}` (a required enum in the v3 spec). The KEY shape
 * check is deliberately slash-separator-only — the SAME trust boundary as a
 * malformed requisite (the requisite guard is slash-only; no digit-only
 * timestamp rule) — so writer/verifier match the existing requisite policy.
 * `firstSeen` is OPTIONAL (absent = fine), but when present it MUST be a valid
 * ISO-8601 timestamp — a persisted audit field nothing could parse is not a
 * legal record, so `firstSeen: "not-a-date"` is rejected. Returns a short human
 * reason string when the entry is malformed, or `null` when it is valid.
 * @param {unknown} entry
 * @returns {string | null}
 */
export function dynamicEntryError(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  if (typeof entry.key !== 'string') return 'key is not a string';
  const sep = entry.key.indexOf('/');
  if (sep <= 0 || sep === entry.key.length - 1) return 'key has no <ts>/<orig> separator';
  if (!DYNAMIC_FLAGS.has(entry.flag ?? null)) return `flag ${JSON.stringify(entry.flag)} not in {im_,cs_,js_,oe_,null}`;
  if (!DYNAMIC_VIA.has(entry.via)) return `via ${JSON.stringify(entry.via)} not in {remaster-verify,manual}`;
  if (entry.firstSeen !== undefined && (typeof entry.firstSeen !== 'string' || !ISO_8601.test(entry.firstSeen) || Number.isNaN(Date.parse(entry.firstSeen)))) {
    return `firstSeen ${JSON.stringify(entry.firstSeen)} is not an ISO-8601 timestamp`;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Paths + canonical JSON
 * ------------------------------------------------------------------------ */

/**
 * Resolve the on-disk paths for a capture key.
 * @param {string} root
 * @param {string} key - verbatim captureKey (NEVER used as a path component)
 * @returns {Promise<{ hash: string, aa: string, body: string, meta: string }>}
 */
export async function entryPaths(root, key) {
  const hash = await captureHash(key);
  const aa = hash.slice(0, 2);
  // key.js#capturePath/#metaPath own the `<aa>`-shard layout (the bucket
  // object-key contract); we resolve those rootless keys under our root.
  // Their `/`-joined keys pass cleanly through path.join, which re-segments
  // on `/` and re-joins with the OS separator — the object-key form never
  // leaks OS separators back out (it stays only in these local paths).
  return {
    hash,
    aa,
    body: path.join(root, await capturePath(key)),
    meta: path.join(root, await metaPath(key))
  };
}

/**
 * Canonical JSON: recursively sorted object keys, no insignificant
 * whitespace, single line. JSON.stringify emits object properties in
 * insertion order for string keys (ECMA-262 OrdinaryOwnPropertyKeys;
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys#description
 * — "in ascending chronological order of property creation"), so building
 * the object sorted IS emitting it sorted. Control characters in strings
 * are escaped by JSON.stringify, so the output never contains raw CR/LF —
 * the sidecar is one line, byte-reproducible (the canonical-serialization
 * dissent, adopted minus his trailing newline: the normative schema
 * says "no CR/LF", so there is none anywhere in the file).
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/* ------------------------------------------------------------------------ *
 * Read side (resume + tests; the mirror server's FsStore reads the same way)
 * ------------------------------------------------------------------------ */

/**
 * Read an entry's sidecar. null = the entry is ABSENT (never written, or
 * crashed before the sidecar rename — an orphan cap/ file does not count).
 * A sidecar that exists but fails to parse THROWS: that is disk rot, not
 * an incomplete write (the rename either published a whole fsync'd file or
 * nothing), and silently re-fetching over evidence would mask it. (The verify-on-read
 * fsck dissent is the follow-up tool for exactly this.)
 * @param {string} root
 * @param {string} key
 * @returns {Promise<object | null>}
 */
export async function readSidecar(root, key) {
  const { meta } = await entryPaths(root, key);
  let raw;
  try {
    raw = await fsp.readFile(meta, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const sidecar = JSON.parse(raw);
  // Minimal authenticity checks (doubt-cycle finding): a sidecar at this
  // path MUST claim this key (the file is the sole identity record — a
  // mismatch is tampering/rot, not absence) and a known schema version (a
  // future v2 must be met by a reader that understands it, not silently
  // treated as complete-v1).
  if (!SUPPORTED_SIDECAR_VERSIONS.has(sidecar.v)) {
    throw new Error(`readSidecar: unsupported sidecar version ${sidecar.v} at ${meta}`);
  }
  if (sidecar.key !== key) {
    throw new Error(`readSidecar: sidecar at ${meta} claims a different key (${sidecar.key})`);
  }
  return sidecar;
}

/* ------------------------------------------------------------------------ *
 * Write side — the ingest→commit protocol
 * ------------------------------------------------------------------------ */

/** Unique temp path for one write attempt (concurrent writers never collide). */
function tmpPath(root, hash, suffix) {
  return path.join(root, 'tmp', `${hash}.${process.pid}-${crypto.randomBytes(6).toString('hex')}${suffix}.part`);
}

/**
 * Write bytes to a temp file, hashing as they flow, then fsync. Returns the
 * digest + length; the caller decides whether/where to rename. `body` may be
 * a Uint8Array or any (async) iterable of Uint8Array chunks (a web
 * ReadableStream is async-iterable in Node ≥ 16.5:
 * https://nodejs.org/api/webstreams.html#async-iteration).
 */
async function writeTmp(tmp, body) {
  const hash = crypto.createHash('sha256');
  const chunks = body instanceof Uint8Array ? [body] : body;
  let contentLength = 0;
  const fh = await fsp.open(tmp, 'wx');
  try {
    for await (const chunk of chunks) {
      // Chunks must be BYTES: a Uint16Array etc. would be copied by element
      // VALUE (Buffer.from(TypedArray) semantics), silently corrupting the
      // stored body. (Buffer passes — it is a Uint8Array subclass.)
      if (!(chunk instanceof Uint8Array)) throw new TypeError('writeTmp: body chunks must be Uint8Array');
      // Buffer.from(TypedArray) COPIES the chunk
      // (https://nodejs.org/api/buffer.html#static-method-bufferfrombuffer:
      // "Copies the passed buffer's data" — vs the (arrayBuffer, offset)
      // form, which shares memory), so a caller mutating/reusing its chunk
      // after yield can never make contentHash describe bytes other than
      // the ones written.
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      // filehandle.write may write FEWER bytes than the buffer holds
      // (https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position
      // returns bytesWritten: "the number of bytes written") — loop until
      // the whole chunk is on the descriptor, or contentHash/contentLength
      // would describe intended bytes, not stored bytes.
      let off = 0;
      while (off < bytes.byteLength) {
        const { bytesWritten } = await fh.write(bytes, off, bytes.byteLength - off);
        if (bytesWritten === 0) throw new Error(`writeTmp: zero-byte write at offset ${off} of ${tmp}`);
        off += bytesWritten;
      }
      contentLength += bytes.byteLength;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { sri: `sha256-${hash.digest('base64')}`, contentLength };
}

/**
 * fsync a directory so a just-committed rename inside it is durable BEFORE
 * any later write depends on it (the cap→meta ordering guarantee — see the
 * protocol header). Directory fsync is the documented Linux mechanism for
 * persisting directory entries (fsync(2) NOTES); platforms where a
 * directory open/fsync is unsupported degrade to the minimum protocol.
 */
async function syncDir(dir) {
  // Swallow ONLY can't-do-that errors (platforms/filesystems where a
  // directory can't be opened or fsync'd: Windows EPERM/EISDIR, EINVAL,
  // ENOTSUP, EBADF) — there the guarantee degrades to the minimum protocol.
  // Real durability failures (EIO, ENOSPC, ...) MUST abort the commit, or
  // the completion token could be published over a non-durable body rename.
  // (EACCES deliberately NOT in the set: a genuine permission denial should
  // be loud — effective access was already proven by the writes above.)
  const unsupported = code => ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(code);
  let fh;
  try {
    fh = await fsp.open(dir, 'r');
  } catch (error) {
    if (unsupported(error.code)) return;
    throw error;
  }
  try {
    await fh.sync();
  } catch (error) {
    if (!unsupported(error.code)) throw error;
  } finally {
    await fh.close();
  }
}

/**
 * Commit one complete entry — body (when bodied) then sidecar, in the
 * normative order. This is the ONLY writer of cap/ and meta/.
 *
 * @param {string} root - cache root (created on demand)
 * @param {Object} entry
 * @param {string} entry.key - verbatim captureKey
 * @param {'body'|'redirect'|'error'|'empty'|'interstitial'} entry.status
 * @param {string} entry.contentType - as returned by archive.org ('' if none)
 * @param {'im_'|'cs_'|'js_'|'oe_'|null} [entry.flag] - requisite-type tag
 * @param {string[]} [entry.requisites] - verbatim child captureKeys
 * @param {Array<{ key: string, flag: 'im_'|'cs_'|'js_'|'oe_'|null,
 *   via: 'remaster-verify'|'manual', firstSeen?: string }>} [entry.dynamic] -
 *   browser-discovered requisites (v3). Passed through verbatim; the field is
 *   ABSENT from the sidecar when the caller omits it (a v3 write with no
 *   dynamic data must NOT invent an empty `dynamic`). recordDynamic is the
 *   usual writer — commitEntry only carries what it is handed.
 * @param {Uint8Array|AsyncIterable<Uint8Array>|null} [entry.body] - required
 *   iff a bodied write is intended; a zero-byte body demotes status to 'empty'.
 *   A body whose bytes trip an interstitial signature (#363) is REFUSED — the
 *   entry commits `interstitial` (bodiless), never the junk page.
 * @param {string|number|null} [entry.cdxStatus] - the exact capture's archived
 *   CDX statuscode, INJECTED (network-derived); a 4xx/5xx here trips the
 *   archived-error interstitial signature. Offline callers omit it.
 * @param {string} [entry.fetchedAt] - ISO-8601 (defaults to now)
 * @param {Object} [hooks] - test seams; `afterBodyCommit()` runs between the
 *   body rename and the sidecar rename (the crash-atomicity window)
 * @returns {Promise<object>} the sidecar as written (parsed form)
 */
export async function commitEntry(root, entry, hooks = {}) {
  const { key, contentType = '', flag = null, requisites = [], dynamic, fetchedAt = new Date().toISOString() } = entry;
  let { status, body = null } = entry;
  // Enforce the sync targets' metadata constraints at write time (key.js:
  // no CR/LF, ≤ 1000 encoded bytes) so no sidecar ever holds a contentType
  // the Object Storage sync or an `x-amz-meta-*` header would reject.
  assertMetadataSafe(contentType);

  const paths = await entryPaths(root, key);
  await fsp.mkdir(path.join(root, 'tmp'), { recursive: true });
  await fsp.mkdir(path.dirname(paths.meta), { recursive: true });

  const sidecar = {
    contentType,
    fetchedAt,
    flag,
    key,
    requisites,
    status,
    v: SIDECAR_VERSION
  };
  // v3 dynamic[] passthrough: carry the field ONLY when the caller supplies it
  // — a plain capture (no browser probe) writes NO `dynamic` key, keeping a v3
  // write byte-identical to the v2 it would otherwise be.
  if (dynamic !== undefined) sidecar.dynamic = dynamic;

  // Interstitial refusal (#363): before a body is committed, check whether it
  // is the Wayback Machine talking ABOUT content rather than content. A fired
  // signature flips the entry to `interstitial` — bodiless, recording which
  // signature fired (and a redirect's decoded target) — so a wrapper stub /
  // redirect interstitial / raw-asset-as-html / archived-error capture is never
  // stored as a servable page. Body-shape signatures need materialized bytes;
  // a streamed body is left to the CDX/extension signatures (real callers pass
  // a Uint8Array — see cacheCapture's responseBytes).
  if (status === 'body') {
    const detection = detectInterstitial({
      key,
      contentType,
      body: body instanceof Uint8Array ? body : null,
      cdxStatus: entry.cdxStatus ?? null
    });
    if (detection) {
      status = sidecar.status = 'interstitial';
      sidecar.signature = detection.signature;
      if (detection.target) sidecar.target = detection.target;
      body = null; // bodiless: no cap/ file, no contentHash/contentLength
    }
  }

  if (status === 'body') {
    if (body === null) throw new TypeError(`commitEntry: status 'body' requires body bytes (key: ${key})`);
    await fsp.mkdir(path.dirname(paths.body), { recursive: true });
    const tmp = tmpPath(root, paths.hash, '');
    const { sri, contentLength } = await writeTmp(tmp, body);
    if (contentLength === 0) {
      // Zero bytes is a bodiless capture, not an empty cap/ file: the
      // status enum ('empty') is the discriminator, and contentHash/
      // contentLength exist iff status === 'body' (debate schema).
      await fsp.unlink(tmp);
      status = sidecar.status = 'empty';
    } else {
      await fsp.rename(tmp, paths.body); // step 3: publish bytes (not yet complete)
      await syncDir(path.dirname(paths.body)); // pin rename ordering (see header)
      sidecar.contentHash = sri;
      sidecar.contentLength = contentLength;
    }
  }

  if (hooks.afterBodyCommit) await hooks.afterBodyCommit(paths);

  // Steps 4–5: sidecar last. Its rename is the sole completion token.
  const tmpMeta = tmpPath(root, paths.hash, '.json');
  await writeTmp(tmpMeta, new TextEncoder().encode(canonicalJSON(sidecar)));
  await fsp.rename(tmpMeta, paths.meta);

  return sidecar;
}

/**
 * Record browser-discovered dynamic requisites (v3) onto a document's EXISTING
 * sidecar — the durable half of the crawl fixpoint (`remaster verify`'s dynamic
 * probe finds a leaked child, recordDynamic writes it, the next cacheCapture
 * closes over it via the `requisites ∪ dynamic` frontier).
 *
 * This is a META-ONLY re-write: the body is never touched. It deliberately does
 * NOT go through commitEntry — commitEntry rewrites the body (or requires body
 * bytes for a `status:body` entry) and re-runs interstitial detection, none of
 * which applies to appending a fact to a doc already captured. Every other
 * sidecar field (status, contentHash, contentLength, requisites, flag, …)
 * carries over verbatim through the spread of the existing sidecar.
 *
 * VALIDATION: every incoming entry MUST pass the SAME well-formedness predicate
 * fsck flags a `malformed` finding for (`dynamicEntryError`) — an object, a
 * `key` with a valid `<ts>/<orig>` separator, a `flag` in `{im_,cs_,js_,oe_,
 * null}`, a `via` in `{remaster-verify,manual}`. A violation THROWS a TypeError
 * (the crawl driver builds these; a bad entry is a bug, not something to launder
 * into the frontier). Within one call a repeated `key` is fine when the entries
 * are byte-identical (a browser fetching one asset twice) — it collapses to one;
 * a CONFLICTING same-key entry (same key, differing fields) THROWS. Either way
 * the result is order-independent. An EXISTING `dynamic` that is not a
 * well-formed array also THROWS rather than being silently dropped: masking
 * corruption here is exactly what fsck exists to surface.
 *
 * MERGE: existing `dynamic` entries (if any) come FIRST, then `entries`;
 * duplicates by `key` across the two are collapsed EXISTING-WINS (first-seen
 * wins — an already-recorded entry, with its original `via`/`firstSeen`, is
 * never overwritten by a re-probe). The merged array is SORTED by `key`
 * ascending. Together with canonicalJSON's sorted-key emission, that makes the
 * write DETERMINISTIC (input order does not matter) and IDEMPOTENT (recording
 * the same entries twice produces byte-identical meta).
 *
 * The `dynamic` field is set ONLY when the merged array is non-empty — calling
 * with an empty list against a doc that has no prior dynamic entries leaves the
 * sidecar without a `dynamic` key (never invent an empty array).
 *
 * CONCURRENCY: this is a meta-only read-modify-write that shares the store's
 * existing LOCKLESS model — no locks, no CAS, consistent with every other
 * writer in the core. It is safe under the store's two invariants: (1) same-key
 * capture bytes are IMMUTABLE (the wayback timestamp pins content — a re-commit
 * writes byte-identical body bytes), so the `contentHash`/`contentLength`
 * carried through the spread stay correct even though the body is never
 * re-read; and (2) a cache root is SINGLE-WRITER during a run (TDD Operational
 * policy), so two recordDynamic calls never race the same doc. Adding locking
 * here would be inconsistent with the rest of the core, which locks nowhere.
 *
 * @param {string} root - cache root
 * @param {string} docKey - verbatim captureKey of the document whose sidecar
 *   the dynamic children attach to
 * @param {Array<{ key: string, flag?: 'im_'|'cs_'|'js_'|'oe_'|null,
 *   via?: 'remaster-verify'|'manual', firstSeen?: string }>} entries - the
 *   discovered dynamic requisites; each MUST pass `dynamicEntryError`
 * @returns {Promise<object>} the sidecar as written (parsed form)
 */
export async function recordDynamic(root, docKey, entries = []) {
  const existing = await readSidecar(root, docKey);
  if (existing === null) {
    // You cannot record dynamic children of a document that was never captured
    // — there is no sidecar to attach them to, and inventing one would fabricate
    // a body-less doc the store never fetched.
    throw new Error(`recordDynamic: no sidecar for ${docKey}`);
  }

  // The crawl driver constructs these entries; a bad entry is a bug, so be loud
  // (the SAME predicate fsck flags `malformed` for — one definition, so writer
  // and verifier can never disagree). Within one call a repeated key is only a
  // problem when the two entries DISAGREE: a browser legitimately requests the
  // same asset twice, so a BYTE-IDENTICAL repeat collapses to one (no throw);
  // only a CONFLICTING same-key entry (differing flag/via/firstSeen) throws —
  // that is a genuine ambiguity about which fact to record. Either way the
  // result never depends on input order.
  // NORMALIZE on the way in (`flag: entry.flag ?? null` always present, per
  // CACHE.md) so the byte-identical dedup below and the merge/write further down
  // all operate on — and persist — the one documented `{ key, flag, via,
  // firstSeen? }` shape. A `flag`-omitted entry and an explicit `flag:null`
  // entry are therefore the SAME entry (they collapse, they never "conflict").
  const seen = new Map();
  const incoming = [];
  for (const entry of entries) {
    const why = dynamicEntryError(entry);
    if (why) throw new TypeError(`recordDynamic: malformed dynamic entry (${why}) for ${docKey}`);
    const normalized = normalizeDynamicEntry(entry);
    const prev = seen.get(normalized.key);
    if (prev !== undefined) {
      if (canonicalJSON(prev) !== canonicalJSON(normalized)) {
        throw new TypeError(`recordDynamic: conflicting duplicate key in entries: ${normalized.key}`);
      }
      continue; // benign byte-identical repeat — collapse to the one already seen
    }
    seen.set(normalized.key, normalized);
    incoming.push(normalized);
  }

  // Never silently launder a malformed EXISTING dynamic array — that would mask
  // corruption fsck is meant to surface. A present `dynamic` MUST be an array
  // whose every member passes the shared predicate before we merge onto it.
  let prior = [];
  if (existing.dynamic !== undefined) {
    if (!Array.isArray(existing.dynamic)) {
      throw new TypeError(`recordDynamic: existing dynamic is not an array for ${docKey}`);
    }
    for (const entry of existing.dynamic) {
      const why = dynamicEntryError(entry);
      if (why) throw new TypeError(`recordDynamic: existing dynamic has a malformed entry (${why}) for ${docKey}`);
    }
    // Normalize the existing entries too, so a re-write over a pre-normalization
    // sidecar (a `flag`-omitted entry from before this fix) is republished in
    // the documented `flag`-always shape — writer output never drifts.
    prior = existing.dynamic.map(normalizeDynamicEntry);
  }

  // EXISTING-WINS dedupe by key: seed the map from the current dynamic array,
  // then only add an incoming entry whose key is not already present. Both
  // sides are already normalized, so the persisted bytes are deterministic.
  const byKey = new Map();
  for (const entry of prior) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  for (const entry of incoming) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  const merged = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const sidecar = { ...existing, v: SIDECAR_VERSION };
  if (merged.length > 0) sidecar.dynamic = merged;
  else delete sidecar.dynamic; // never carry an empty array (existing had none)

  // Write the meta the SAME way commitEntry's tail does — tmp write + atomic
  // rename — leaving the body untouched. The sidecar rename remains the sole
  // completion token; here it simply republishes a superset of the same doc.
  const { hash, meta } = await entryPaths(root, docKey);
  await fsp.mkdir(path.join(root, 'tmp'), { recursive: true });
  await fsp.mkdir(path.dirname(meta), { recursive: true });
  const tmpMeta = tmpPath(root, hash, '.json');
  await writeTmp(tmpMeta, new TextEncoder().encode(canonicalJSON(sidecar)));
  await fsp.rename(tmpMeta, meta);

  return sidecar;
}

/* ------------------------------------------------------------------------ *
 * Fetch → entry classification
 * ------------------------------------------------------------------------ */

/**
 * Read a fetch response's bytes verbatim. Prefers arrayBuffer() (byte-exact,
 * what impit provides); falls back to text() for fetch shims that only
 * decode (the unit-test mocks) — same seam the corpus body-capture reference
 * patch proved over 720 real bodies.
 */
async function responseBytes(res) {
  if (typeof res.arrayBuffer === 'function') return new Uint8Array(await res.arrayBuffer());
  return new TextEncoder().encode(await res.text());
}

/* ------------------------------------------------------------------------ *
 * The orchestrator
 * ------------------------------------------------------------------------ */

/**
 * Cache one capture — and, by default, its page requisites — into <root>.
 *
 * Idempotent + resumable: entries whose sidecar exists are skipped without
 * a fetch; the fetch frontier is recomputed on every run as the union of the
 * document sidecar's requisites[] and its browser-discovered dynamic[] (v3)
 * children.
 *
 * Failure policy (per entry class):
 *   - document fetch failure / replay 404 / non-200: THROWS — the operator
 *     named this capture, so its absence is the command failing. Nothing is
 *     written (no partial entry exists to confuse a later run).
 *   - requisite replay 404/410: an 'error' sidecar IS committed — the
 *     archive permanently lacks that asset (audit.js: replay 404 = "capture
 *     missing from the archive"), and recording it keeps every future
 *     resume from re-hammering a known hole.
 *   - requisite fetch throw / 5xx / other: recorded in summary.failures and
 *     NOT committed — presumed transient, the next run retries (exactly the
 *     resume path).
 *
 * @param {string} waybackUrl - full web.archive.org/web/<ts>[flag]/<original>
 * @param {Object} options
 * @param {string} options.root - cache root directory (REQUIRED)
 * @param {boolean} [options.requisites=true] - fan out to im_/cs_/js_/oe_ refs
 * @param {Function} [options.fetch] - fetch-like (injectable for tests);
 *   defaults to a WaybackMachine's impit fetch (browser-impersonated — the
 *   IA throttles naive clients; see index.js)
 * @param {WaybackMachine} [options.wayback] - client to borrow fetch from
 * @param {Function} [options.onEntry] - progress observer, called per entry
 *   with { key, hash, status, action: 'fetched'|'skipped'|'failed', flag }
 * @param {Object} [options.logger] - injected diagnostic logger (default
 *   no-op; the library never constructs pino). Emits the §4 request/response
 *   trace per doc + requisite fetch: `evt:'request'` on send, `evt:'response'`
 *   on receive (2xx info, gone/failed requisite warn, named-doc fault error).
 * @param {Object} [options.hooks] - test seams (see commitEntry)
 * @returns {Promise<{ key: string, hash: string, root: string,
 *   entries: Array<object>, fetched: number, skipped: number,
 *   failures: Array<{ key: string, error: string }> }>}
 */
export async function cacheCapture(waybackUrl, options = {}) {
  const { root, requisites: wantRequisites = true, onEntry = () => {}, hooks = {}, logger = NOOP_LOGGER } = options;
  if (!root) throw new TypeError('cacheCapture: options.root is required');
  const parsed = parseWaybackUrl(waybackUrl);
  if (!parsed) throw new TypeError(`cacheCapture: not a wayback replay URL: ${waybackUrl}`);

  // Fetch-seam semantics note (doubt-cycle): STORED identity is byte-exact
  // (sidecar.key carries raw '#' '?' '|' '^' and both unicode normal forms —
  // EC-2), but the WIRE request follows HTTP semantics: no client transmits
  // a fragment ('#...' stays client-side), and URL-hostile bytes may be
  // percent-encoded by the fetch stack. That matches how a browser fetches
  // the same rewritten refs from archive.org, so the replay bytes received
  // are the replay bytes any reader would receive.
  const fetchImpl =
    options.fetch ?? (url => (options.wayback ?? (cacheCapture._wayback ??= new WaybackMachine({ timeout: 60000 }))).impit.fetch(url));

  const docKey = captureKey(parsed.timestamp, parsed.original);
  const docPaths = await entryPaths(root, docKey);
  const summary = { key: docKey, hash: docPaths.hash, root, entries: [], fetched: 0, skipped: 0, failures: [] };
  const record = entry => {
    summary.entries.push(entry);
    if (entry.action === 'fetched') summary.fetched++;
    else if (entry.action === 'skipped') summary.skipped++;
    onEntry(entry);
  };

  // ---- document entry -----------------------------------------------------
  let docSidecar = await readSidecar(root, docKey);
  let docBytes = null; // raw stored/fetched bytes, for requisite extraction

  if (docSidecar) {
    record({ key: docKey, hash: docPaths.hash, status: docSidecar.status, action: 'skipped', flag: docSidecar.flag });
  } else {
    logger.info({ evt: 'request', method: 'GET', url: waybackUrl, key: docKey, attempt: 1, maxAttempts: 1 });
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(waybackUrl);
    } catch (error) {
      // A transport throw on the OPERATOR-NAMED capture: pair the request with
      // an ERR response event (§4) before the throw propagates (cacheCapture
      // fails the command — the named doc's absence IS the failure, §5).
      logger.error({ evt: 'response', url: waybackUrl, key: docKey, status: null, ms: Date.now() - started, error: error?.message, outcome: 'failed', note: `${error?.message ?? 'transport error'} · document fetch failed` });
      throw error;
    }
    const ms = Date.now() - started;
    if (res.status === 404) {
      // The operator NAMED this capture — its absence is the command failing
      // (error, §5). Body is 0 (nothing served), so the trace shows `0B`.
      logger.error({ evt: 'response', url: waybackUrl, key: docKey, status: 404, bytes: 0, ms, note: 'document gone → command fails' });
      throw new Error(`cacheCapture: replay returned HTTP 404 — capture missing from the archive: ${waybackUrl}`);
    }
    if (res.status !== 200) {
      logger.error({ evt: 'response', url: waybackUrl, key: docKey, status: res.status, ms, note: 'transient archive.org trouble → command fails' });
      throw new Error(`cacheCapture: replay returned HTTP ${res.status} (transient archive.org trouble? retry): ${waybackUrl}`);
    }
    const contentType = res.headers?.get?.('content-type') || '';
    docBytes = await responseBytes(res);

    // The requisites[] edge list is recorded UNCONDITIONALLY for HTML
    // documents — the edges are facts of the captured page, and extraction
    // from in-hand bytes is free. --no-requisites opts out of FETCHING the
    // children only ("stores exactly one entry"); a later default run
    // then resumes straight into the recorded frontier instead of finding
    // an empty edge list and silently never completing the closure.
    const requisiteRefs = isHtmlish(contentType)
      ? extractRequisites(new TextDecoder('utf-8').decode(docBytes))
      : [];

    logger.info({ evt: 'response', url: waybackUrl, key: docKey, status: 200, bytes: docBytes.length, contentType, ms, requisites: requisiteRefs.length });

    docSidecar = await commitEntry(
      root,
      {
        key: docKey,
        status: 'body',
        contentType,
        flag: null,
        requisites: requisiteRefs.map(r => r.key),
        body: docBytes
      },
      hooks
    );
    record({ key: docKey, hash: docPaths.hash, status: docSidecar.status, action: 'fetched', flag: null });
  }

  // ---- requisite ∪ dynamic fan-out -----------------------------------------
  // The fetch frontier is the union of the document's static edge-list
  // children (requisites[]) and its browser-discovered dynamic children
  // (dynamic[].key, v3). A dynamic child is fetched exactly like a requisite —
  // the only difference is where its fetch URL comes from: a requisite's flag
  // is re-extracted from the stored body, a dynamic child's flag is PERSISTED
  // in the sidecar (it never appears in the bytes).
  const docDynamic = Array.isArray(docSidecar.dynamic) ? docSidecar.dynamic : [];
  if (wantRequisites && (docSidecar.requisites.length > 0 || docDynamic.length > 0)) {
    // Well-formed dynamic children → fetch URL built from the STORED flag.
    // Well-formedness is the SAME predicate fsck flags a malformed finding for
    // (dynamicEntryError); a malformed entry is fsck's concern, so skip it
    // defensively here so a bad entry never crashes cacheCapture.
    const dynamicByKey = new Map();
    for (const d of docDynamic) {
      if (dynamicEntryError(d)) continue;
      const flag = d.flag ?? null;
      const sep = d.key.indexOf('/');
      const ts = d.key.slice(0, sep);
      const orig = d.key.slice(sep + 1);
      dynamicByKey.set(d.key, {
        key: d.key,
        flag,
        // Built from the persisted flag — NEVER re-extracted from the body.
        waybackUrl: `https://web.archive.org/web/${ts}${flag ?? ''}/${orig}`
      });
    }

    // Union child-key list = requisites (verbatim) followed by the well-formed
    // dynamic keys, de-duplicated. Fetch-URL resolution below PREFERS the stored
    // dynamic flag over a re-extracted static one: a dynamic child's flag is
    // authoritative and never re-extracted, so when a key is in BOTH the stored
    // dynamic flag wins BY RULE — the two flags MAY differ, and dynamic wins
    // regardless (never re-derive a dynamic child's flag from the body).
    const childKeys = [...new Set([...docSidecar.requisites, ...dynamicByKey.keys()])].filter(childKey => {
      // Drop UN-MIRRORABLE children — tracking beacons + non-fetchable/inline
      // URIs (data: fonts, javascript: handlers, malformed hosts) — from the
      // fetch frontier: a replay can never serve them, so fetching wastes a
      // request/timeout, and they must not count toward closure (fsck agrees, via
      // the same predicate). A separatorless key is left to the malformed-key
      // guard below (it becomes a `failed` finding there, not a silent drop).
      const sep = childKey.indexOf('/');
      return sep <= 0 || !isUnmirrorable(childKey.slice(sep + 1));
    });

    // Frontier = union children whose sidecar is missing (per-entry
    // completion; closure is this query, never a write barrier).
    const missing = [];
    for (const childKey of childKeys) {
      const childSidecar = await readSidecar(root, childKey);
      if (childSidecar) {
        const { hash } = await entryPaths(root, childKey);
        record({ key: childKey, hash, status: childSidecar.status, action: 'skipped', flag: childSidecar.flag });
      } else {
        missing.push(childKey);
      }
    }

    if (missing.length > 0) {
      // Recover flagged fetch URLs for REQUISITE children. On a fresh run
      // docBytes is in hand; on resume, re-read the stored document body (see
      // RESUME note above). Dynamic children never live in the body — their
      // URLs come from dynamicByKey (the persisted flag).
      if (docBytes === null && docSidecar.status === 'body') {
        docBytes = await fsp.readFile(docPaths.body);
      }
      const byKey = new Map(
        docBytes === null ? [] : extractRequisites(new TextDecoder('utf-8').decode(docBytes)).map(r => [r.key, r])
      );

      for (const childKey of missing) {
        // Trust-boundary guard: a requisites[] entry that isn't a capture
        // key (`${timestamp}/${originalUrl}`, both parts non-empty) can't
        // be fetched — record it as a failure instead of fabricating a URL
        // from nonsense slices.
        const sep = childKey.indexOf('/');
        if (sep <= 0 || sep === childKey.length - 1) {
          logger.warn({ key: childKey, kind: 'malformed-requisite-key' }, `malformed requisite key (no timestamp separator): ${childKey}`);
          summary.failures.push({ key: childKey, error: 'malformed requisite key (no timestamp separator)' });
          record({ key: childKey, hash: null, status: 'failed', action: 'failed', flag: null });
          continue;
        }
        // Fetch-URL resolution: PREFER the stored dynamic flag (authoritative;
        // never re-extracted), then the requisite re-extraction, then a flagless
        // theoretical fallback. A key in both requisites and dynamic resolves to
        // the dynamic URL — the flags agree, so it is equivalent, and this makes
        // the "stored flag wins" rule hold uniformly.
        const ref = dynamicByKey.get(childKey) ??
          byKey.get(childKey) ?? {
            // Theoretical fallback (a requisite key's edge list and stored body
            // always agree — same bytes, same extraction; a dynamic key always
            // has a dynamicByKey entry): flagless replay URL.
            key: childKey,
            flag: null,
            waybackUrl: `https://web.archive.org/web/${childKey.slice(0, childKey.indexOf('/'))}/${childKey.slice(childKey.indexOf('/') + 1)}`
          };
        const { hash } = await entryPaths(root, childKey);
        logger.info({ evt: 'request', method: 'GET', url: ref.waybackUrl, key: childKey, flag: ref.flag, attempt: 1, maxAttempts: 1 });
        const started = Date.now();
        try {
          const res = await fetchImpl(ref.waybackUrl);
          const ms = Date.now() - started;
          const contentType = res.headers?.get?.('content-type') || '';
          let sidecar;
          if (res.status === 200) {
            const body = await responseBytes(res);
            sidecar = await commitEntry(
              root,
              { key: childKey, status: 'body', contentType, flag: ref.flag, requisites: [], body },
              hooks
            );
            // A 2xx requisite is the firehose (info, §5).
            logger.info({ evt: 'response', url: ref.waybackUrl, key: childKey, flag: ref.flag, status: 200, bytes: body.length, contentType, ms });
          } else if (res.status >= 300 && res.status < 400) {
            sidecar = await commitEntry(
              root,
              { key: childKey, status: 'redirect', contentType, flag: ref.flag, requisites: [] },
              hooks
            );
            logger.info({ evt: 'response', url: ref.waybackUrl, key: childKey, flag: ref.flag, status: res.status, bytes: 0, ms, note: 'redirect → terminal sidecar' });
          } else if (res.status === 404 || res.status === 410) {
            sidecar = await commitEntry(
              root,
              { key: childKey, status: 'error', contentType, flag: ref.flag, requisites: [] },
              hooks
            );
            // The archive permanently lacks this asset — notable incompleteness
            // (warn, §5), recorded so future runs stop re-hammering it.
            logger.warn({ evt: 'response', url: ref.waybackUrl, key: childKey, flag: ref.flag, status: res.status, bytes: 0, ms, note: 'gone → terminal sidecar' });
          } else {
            // 5xx / other → transient failure; carry the real status + timing so
            // the catch logs `< 503` (warn), not a status-null ERR.
            const e = new Error(`replay returned HTTP ${res.status}`);
            e.responseStatus = res.status;
            e.responseMs = ms;
            throw e;
          }
          record({ key: childKey, hash, status: sidecar.status, action: 'fetched', flag: ref.flag });
        } catch (error) {
          // Presumed transient — deferred, retried next run (warn, §5). A known
          // HTTP status (5xx) keeps its number; a transport throw shows ERR.
          const httpStatus = error?.responseStatus ?? null;
          logger.warn({
            evt: 'response',
            url: ref.waybackUrl,
            key: childKey,
            flag: ref.flag,
            status: httpStatus,
            ...(httpStatus !== null ? { bytes: 0 } : {}),
            ms: error?.responseMs ?? Date.now() - started,
            error: error?.message,
            note: httpStatus !== null ? 'requisite HTTP error → retry next run' : 'requisite failed → retry next run'
          });
          summary.failures.push({ key: childKey, error: error?.message ?? String(error) });
          record({ key: childKey, hash, status: 'failed', action: 'failed', flag: ref.flag });
        }
      }
    }
  }

  return summary;
}
