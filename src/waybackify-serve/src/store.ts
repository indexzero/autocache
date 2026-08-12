/**
 * Capture storage (#249).
 *
 * One Hono app (src/app.ts), two runtime targets — Cloudflare Workers backed
 * by an R2 bucket and Fastly Compute backed by S3-compatible Object Storage
 * (src/s3store.ts, BOTH are shipping targets, not alternatives). The app never
 * sees either vendor API: it talks to this Store interface keyed by the
 * capture key from src/path.ts (`${timestamp}/${originalUrl}`), and each
 * runtime entry (src/cloudflare.ts, src/fastly.ts) wires its own impl.
 *
 * POPULATION SEAM — deliberately absent. The store starts EMPTY: mirror
 * population is blocked on the #248 wayback-404 audit (never mirror a capture
 * the audit flagged bad). The population path is the spv/waybackify CLI
 * (#254): `waybackify cache <url> -o <dir>` writes a local bucket image that
 * gets synced to R2 / Fastly Object Storage — each verified capture's body +
 * content-type under the key layout defined in src/key.ts (which that CLI must
 * share; the module is pure precisely so it can be lifted out wholesale).
 * Nothing in the serving path changes; misses simply become hits.
 *
 * Vendor types are STRUCTURAL on purpose (R2BucketLike describes only the
 * sliver we call) so this module typechecks in any runtime and tests can hand
 * in plain objects. The real bindings satisfy them trivially. The Fastly
 * Compute path has no vendor binding at all — it is an S3Store (src/s3store.ts)
 * making SigV4-signed origin fetches over a named backend.
 */

import { capturePath } from '@autocache/waybackify/key.js';

/**
 * What kind of capture an entry is — the cache-root sidecar's discriminator
 * (docs/SERVE.md, "Status discriminators"). Body bytes
 * exist iff `body`. Stores that predate statuses (R2/KV as populated today)
 * simply omit the field; consumers treat absence as `body`.
 *
 * `interstitial` (#363) is bodiless like empty/redirect/error: a capture that
 * was the Wayback Machine talking ABOUT content (a wrapper stub, a redirect
 * interstitial, a raw asset served as text/html), refused at cache time and
 * committed with no body. Every consumer treats it as another bodiless
 * discriminator — metadata only, no bytes to stream.
 */
export type CaptureStatus = 'body' | 'empty' | 'redirect' | 'error' | 'interstitial';

/** What head() answers: enough to emit response headers without a body. */
export interface CaptureMeta {
  /** Full content-type as captured (e.g. `text/html; charset=utf-8`). */
  contentType: string;
  /** Body size in bytes, when the backing store knows it. */
  size?: number;
  /** Entry discriminator; absent means `body` (see CaptureStatus). */
  status?: CaptureStatus;
}

/** What get() answers: metadata plus a body the runtime can stream. */
export interface Capture extends CaptureMeta {
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;
}

/**
 * The storage contract. Keys are capture keys — see src/path.ts.
 *
 * get() may legally answer with metadata and NO body: a bodiless entry
 * (status `empty` | `redirect` | `error` | `interstitial`) is a COMPLETE entry
 * whose kind is its status — never a miss, never a phantom body. The app discriminates
 * with an `'body' in capture` check, the same narrowing it already performs
 * for head() answers.
 */
export interface Store {
  head(key: string): Promise<CaptureMeta | null>;
  get(key: string): Promise<Capture | CaptureMeta | null>;
}

/* ------------------------------------------------------------------------ *
 * Cloudflare R2
 * ------------------------------------------------------------------------ */

/**
 * The slice of an R2 head()/get() result we consume: native content-type
 * (httpMetadata.contentType) and the status discriminator, which the batch
 * sync emitter writes to customMetadata.status — the R2 twin of the FsStore
 * sidecar's `status` field and MemoryStore's per-object status.
 */
export interface R2ObjectLike {
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
}

/** The slice of an R2Bucket binding we consume. */
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

