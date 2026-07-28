// Bucket-population batch emitter — the cap/ half of "project the cache root
// onto a bucket" (see spv/waybackify-cli/docs/SYNC.md for the end-to-end
// runbook; the projection contract is CACHE.md#bucket-projection).
//
// Walks the root's meta/ tree and emits one `s5cmd run` command line per
// entry — a PUT of the body object carrying the sidecar's essentials as
// NATIVE object metadata, so the mirror server serves a bodied entry in a
// single GET:
//
//   cp --content-type '<ct>' --metadata 'status=<status>' <src> s3://<bucket>/cap/<aa>/<hash>
//
//   - <ct>       = sidecar.contentType, VERBATIM — EXCEPT when it is '' (or
//                  absent), which emits an explicit `application/octet-stream`
//                  (the settled normalization rule). The flag is NEVER omitted:
//                  s5cmd fills a missing --content-type client-side by sniffing
//                  the file (Go http.DetectContentType), which returns
//                  `text/plain; charset=utf-8` for an empty file — so the target
//                  never gets to apply its own default. Proven identically on
//                  Cloudflare R2 and Fastly Object Storage.
//   - status     = sidecar.status, as x-amz-meta-status (s5cmd `--metadata`
//                  key=value → the object's user metadata; README pin in
//                  SYNC.md). The known-bad ≠ miss discriminator.
//   - <src>      = the local cap/<aa>/<hash> file for a bodied entry; for a
//                  bodiless entry (status empty/redirect/error/interstitial —
//                  no local cap/ file exists) it is the caller's --empty-file:
//                  one zero-byte
//                  scratch file the runbook mktemp's OUTSIDE the root, emitted
//                  as a zero-byte object that still carries the status metadata.
//
// Per-line `--content-type`/`--metadata` in an s5cmd run-file are supported:
// run.go splits each line with kballard/go-shellquote and parses it with the
// cp flagset (SYNC.md pins the source). Values with spaces/semicolons
// ('text/html; charset=utf-8') are shell-quoted per POSIX single-quote rules,
// which go-shellquote implements.
//
// LIBRARY-FIRST: all logic lives here; the CLI's `cache sync` handler
// (spv/waybackify-cli/src/commands/cache-sync.js) is a thin argv+stdout
// wrapper. Object-key derivation is reused from key.js
// (capturePath/metaPath), sidecar reading + its schema-version guard from
// cache.js (readSidecar), and the CR/LF + ≤1000-byte metadata guard from
// key.js (assertMetadataSafe) — imported, never duplicated.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertMetadataSafe, capturePath, metaPath } from './key.js';
import { readSidecar } from './cache.js';

/** Statuses whose entry OWNS a local cap/<aa>/<hash> body file. */
const BODIED = new Set(['body']);
/** Every legal sidecar.status (the serving discriminator — SERVE.md).
 *  `interstitial` (#363) is bodiless like empty/redirect/error — it ships as a
 *  zero-byte object carrying only its `x-amz-meta-status`. */
const STATUSES = new Set(['body', 'empty', 'redirect', 'error', 'interstitial']);

/**
 * Characters that never need shell-quoting inside an s5cmd run-file token
 * (go-shellquote / POSIX word-splitting treats a run of these as one word).
 * A hash-named object key and an s3:// URL are entirely within this set; a
 * content-type with a space or `;` is not, and gets single-quoted.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one run-file token so go-shellquote.Split parses it as a single word.
 * Safe tokens pass through verbatim (clean, diff-stable output); anything else
 * is POSIX single-quoted, with embedded single quotes escaped as `'\''` (end
 * quote, backslash-escaped quote, reopen quote — go-shellquote concatenates
 * adjacent quoted/backslash runs into one word). An empty string quotes to `''`.
 * @param {string} token
 * @returns {string}
 */
