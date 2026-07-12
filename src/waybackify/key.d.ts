/**
 * Hand-authored declarations for key.js (#267) so render/wayback/src/key.ts
 * can re-export it under `tsc` without this package growing a TypeScript
 * toolchain. Keep in lockstep with key.js — three tiny signatures, no deps,
 * no DOM/Node types (this file typechecks under BOTH render/wayback
 * tsconfigs: types:["node"] and types:["@fastly/js-compute"]).
 */

/** Derive the capture key for a (timestamp, originalUrl) pair. */
export function captureKey(timestamp: string, originalUrl: string): string;

/**
 * SHA-256 hex of a capture key (64 lowercase hex chars) — the shared
 * identity token: Fastly KV item name minus `cap:`, and the #267 cache
 * layout's on-disk filename.
 */
export function captureHash(key: string): Promise<string>;

/** Derive the Fastly KV item name (`cap:` + sha256 hex) for a capture key. */
export function fastlyKVKey(key: string): Promise<string>;

/**
 * Encode capture metadata for a Fastly KV put({ metadata }); same object
 * shape as R2 httpMetadata. Throws on CR/LF or > 1000 encoded bytes.
 */
export function captureMetadata(meta: { contentType: string }): string;