/**
 * R2-backed store over the hash-keyed bucket layout (the settled bucket
 * layout — cap/<aa>/<hash>, hash = sha256hex(captureKey)). Object keys are
 * derived through the shared key module (capturePath, src/key.ts) — never
 * hand-rolled — because that layout is a contract with the population tooling
 * that writes the bucket (the same derivation the FsStore reads from disk).
 * A capture key is NOT a legal-everywhere object key (real corpus keys are
 * POSIX-impossible and can exceed the 1KiB cap), so the hash is what keeps
 * every backend keying identically.
 *
 * Native metadata, one GET to serve: content-type rides R2's httpMetadata,
 * the status discriminator rides customMetadata.status (absent → `body`, the
 * same default consumers apply everywhere). A bodiless status
 * (empty/redirect/error/interstitial) is a zero-byte object answered metadata-only. The
 * READ-CONTRACT NORMALIZATION applies here as on every Store (see
 * FsStore.#metaOf): a `''`/absent contentType reads back as
 * `application/octet-stream`.
 */
export class R2Store implements Store {
  #bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
  }

  /** CaptureMeta from an R2 object — size exists iff the entry has a body. */
  static #metaOf(object: R2ObjectLike): CaptureMeta {
    const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
    const status = (object.customMetadata?.status as CaptureStatus | undefined) ?? 'body';
    if (status !== 'body') return { contentType, status };
    return { contentType, status, size: object.size };
  }

  async head(key: string): Promise<CaptureMeta | null> {
    // head() never fetches the body — the binding's head() returns metadata
    // only, which is all a bodiless status ever needs and all head() may read.
    const object = await this.#bucket.head(await capturePath(key));
    if (object === null) return null;
    return R2Store.#metaOf(object);
  }

  async get(key: string): Promise<Capture | CaptureMeta | null> {
    const object = await this.#bucket.get(await capturePath(key));
    if (object === null) return null;
    const meta = R2Store.#metaOf(object);
    // Bodiless statuses answer per their discriminator: complete metadata, no
    // body — the object is zero-byte, so there is nothing to stream and
    // fabricating a body would be the phantom the status field exists to
    // prevent (parity with FsStore/MemoryStore).
    if (meta.status !== 'body') return meta;
    return { ...meta, body: object.body };
  }
}

/* ------------------------------------------------------------------------ *
 * In-memory (tests + local dev)
 * ------------------------------------------------------------------------ */

/**
 * In-memory store. The tests' Store of record (zero network, zero vendor),
 * and handy for `hono/node-server`-style local poking before either edge
 * target exists. put() is the population seam in miniature — and it models the
 * NATIVE-METADATA world the remote stores read (and the batch sync emitter
 * writes): each object carries its own content-type + status, and a bodiless
 * entry is a zero-byte object whose status IS its kind. That is deliberately
 * NOT the FsStore's sidecar model, yet the store-conformance suite holds both
 * to identical head()/get() answers.
 *
 * The READ-CONTRACT NORMALIZATION applies here too (see FsStore.#metaOf): a
 * `''`/absent contentType reads back as `application/octet-stream`, so the
 * suite's normalization assertions pass against this store unchanged.
 */
export class MemoryStore implements Store {
  #captures = new Map<string, { contentType: string; status: CaptureStatus; body?: string | Uint8Array }>();

  /**
   * Populate one entry. Defaults to a `body` capture (the common case and the
   * back-compatible 3-arg shape). Bodiless statuses (`empty`/`redirect`/
   * `error`) are the zero-byte-object case: pass `null` for `body` — they own
   * no body bytes, exactly as the emitter writes a zero-byte object with only
   * status metadata.
   */
  put(key: string, body: string | Uint8Array | null, contentType: string, status: CaptureStatus = 'body'): void {
    this.#captures.set(key, status === 'body' ? { contentType, status, body: body ?? '' } : { contentType, status });
  }

  #metaOf(capture: { contentType: string; status: CaptureStatus; body?: string | Uint8Array }): CaptureMeta {
    const contentType = capture.contentType || 'application/octet-stream';
    if (capture.status !== 'body') return { contentType, status: capture.status };
    const body = capture.body ?? '';
    const size = typeof body === 'string' ? new TextEncoder().encode(body).length : body.length;
    return { contentType, status: capture.status, size };
  }

  async head(key: string): Promise<CaptureMeta | null> {
    const capture = this.#captures.get(key);
    if (capture === undefined) return null;
    return this.#metaOf(capture);
  }

  async get(key: string): Promise<Capture | CaptureMeta | null> {
    const capture = this.#captures.get(key);
    if (capture === undefined) return null;
    const meta = this.#metaOf(capture);
    // Bodiless statuses answer per their discriminator: complete metadata, no
    // body — the same narrowing FsStore performs, so the app's `'body' in`
    // check sees the same shape from either store.
    if (capture.status !== 'body') return meta;
    return { ...meta, body: capture.body ?? '' };
  }
}