export function shellQuote(token) {
  if (token.length > 0 && SAFE_TOKEN.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the single `cp` run-file line for one entry. Assumes the sidecar has
 * already been validated (version + key by readSidecar; status against
 * STATUSES here). Refuses to emit an unsafe metadata value: assertMetadataSafe
 * throws on CR/LF or a >1000-byte content-type, so no line can smuggle a
 * header/command injection into the batch.
 * @param {{ contentType: string, status: string }} sidecar
 * @param {string} source - already-resolved local source path (cap file or empty file)
 * @param {string} dest - the s3://<bucket>/<objectKey> destination
 * @returns {string}
 */
export function emitLine(sidecar, source, dest) {
  if (!STATUSES.has(sidecar.status)) {
    throw new Error(`emit-bucket-batch: unknown sidecar status ${JSON.stringify(sidecar.status)}`);
  }
  const parts = ['cp'];
  // ALWAYS emit --content-type. A '' (or absent) contentType normalizes to
  // application/octet-stream per the Store read-contract — NEVER omitted: an
  // omitted flag lets s5cmd sniff the file client-side (Go http.DetectContentType
  // returns text/plain; charset=utf-8 for an empty body), so the target never
  // applies its own default (proven on R2 and Fastly).
  const contentType = sidecar.contentType || 'application/octet-stream';
  parts.push('--content-type', shellQuote(assertMetadataSafe(contentType)));
  parts.push('--metadata', shellQuote(`status=${sidecar.status}`));
  parts.push(shellQuote(source), shellQuote(dest));
  return parts.join(' ');
}

/** Normalize a --bucket value ('name', 's3://name', 's3://name/prefix') to an `s3://…` base with no trailing slash. */
function bucketBase(bucket) {
  const trimmed = bucket.replace(/^s3:\/\//, '').replace(/\/+$/, '');
  if (trimmed === '') throw new Error('emit-bucket-batch: --bucket must name a bucket');
  return `s3://${trimmed}`;
}

/**
 * Walk <root>/meta/ and yield each sidecar file's rootless POSIX key
 * (meta/<aa>/<hash>.json), shard- then file-sorted so a caller that trusts the
 * walk order already sees hash order. ENOENT on meta/ yields nothing (an empty
 * or never-populated root emits an empty batch).
 */
async function* walkMeta(root) {
  const metaRoot = path.join(root, 'meta');
  let shards;
  try {
    shards = await fsp.readdir(metaRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const shard of shards.filter(d => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const files = (await fsp.readdir(path.join(metaRoot, shard.name))).filter(f => f.endsWith('.json')).sort();
    for (const file of files) yield `meta/${shard.name}/${file}`;
  }
}

/**
 * Emit the cap/ population batch for a cache root — PURE (no stdout, no side
 * effects): returns the sorted command lines plus a summary. The bin wrapper
 * decides where they go.
 *
 * @param {string} root - cache root (the archive of record)
 * @param {Object} options
 * @param {string} options.bucket - target bucket ('name' or 's3://name[/prefix]')
 * @param {string|null} [options.emptyFile] - zero-byte scratch file path for
 *   bodiless entries; REQUIRED iff the root has any bodiless entry
 * @returns {Promise<{ lines: string[], summary: { total: number, bodied: number, bodiless: number } }>}
 */
export async function emitBucketBatch(root, options = {}) {
  const { bucket, emptyFile = null } = options;
  if (!bucket) throw new TypeError('emitBucketBatch: options.bucket is required');
  const base = bucketBase(bucket);

  const rows = [];
  let bodied = 0;
  let bodiless = 0;

  for await (const rel of walkMeta(root)) {
    // The sidecar's own `key` is the only recoverable identity (the filename is
    // the hash). Read it to learn the key, then re-read through cache.js's
    // readSidecar for the authoritative, VALIDATED record — it owns the
    // schema-version guard (throws on an unknown `v`) and the key-claim check.
    const raw = await fsp.readFile(path.join(root, rel), 'utf8');
    let probe;
    try {
      probe = JSON.parse(raw);
    } catch (error) {
      throw new Error(`emit-bucket-batch: unparseable sidecar ${rel}: ${error.message}`);
    }
    if (typeof probe.key !== 'string' || probe.key.length === 0) {
      throw new Error(`emit-bucket-batch: sidecar ${rel} has no string key`);
    }
    const sidecar = await readSidecar(root, probe.key);
    if (sidecar === null) {
      throw new Error(`emit-bucket-batch: sidecar ${rel} vanished (or key ${JSON.stringify(probe.key)} resolves nowhere)`);
    }
    // Misplacement/tamper guard: the file we walked MUST be the canonical
    // location its key hashes to, or readSidecar just read a different file.
    const canonical = await metaPath(probe.key);
    if (canonical !== rel) {
      throw new Error(`emit-bucket-batch: sidecar for ${JSON.stringify(probe.key)} is misplaced — at ${rel}, belongs at ${canonical}`);
    }

    const objectKey = await capturePath(probe.key); // cap/<aa>/<hash>
    let source;
    if (BODIED.has(sidecar.status)) {
      source = path.join(root, objectKey);
      bodied++;
    } else {
      if (emptyFile === null) {
        throw new Error(
          `emit-bucket-batch: bodiless entry (${sidecar.status}) ${rel} needs --empty-file — a zero-byte scratch file OUTSIDE the root`
        );
      }
      source = emptyFile;
      bodiless++;
    }

    rows.push({ objectKey, line: emitLine(sidecar, source, `${base}/${objectKey}`) });
  }

  // Deterministic output: sort by object key (== hash order), independent of
  // readdir order on any filesystem.
  rows.sort((a, b) => (a.objectKey < b.objectKey ? -1 : a.objectKey > b.objectKey ? 1 : 0));

  return { lines: rows.map(r => r.line), summary: { total: rows.length, bodied, bodiless } };
}
