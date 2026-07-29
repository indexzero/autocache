/**
 * S3-compatible read-only Store — one impl for anywhere S3 lives: Fastly
 * Object Storage, Cloudflare R2's S3 API, or AWS S3 itself. It is the remote
 * read path the bucket-sync milestone needs from BOTH Node (local
 * remote-serving) and Fastly Compute (where Object Storage has no SDK binding —
 * every read is a SigV4-signed origin fetch).
 *
 * The layout is the local layout verbatim (src/key.ts): the object key is
 * `cap/<aa>/<hash>` (derived by capturePath), so a bucket is a byte-for-byte
 * projection of a `waybackify cache` root and `s3 ls` reads like the serving
 * path. Metadata is HYBRID and this store reads only the SERVING half:
 *
 *   - Content-Type   the object's native Content-Type response header,
 *                    normalized (`''`/absent → application/octet-stream) exactly
 *                    as FsStore/MemoryStore normalize on read — the same mask
 *                    the store-conformance suite holds every backend to.
 *   - status         the `x-amz-meta-status` response header (absent → `body`,
 *                    the R2/KV back-compat default). A bodiless status
 *                    (empty/redirect/error/interstitial) is a zero-byte object answered
 *                    METADATA-ONLY — the zero-byte body is never surfaced as
 *                    content, the same discrimination FsStore performs over its
 *                    sidecar.
 *
 * The `meta/<aa>/<hash>.json` sidecar objects exist in the bucket too (DAG
 * durability for GC), but serving never reads them — one HEAD/GET answers.
 *
 * WebCrypto SigV4 only (src/sigv4.ts) — ZERO `node:` imports, ENFORCED by the
 * no-Node-types tsconfig graph (tsconfig.fastly.json's `files`). Credentials
 * arrive at construction from env/secret stores, never from code or config.
 *
 * FASTLY BACKEND SEAM (`fetchOptions`) — Fastly Compute's `fetch` REQUIRES a
 * named `backend` option, so every request merges `fetchOptions` (e.g.
 * `{ backend: 'object-storage' }`) into its init. The Fastly WIRING landed in
 * #288 (src/fastly.ts passes `fetchOptions: { backend: 'object-storage' }`,
 * fastly.toml declares the backend); whether stock `aws4fetch` could carry
 * that option was INCONCLUSIVE (its AwsClient.fetch calls `fetch(request)`
 * with no init, so a backend would have to survive on the Request across
 * construction), which is why this store hand-rolls the signer and owns the
 * seam outright: the option is set on the fetch init directly. VERIFICATION
 * STATUS (#377): the `backend` passthrough is now EXERCISED under Viceroy
 * (`fastly compute serve` over the js-compute-built wasm). A capture request
 * dispatches the signed fetch to the named backend `object-storage`; Viceroy
 * routes it there and fails only at DNS because the local endpoint is a
 * placeholder host — proving the seam this store owns: the `backend` option
 * survives into the fetch init and is honored by the runtime. What still awaits
 * the FIRST REAL COMPUTE DEPLOY (or a local S3 stand-in) is the object
 * ROUND-TRIP — a signed HEAD/GET returning bytes over a real endpoint.
 */

import { capturePath } from '@charlie.dev/waybackify/key.js';
import { signRequest, type SigV4Credentials } from './sigv4.ts';
import type { Capture, CaptureMeta, CaptureStatus, Store } from './store.ts';

/**
 * The request init this store hands to the platform `fetch`. Deliberately
 * looser than the standard `RequestInit`: it is an open bag so a runtime-specific
 * member (Fastly Compute's required `backend`, merged from
 * {@link S3StoreConfig.fetchOptions}) rides through untyped — the standard lib
 * `RequestInit` has no such field.
 */
export interface S3FetchInit {
  method: string;
  headers: Record<string, string>;
  /** Runtime passthrough — e.g. Fastly's required `backend`. */
  [option: string]: unknown;
}

