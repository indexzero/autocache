/**
 * Hand-authored declarations for key.js so a TypeScript consumer
 * can import it under `tsc` without this package growing a TypeScript
 * toolchain. Keep in lockstep with key.js — no deps,
 * no DOM/Node types (this file typechecks under both a Node and a
 * DOM-less tsconfig: types:["node"] and types:["@fastly/js-compute"]).
 */

/** Derive the capture key for a (timestamp, originalUrl) pair. */
export function captureKey(timestamp: string, originalUrl: string): string;

/**
 * SHA-256 hex of a capture key (64 lowercase hex chars) — the shared
 * identity token: the bucket object key's <hash> and the local sidecar
 * filename, one and the same.
 */
export function captureHash(key: string): Promise<string>;

/**
 * Rootless BUCKET body object key for a capture key: `cap/<aa>/<hash>`
 * (always `/`-joined — an object key, not an OS path). A local cache root
 * stores bodies at bodyPath() instead.
 */
export function capturePath(key: string): Promise<string>;

/**
 * Rootless LOCAL body key for an SRI contentHash: `cap/<dd>/<digest>`, the
 * SHA-256 hex of the body bytes. Throws on a value that is not a sha256 SRI.
 */
export function bodyPath(contentHash: string): string;

/**
 * Rootless sidecar object key for a capture key: `meta/<aa>/<hash>.json`
 * (always `/`-joined — see capturePath).
 */
export function metaPath(key: string): Promise<string>;

/**
 * Assert a contentType is safe to carry as sync-time object metadata (no
 * CR/LF, ≤ 1000 encoded bytes) and return it — the shared commit-time +
 * sync-time validator (cache.js#commitEntry and the bucket-sync emitter).
 * Throws if unsafe.
 */
export function assertMetadataSafe(contentType: string): string;
