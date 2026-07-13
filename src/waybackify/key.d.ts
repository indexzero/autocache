/**
 * Hand-authored declarations for key.js so render/wayback/src/key.ts
 * can re-export it under `tsc` without this package growing a TypeScript
 * toolchain. Keep in lockstep with key.js — no deps,
 * no DOM/Node types (this file typechecks under BOTH render/wayback
 * tsconfigs: types:["node"] and types:["@fastly/js-compute"]).
 */

/** Derive the capture key for a (timestamp, originalUrl) pair. */
export function captureKey(timestamp: string, originalUrl: string): string;

/**
 * SHA-256 hex of a capture key (64 lowercase hex chars) — the shared
 * identity token: the bucket object key's <hash> and the local cache
 * layout's on-disk filename, one and the same.
 */
export function captureHash(key: string): Promise<string>;

/**
 * Rootless body object key for a capture key: `cap/<aa>/<hash>` (always
 * `/`-joined — an object key, not an OS path; consumers join it under a root
 * themselves). The shared source of truth for the `<aa>`-sharded layout.
 */
export function capturePath(key: string): Promise<string>;

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