export interface S3StoreConfig {
  /** Base endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. Path-style. */
  endpoint: string;
  bucket: string;
  region: string;
  credentials: SigV4Credentials;
  /** Optional key prefix within the bucket (slashes trimmed). */
  prefix?: string;
  /**
   * Extra fetch-init members merged into EVERY request — the seam for Fastly
   * Compute's required named `backend` (#288). Never carries credentials.
   */
  fetchOptions?: Record<string, unknown>;
}

export class S3Store implements Store {
  #config: S3StoreConfig;

  constructor(config: S3StoreConfig) {
    this.#config = config;
  }

  async head(key: string): Promise<CaptureMeta | null> {
    const response = await this.#send('HEAD', await capturePath(key));
    if (response === null) return null;
    // HEAD carries no body; still cancel defensively in case a backend streams.
    await response.body?.cancel();
    return metaOf(response);
  }

  async get(key: string): Promise<Capture | CaptureMeta | null> {
    const response = await this.#send('GET', await capturePath(key));
    if (response === null) return null;
    const meta = metaOf(response);
    if (meta.status !== 'body') {
      // Bodiless status: a COMPLETE entry answered metadata-only — the
      // zero-byte object body is never surfaced as content. Cancel the stream
      // so it doesn't leak.
      await response.body?.cancel();
      return meta;
    }
    // Stream the body — captures can be large. A GET with no body on a `body`
    // entry is a torn bucket; an empty stream reads back as empty bytes, which
    // is the object's true content (population never writes a bodied object
    // with zero bytes), so no phantom is fabricated here.
    return { ...meta, body: response.body ?? new Uint8Array() };
  }

  /** Object URL: path-style `<endpoint>/<bucket>/<prefix?>/<objectKey>`. */
  #url(objectKey: string): string {
    const prefix = this.#config.prefix ? `${trimSlashes(this.#config.prefix)}/` : '';
    return `${this.#config.endpoint.replace(/\/+$/, '')}/${this.#config.bucket}/${prefix}${objectKey}`;
  }

  /**
   * Sign + send one read. 404 is the ONE AND ONLY miss (absent object). Any
   * other non-2xx — 403 (auth/permission), 5xx (outage), … — THROWS: a fault
   * must never masquerade as a miss (which the app would turn into a 302, the
   * wrong answer for an outage). Mirrors FsStore's "rot is loud".
   */
  async #send(method: string, objectKey: string): Promise<Response | null> {
    const url = this.#url(objectKey);
    const headers = await signRequest({
      method,
      url,
      region: this.#config.region,
      service: 's3',
      credentials: this.#config.credentials
      // payloadHash defaults to UNSIGNED-PAYLOAD — the reads carry no body.
    });
    // The store calls the PLATFORM `fetch` directly — retry, when wanted, is
    // composed at the global dispatcher (the `bucket verify` handler), never injected here.
    // fetchOptions first so the signed method/headers can't be clobbered; the
    // merged init rides through the open-bag cast so Fastly's `backend` survives.
    const init: S3FetchInit = { ...this.#config.fetchOptions, method, headers };
    const response = await fetch(url, init as RequestInit);
    if (response.status === 404) return null;
    if (!response.ok) {
      // Drain any error body so the connection isn't left hanging.
      await response.body?.cancel();
      throw new Error(`S3Store: ${method} ${objectKey} → ${response.status} ${response.statusText}`);
    }
    return response;
  }
}

/**
 * CaptureMeta from an S3 response. Content-Type is the native header,
 * normalized per the shared read mask; status is x-amz-meta-status (absent →
 * `body`); size (bodied only) is Content-Length when present.
 */
function metaOf(response: Response): CaptureMeta {
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
  const status = toStatus(response.headers.get('x-amz-meta-status'));
  if (status !== 'body') return { contentType, status };
  const length = response.headers.get('Content-Length');
  return length === null ? { contentType, status } : { contentType, status, size: Number(length) };
}

/** x-amz-meta-status → CaptureStatus; absent/unrecognized → `body` (R2/KV default). */
function toStatus(raw: string | null): CaptureStatus {
  return raw === 'empty' || raw === 'redirect' || raw === 'error' || raw === 'interstitial' ? raw : 'body';
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}
