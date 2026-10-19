/**
 * Filesystem Store over a `waybackify cache` root — the third runtime's
 * storage wiring, alongside R2Store (Cloudflare) and S3Store (Fastly Object
 * Storage).
 *
 * Reads the position-E cache-root layout the `waybackify cache` writer
 * produces (data structure: docs/CACHE.md; the consumer
 * contract this class implements, clause by clause:
 * docs/SERVE.md):
 *
 *   <root>/cap/<dd>/<digest>        body bytes, verbatim, no extension
 *   <root>/meta/<aa>/<hash>.json    authoritative sidecar (canonical JSON)
 *
 *   hash = sha256hex(captureKey), aa = hash.slice(0, 2)
 *   digest = the SHA-256 hex that sidecar.contentHash records, dd = digest[0:2]
 *
 * Bodies are content-addressed: captures with equal bytes share one cap/
 * file, and each capture keeps its own sidecar (content-type, status).
 *
 * Load-bearing semantics, all from SERVE.md:
 *
 * - THE SIDECAR IS THE ENTRY. Its presence is the writer's sole completion
 *   token, so `stat`/`read` of the sidecar path is the ONLY existence check.
 *   An orphan cap/ file (crash between the body rename and the sidecar
 *   rename) is ingest garbage: reported ABSENT, never served, never deleted
 *   from here (reaping is the writer's job — deleting would race a
 *   concurrent `waybackify cache` about to publish that entry).
 * - head() NEVER touches cap/. It is one sidecar read; body bytes are only
 *   ever opened by get() on a `status: "body"` entry.
 * - Status discriminators are honored: `empty`/`redirect`/`error`/`interstitial`
 *   entries answer with metadata and NO body — they are complete entries, not
 *   misses, and there is no cap/ file to stream for them.
 * - A sidecar that exists but fails to parse/validate THROWS (→ 500 at the
 *   app): the write protocol publishes whole fsync'd files or nothing, so a
 *   bad parse is disk rot — evidence, not absence.
 *
 * This module is Node-only (node:fs) ON PURPOSE and therefore lives outside
 * src/store.ts: that module must keep typechecking under BOTH edge tsconfigs
 * (types: ["node"] and types: ["@fastly/js-compute"]), and the edge bundles
 * must never pull node builtins into their graphs. The Node entry
 * (src/node.ts) is this store's only runtime consumer.
 */

import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
// Always derive names through the shared key module — never hand-roll the
// digest. The pinned digest of '20140403040000/http://example.com/' exists
// in both packages' suites (and in the committed fixture root) precisely to
// catch a consumer deriving its own variant.
import { bodyPath, metaPath } from '@autocache/waybackify/key.js';
import type { Capture, CaptureMeta, CaptureStatus, Store } from './store.ts';

/**
 * The one sidecar schema version this reader accepts. It equals cache.js
 * SIDECAR_VERSION. Any other version fails loud, never a silent miss.
 */
export const SIDECAR_VERSION = 3;

/**
 * Whether a parsed JSON value has the SHAPE of a sidecar: a plain object. A
 * file that parses to null, a number, a string, or an array is malformed, and
 * a reader says so before it reads any property.
 */
export function isSidecarObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The slice of a sidecar this store consumes. */
interface Sidecar {
  v: number;
  key: string;
  contentType: string;
  status: CaptureStatus;
  /** Present iff status === 'body'. SRI `sha256-<base64>`. It locates the body. */
  contentHash?: string;
  /** Present iff status === 'body'. */
  contentLength?: number;
}

