/**
 * Capture-key + capture-metadata derivation (#249/#254/#267) — the storage
 * naming contract, alone in its own module ON PURPOSE.
 *
 * EXTRACTED from render/wayback/src/key.ts (#267), which was built pure —
 * zero imports, zero runtime assumptions beyond WebCrypto — precisely so
 * this extraction is a file move (see that module's original header). The
 * TypeScript module is now a re-export shim over this file; its key.test.ts
 * digest tests pin that the move changed NOTHING (the pinned sha256 of
 * '20140403040000/http://example.com/' is the cross-package tripwire).
 *
 * This is a cross-package contract, not an implementation detail: the
 * `waybackify cache` CLI (#254/#267) populates the mirror by writing a local
 * bucket image (cache.js) that gets synced to R2 / Fastly KV, so the writer
 * and the wayback.charlie.dev server MUST derive identical keys and metadata
 * from (timestamp, originalUrl, contentType).
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
 *   R2            object key = the capture key, verbatim (R2 allows any
 *                 UTF-8 key ≤ 1KiB). Content-type lives in the object's
 *                 native httpMetadata.contentType.
 *
 *   Fastly KV     KV item name = `cap:` + SHA-256 hex of the capture key.
 *                 Hashing is REQUIRED, twice over: KV key names hard-ban
 *                 characters real archived originals contain (`#`, `;`, `?`,
 *                 `^`, `|` — docs.fastly.com/products/compute-resource-limits,
 *                 KV Store section), and key names cap at 1024 UTF-8 bytes,
 *                 which a long original URL + timestamp can exceed. The hash
 *                 maps any capture key to a legal, fixed-length, collision-
 *                 safe name. Content-type rides the KV item's own metadata
 *                 field (put(key, value, { metadata }), read back via the
 *                 entry's metadataText()) as the JSON produced by
 *                 captureMetadata() below — same object shape as R2's
 *                 httpMetadata, so both backends share one metadata story.
 *
 *   local disk    (#267 cache.js) body at cap/<aa>/<hash>, sidecar at
 *                 meta/<aa>/<hash>.json, where <hash> is the SAME sha256 hex
 *                 (captureHash() below) and aa = hash.slice(0, 2). The local
 *                 filename is byte-identical to the Fastly item name minus
 *                 its `cap:` prefix — sync is a rename-free loop.
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
 * consumer shares: the Fastly KV item name is `cap:` + this, and the #267
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
 * Derive the Fastly KV item name for a capture key.
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function fastlyKVKey(key) {
  return `cap:${await captureHash(key)}`;
}

/**
 * Encode capture metadata for a Fastly KV put({ metadata }) — a JSON string
 * in the SAME shape as the R2 store's httpMetadata object ({ contentType }),
 * so population tooling derives one object and hands it to either backend.
 *
 * Enforces Fastly's metadata constraints at WRITE time so the serving side
 * never meets an illegal value:
 *   - UTF-8, no CR/LF — the metadata rides the Fastly-Metadata HTTP header,
 *     so a raw newline would be header injection. JSON.stringify escapes
 *     control characters, but a CR/LF-bearing content-type is garbage in,
 *     so it's rejected rather than laundered.
 *   - ≤ 1000 bytes — js-compute documents 1000 for put() while the
 *     management API says 2000; design to the smaller so images written
 *     locally by the #254 CLI stay uploadable through either door.
 * @param {{ contentType: string }} meta
 * @returns {string}
 */
export function captureMetadata(meta) {
  if (/[\r\n]/.test(meta.contentType)) {
    throw new Error(`capture metadata: contentType must not contain CR/LF: ${JSON.stringify(meta.contentType)}`);
  }
  const encoded = JSON.stringify({ contentType: meta.contentType });
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > 1000) {
    throw new Error(`capture metadata: encoded JSON is ${bytes} bytes; Fastly KV metadata caps at 1000`);
  }
  return encoded;
}
