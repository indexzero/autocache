/**
 * Capture-key + capture-metadata derivation — the storage
 * naming contract, alone in its own module ON PURPOSE.
 *
 * EXTRACTED from render/wayback/src/key.ts, which was built pure —
 * zero imports, zero runtime assumptions beyond WebCrypto — precisely so
 * this extraction is a file move (see that module's original header). The
 * TypeScript module is now a re-export shim over this file; its key.test.ts
 * digest tests pin that the move changed NOTHING (the pinned sha256 of
 * '20140403040000/http://example.com/' is the cross-package tripwire).
 *
 * This is a cross-package contract, not an implementation detail: the
 * `waybackify cache` CLI populates the mirror by writing a local
 * bucket image (cache.js) that gets synced to R2 / Fastly Object Storage, so
 * the writer and the wayback mirror server MUST derive identical keys and
 * metadata from (timestamp, originalUrl, contentType).
 *
 * The layout:
 *
 *   capture key   `${timestamp}/${originalUrl}`
 *                 timestamp: 4–14 digit wayback timestamp, as referenced.
 *                 originalUrl: the archived URL exactly as embedded in the
 *                 wayback URL (no re-encoding, no normalization beyond the
 *                 parser's liberal repair — see render/wayback/src/path.ts)
 *                 so keys read like the serving path.
 *
 *   bucket        object body key = `cap/<aa>/<hash>`, sidecar key =
 *                 `meta/<aa>/<hash>.json`, where <hash> is SHA-256 hex of the
 *                 capture key (captureHash() below) and aa = hash.slice(0, 2).
 *                 Hashing is REQUIRED: real archived originals contain
 *                 characters that are POSIX-impossible and S3/R2-hostile, and
 *                 keys run past the universal 1,024-byte object-key cap. The
 *                 hash maps any capture key to a legal, fixed-length,
 *                 collision-safe key. Content-type rides the object's native
 *                 `Content-Type` header; status rides `x-amz-meta-status`. One
 *                 layout serves every backend — Cloudflare R2, Fastly Object
 *                 Storage, AWS S3 — since all are S3-shaped.
 *
 *   local disk    (cache.js) body at cap/<aa>/<hash>, sidecar at
 *                 meta/<aa>/<hash>.json — byte-identical to the bucket object
 *                 keys, so sync is a rename-free copy. These two rootless
 *                 object keys are derived by capturePath()/metaPath() below —
 *                 the ONE source of truth for the `<aa>`-shard, shared by
 *                 cache.js, the FsStore, and the bucket sync (they ARE the
 *                 Object Storage object keys, verbatim).
 */

/**
 * Derive the capture key for a (timestamp, originalUrl) pair.
 * @param {string} timestamp
 * @param {string} originalUrl
 * @returns {string}
 */
export function captureKey(timestamp, originalUrl) {
  return `${timestamp}/${originalUrl}`;
}

/**
 * SHA-256 hex of a capture key — the identity token every hash-keyed
 * consumer shares: the Fastly KV item name is `cap:` + this, and the local
 * cache layout's on-disk filename is exactly this. Async because the digest
 * is WebCrypto (`crypto.subtle` is a global in Fastly Compute, Workers, and
 * Node ≥ 19 — https://nodejs.org/api/globals.html#crypto).
 * @param {string} key
 * @returns {Promise<string>} 64 lowercase hex chars
 */
export async function captureHash(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive the ROOTLESS body object key for a capture key: `cap/<aa>/<hash>`,
 * where <hash> is captureHash(key) and aa = hash.slice(0, 2). Always
 * `/`-joined — these are OBJECT KEYS (R2 / Object Storage / the local layout
 * verbatim), never OS paths. A local consumer joins this under its root with
 * `path.join`; `path.join` semantics (OS separators, `..` collapsing) must
 * never leak back into the returned key. The single source of truth for the
 * `<aa>`-sharded layout — cache.js#entryPaths and fsstore.ts#paths both
 * derive through here.
 * @param {string} key - verbatim captureKey (NEVER used as a path component)
 * @returns {Promise<string>} `cap/<aa>/<hash>`
 */
export async function capturePath(key) {
  const hash = await captureHash(key);
  return `cap/${hash.slice(0, 2)}/${hash}`;
}

/**
 * Derive the ROOTLESS sidecar object key for a capture key:
 * `meta/<aa>/<hash>.json`. Same layout + join rules as capturePath() — see
 * its doc; the shared derivation the cache writer, the FsStore, and the
 * bucket sync all project their storage from.
 * @param {string} key - verbatim captureKey (NEVER used as a path component)
 * @returns {Promise<string>} `meta/<aa>/<hash>.json`
 */
export async function metaPath(key) {
  const hash = await captureHash(key);
  return `meta/${hash.slice(0, 2)}/${hash}.json`;
}

/**
 * Assert a contentType is safe to carry as sync-time object metadata, throwing
 * if not. The commit-time + sync-time guard shared by cache.js#commitEntry and
 * the bucket-sync emitter (bucket-batch.js): two constraints that outlive any
 * one backend (Fastly Object Storage caps object metadata at 1,000 bytes;
 * content-type still rides HTTP headers everywhere):
 *   - no CR/LF — the value rides an HTTP header (R2/Fastly-OS `Content-Type`,
 *     the s5cmd/aws run-line, the `x-amz-meta-*` metadata header), so a raw
 *     newline is header/command injection. Rejected, never laundered.
 *   - ≤ 1000 bytes once JSON-encoded — the sync targets' metadata cap;
 *     designed to so a locally-written value stays uploadable through every
 *     door.
 * @param {string} contentType
 * @returns {string} the same contentType, once validated
 */
export function assertMetadataSafe(contentType) {
  if (/[\r\n]/.test(contentType)) {
    throw new Error(`assertMetadataSafe: contentType must not contain CR/LF: ${JSON.stringify(contentType)}`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ contentType })).length;
  if (bytes > 1000) {
    throw new Error(`assertMetadataSafe: encoded metadata is ${bytes} bytes; the sync target caps at 1000`);
  }
  return contentType;
}
