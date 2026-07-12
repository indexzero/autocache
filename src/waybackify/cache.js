// Local mirror-image cache store — the population path for the
// wayback.charlie.dev capture mirror. `waybackify cache` is a thin
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
// <hash> is byte-identical to the Fastly KV item name minus `cap:` (both
// derive from key.js's captureHash), and sidecar.key is the verbatim R2
// object key — the root IS the deploy artifact.
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
// frontier on re-run = the document's sidecar.requisites[] entries whose
// child sidecar is missing. Fetch URLs for missing children are recovered
// by re-extracting the flagged refs from the STORED document body (the
// requisites[] edge list is normatively flagless captureKeys, and the
// im_/cs_/js_/oe_ flag is required to fetch an asset's raw bytes — the
// stored body is the authoritative place the flags live).
//
// CONCURRENCY: no locks. Same-key writers use distinct temp names and both
// rename onto the final name — last-writer-wins on identical bytes (the
// wayback timestamp pins content). Distinct keys never share paths.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WaybackMachine } from './index.js';
import { parseWaybackUrl } from './audit.js';
import { captureHash, captureKey, captureMetadata } from './key.js';
import { extractRequisites } from './requisites.js';

export const SIDECAR_VERSION = 1;

/** Content types the requisite extractor runs over (documents). */
const isHtmlish = ct => !ct || /html|xhtml/i.test(ct);

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
  return {
    hash,
    aa,
    body: path.join(root, 'cap', aa, hash),
    meta: path.join(root, 'meta', aa, `${hash}.json`)
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
 * the sidecar is one line, byte-reproducible (Eelco's canonicalization
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
 * nothing), and silently re-fetching over evidence would mask it. (Kat's
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
  if (sidecar.v !== SIDECAR_VERSION) {
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
 * @param {'body'|'redirect'|'error'|'empty'} entry.status
 * @param {string} entry.contentType - as returned by archive.org ('' if none)
 * @param {'im_'|'cs_'|'js_'|'oe_'|null} [entry.flag] - requisite-type tag
 * @param {string[]} [entry.requisites] - verbatim child captureKeys
 * @param {Uint8Array|AsyncIterable<Uint8Array>|null} [entry.body] - required
 *   iff a bodied write is intended; a zero-byte body demotes status to 'empty'
 * @param {string} [entry.fetchedAt] - ISO-8601 (defaults to now)
 * @param {Object} [hooks] - test seams; `afterBodyCommit()` runs between the
 *   body rename and the sidecar rename (the crash-atomicity window)
 * @returns {Promise<object>} the sidecar as written (parsed form)
 */
export async function commitEntry(root, entry, hooks = {}) {
  const { key, contentType = '', flag = null, requisites = [], fetchedAt = new Date().toISOString() } = entry;
  let { status, body = null } = entry;
  // Enforce the sync targets' metadata constraints at write time (key.js:
  // no CR/LF, ≤ 1000 encoded bytes) so no sidecar ever holds a contentType
  // the R2/Fastly sync or the Fastly-Metadata header would reject.
  captureMetadata({ contentType });

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
 * a fetch; the requisite frontier is recomputed from the document sidecar's
 * requisites[] on every run.
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
 * @param {Object} [options.hooks] - test seams (see commitEntry)
 * @returns {Promise<{ key: string, hash: string, root: string,
 *   entries: Array<object>, fetched: number, skipped: number,
 *   failures: Array<{ key: string, error: string }> }>}
 */
export async function cacheCapture(waybackUrl, options = {}) {
  const { root, requisites: wantRequisites = true, onEntry = () => {}, hooks = {} } = options;
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
    const res = await fetchImpl(waybackUrl);
    if (res.status === 404) {
      throw new Error(`cacheCapture: replay returned HTTP 404 — capture missing from the archive: ${waybackUrl}`);
    }
    if (res.status !== 200) {
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

  // ---- requisite fan-out ---------------------------------------------------
  if (wantRequisites && docSidecar.requisites.length > 0) {
    // Frontier = edge-list children whose sidecar is missing (per-entry
    // completion; closure is this query, never a write barrier).
    const missing = [];
    for (const childKey of docSidecar.requisites) {
      const childSidecar = await readSidecar(root, childKey);
      if (childSidecar) {
        const { hash } = await entryPaths(root, childKey);
        record({ key: childKey, hash, status: childSidecar.status, action: 'skipped', flag: childSidecar.flag });
      } else {
        missing.push(childKey);
      }
    }

    if (missing.length > 0) {
      // Recover flagged fetch URLs. On a fresh run docBytes is in hand; on
      // resume, re-read the stored document body (see RESUME note above).
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
          summary.failures.push({ key: childKey, error: 'malformed requisite key (no timestamp separator)' });
          record({ key: childKey, hash: null, status: 'failed', action: 'failed', flag: null });
          continue;
        }
        const ref = byKey.get(childKey) ?? {
          // Theoretical fallback (edge list and stored body always agree —
          // same bytes, same extraction): flagless replay URL.
          key: childKey,
          flag: null,
          waybackUrl: `https://web.archive.org/web/${childKey.slice(0, childKey.indexOf('/'))}/${childKey.slice(childKey.indexOf('/') + 1)}`
        };
        const { hash } = await entryPaths(root, childKey);
        try {
          const res = await fetchImpl(ref.waybackUrl);
          const contentType = res.headers?.get?.('content-type') || '';
          let sidecar;
          if (res.status === 200) {
            sidecar = await commitEntry(
              root,
              { key: childKey, status: 'body', contentType, flag: ref.flag, requisites: [], body: await responseBytes(res) },
              hooks
            );
          } else if (res.status >= 300 && res.status < 400) {
            sidecar = await commitEntry(
              root,
              { key: childKey, status: 'redirect', contentType, flag: ref.flag, requisites: [] },
              hooks
            );
          } else if (res.status === 404 || res.status === 410) {
            sidecar = await commitEntry(
              root,
              { key: childKey, status: 'error', contentType, flag: ref.flag, requisites: [] },
              hooks
            );
          } else {
            throw new Error(`replay returned HTTP ${res.status}`);
          }
          record({ key: childKey, hash, status: sidecar.status, action: 'fetched', flag: ref.flag });
        } catch (error) {
          summary.failures.push({ key: childKey, error: error?.message ?? String(error) });
          record({ key: childKey, hash, status: 'failed', action: 'failed', flag: ref.flag });
        }
      }
    }
  }

  return summary;
}
