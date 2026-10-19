/**
 * Capture-key + capture-metadata derivation — the storage
 * naming contract, alone in its own module ON PURPOSE.
 *
 * Built pure — zero imports, zero runtime assumptions beyond WebCrypto —
 * so any consumer can load it as a plain file. The digest tests in
 * test/key.test.js pin that the layout never drifts (the pinned sha256 of
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
 *                 parser's liberal repair — see
 *                 src/waybackify-serve/src/path.ts) so keys read like the
 *                 serving path.
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
 *   local disk    (cache.js) sidecar at meta/<aa>/<hash>.json, the same
 *                 key as the bucket sidecar object. The body is
 *                 CONTENT-ADDRESSED: cap/<dd>/<digest>, where <digest> is the
 *                 SHA-256 hex that the sidecar's SRI contentHash records and
 *                 dd = digest.slice(0, 2) (bodyPath() below). Byte-identical
 *                 captures under different keys share one local body file.
 *                 The bucket sync copies that shared file to each capture's
 *                 capturePath() object, because each bucket body object
 *                 carries its own capture's content-type and status.
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
 * Derive the ROOTLESS BUCKET body object key for a capture key:
 * `cap/<aa>/<hash>`, where <hash> is captureHash(key) and aa =
 * hash.slice(0, 2). Always `/`-joined — these are OBJECT KEYS (R2 / Object
 * Storage), never OS paths. The remote stores, the bucket sync, and parity
 * derive through here. A local cache root does NOT store bodies here: see
 * bodyPath().
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
 * Derive the ROOTLESS LOCAL body key for a body: `cap/<dd>/<digest>`, where
 * <digest> is the hex form of the SHA-256 digest that an SRI contentHash
 * (`sha256-<base64>`, cache.js) records, and dd = digest.slice(0, 2). Equal
 * bytes give one key, whatever the capture key. Throws on a value that is not
 * a sha256 SRI digest.
 * @param {string} contentHash - the sidecar's `sha256-<base64>` contentHash
 * @returns {string} `cap/<dd>/<digest>`
 */
export function bodyPath(contentHash) {
  const match = typeof contentHash === 'string' ? /^sha256-([A-Za-z0-9+/]{43}=)$/.exec(contentHash) : null;
  if (match === null) throw new Error(`bodyPath: contentHash is not a sha256 SRI digest: ${JSON.stringify(contentHash)}`);
  const digest = Array.from(atob(match[1]), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `cap/${digest.slice(0, 2)}/${digest}`;
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
