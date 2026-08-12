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
 *   <root>/cap/<aa>/<hash>          body bytes, verbatim, no extension
 *   <root>/meta/<aa>/<hash>.json    authoritative sidecar (canonical JSON)
 *
 *   hash = sha256hex(captureKey), aa = hash.slice(0, 2)
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

import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
// Always derive names through the shared key module — never hand-roll the
// digest. The pinned digest of '20140403040000/http://example.com/' exists
// in both packages' suites (and in the committed fixture root) precisely to
// catch a consumer deriving its own variant.
import { capturePath, metaPath } from '@autocache/waybackify/key.js';
import type { Capture, CaptureMeta, CaptureStatus, Store } from './store.ts';

/**
 * The sidecar schema versions this reader accepts (CACHE.md). v2 (#363) added
 * the `interstitial` status; v3 added the optional `dynamic[]` array (browser-
 * discovered requisites). Each is a backward-compatible superset, so v1 (the
 * existing corpus), v2, and v3 roots all read here. The serve reader does NOT
 * consume `dynamic` — it is a fetch/verify fact, not a serve fact — but must
 * accept v3 roots rather than fail loud on them. A version outside the set is
 * genuinely unknown and fails loud — never a silent miss.
 */
const SUPPORTED_SIDECAR_VERSIONS = new Set([1, 2, 3]);

/** The slice of a v1 sidecar this store consumes. */
interface Sidecar {
  v: number;
  key: string;
  contentType: string;
  status: CaptureStatus;
  /** Present iff status === 'body'. */
  contentLength?: number;
}

export class FsStore implements Store {
  #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** meta/<aa>/<hash>.json and cap/<aa>/<hash> for a capture key. */
  async #paths(key: string): Promise<{ meta: string; body: string }> {
    // The `<aa>`-sharded object keys come from the shared key module (the one
    // source of truth for the layout / bucket-key contract); this store joins
    // them under its root with the same `/` separator the writer uses. These
    // rootless keys are already `/`-joined — this is a local path, not an
    // object key, so the `${root}/` prefix stays here and never in the key.
    return {
      meta: `${this.#root}/${await metaPath(key)}`,
      body: `${this.#root}/${await capturePath(key)}`
    };
  }

  /**
   * Read + validate the sidecar — the single existence check. ENOENT is the
   * one and only "absent" signal; anything else that goes wrong with a file
   * that EXISTS propagates loudly (rot must not masquerade as a miss).
   */
  async #sidecar(key: string): Promise<Sidecar | null> {
    const { meta } = await this.#paths(key);
    let raw: string;
    try {
      raw = await fsp.readFile(meta, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const sidecar = JSON.parse(raw) as Sidecar;
    // Same authenticity checks the writer's own reader performs: the file at
    // this hash-derived path must claim this key and a known schema version.
    if (!SUPPORTED_SIDECAR_VERSIONS.has(sidecar.v)) {
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
    const { body } = await this.#paths(key);
    // Stream, don't buffer: bodies can be large and captures are immutable
    // (a same-key rewrite replaces bytes with identical bytes, and an open
    // handle across a concurrent rename still reads the old inode coherently
    // — SERVE.md, "Reading a root that is being written"). A missing cap/
    // file HERE — sidecar present, status "body", body gone — is disk rot
    // and surfaces as a loud stream error, never a silent miss.
    // Readable.toWeb: https://nodejs.org/api/stream.html#streamreadabletowebstreamreadable-options
    return {
      ...meta,
      body: Readable.toWeb(createReadStream(body)) as ReadableStream<Uint8Array>
    };
  }
}