export class FsStore implements Store {
  #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** meta/<aa>/<hash>.json for a capture key. */
  async #metaFile(key: string): Promise<string> {
    // The `<aa>`-sharded key comes from the shared key module, the one source
    // of truth for the layout. This store joins it under its root with the
    // `/` separator that the writer uses.
    return `${this.#root}/${await metaPath(key)}`;
  }

  /**
   * Read + validate the sidecar — the single existence check. ENOENT is the
   * one and only "absent" signal; anything else that goes wrong with a file
   * that EXISTS propagates loudly (rot must not masquerade as a miss).
   */
  async #sidecar(key: string): Promise<Sidecar | null> {
    const meta = await this.#metaFile(key);
    let raw: string;
    try {
      raw = await fsp.readFile(meta, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isSidecarObject(parsed)) {
      throw new Error(`FsStore: malformed sidecar at ${meta} (not a JSON object)`);
    }
    const sidecar = parsed as unknown as Sidecar;
    // Same authenticity checks the writer's own reader performs: the file at
    // this hash-derived path must claim this key and a known schema version.
    if (sidecar.v !== SIDECAR_VERSION) {
      throw new Error(`FsStore: unsupported sidecar version ${sidecar.v} at ${meta}`);
    }
    if (sidecar.key !== key) {
      throw new Error(`FsStore: sidecar at ${meta} claims a different key (${sidecar.key})`);
    }
    return sidecar;
  }

  /**
   * CaptureMeta from a sidecar — size exists iff the entry has a body.
   *
   * THE READ-CONTRACT NORMALIZATION (every Store, asserted by the shared
   * store-conformance suite): a `''`/absent contentType reads back as
   * `application/octet-stream`. The sidecar keeps `''` verbatim on disk (25
   * corpus sidecars carry it, and the sidecar is the archive of record) —
   * normalization is a READ mask, applied here at the Store boundary so every
   * backend (FsStore over POSIX sidecars, the remote stores over native object
   * metadata) answers identically. This is the same mask app.ts already spells
   * on the wire (`capture.contentType || '…'`); moving it down makes that a
   * no-op and pins the rule where the conformance suite can hold every store to
   * it.
   */
  static #metaOf(sidecar: Sidecar): CaptureMeta {
    return {
      contentType: sidecar.contentType || 'application/octet-stream',
      status: sidecar.status,
      ...(sidecar.status === 'body' ? { size: sidecar.contentLength } : {})
    };
  }

  async head(key: string): Promise<CaptureMeta | null> {
    const sidecar = await this.#sidecar(key);
    if (sidecar === null) return null;
    return FsStore.#metaOf(sidecar);
  }

  async get(key: string): Promise<Capture | CaptureMeta | null> {
    const sidecar = await this.#sidecar(key);
    if (sidecar === null) return null;
    const meta = FsStore.#metaOf(sidecar);
    // Bodiless statuses answer per their discriminator: complete metadata,
    // no body — there is no cap/ file to open, and fabricating one (empty
    // stream for a `redirect`, say) would be exactly the phantom body the
    // schema's status field exists to prevent.
    if (sidecar.status !== 'body') return meta;
    // The body lives at the digest its contentHash records. A contentHash
    // that is not a sha256 SRI throws here: rot is loud, never a miss.
    const body = `${this.#root}/${bodyPath(sidecar.contentHash as string)}`;
    // Open before streaming so a missing cap/ file is an explicit error that
    // names the sidecar and the body path it expected. Sidecar present,
    // status "body", body gone is a torn store or a root written before
    // bodies were content-addressed (its bodies sit under the capture-key
    // hash, which no reader consults). Either way it is never a silent miss.
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(body, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `FsStore: sidecar at ${await this.#metaFile(key)} names a missing body at ${body} (contentHash ${sidecar.contentHash}). ` +
            'A root written before content-addressed bodies needs a refetch.'
        );
      }
      throw error;
    }
    // Stream, don't buffer: bodies can be large and captures are immutable
    // (a same-key rewrite replaces bytes with identical bytes, and an open
    // handle across a concurrent rename still reads the old inode coherently
    // — SERVE.md, "Reading a root that is being written").
    // Readable.toWeb: https://nodejs.org/api/stream.html#streamreadabletowebstreamreadable-options
    return {
      ...meta,
      body: Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
    };
  }
}
