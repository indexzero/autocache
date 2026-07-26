/**
 * Hand-authored declarations for ledger.js — the manifest-collection
 * concept — so render/wayback's TypeScript can import it under `tsc`
 * without this package growing a TypeScript toolchain (same pattern as
 * key.d.ts). Keep in lockstep with ledger.js.
 */

import type { Manifest } from './manifest.js';

/** One discovered manifest: root-relative path (identity) + parsed content. */
export interface DiscoveredManifest {
  file: string;
  manifest: Manifest;
}

/** One capture in an `against` worklist. */
export interface WorklistItem {
  key: string;
  waybackUrl: string;
  timestamp: string;
  originalUrl: string;
  files: string[];
  status: string | null;
}

/** The fetch-worklist join of a ledger against a cache root. */
export interface Worklists {
  unfetched: WorklistItem[];
  cached: WorklistItem[];
  interstitial: WorklistItem[];
  error: WorklistItem[];
}

/** Recursively discover every wayback.json manifest under `root`. */
export function discover(root: string): DiscoveredManifest[];

/** Union a discovered ledger into one manifest (the seen-file bootstrap). */
export function flatten(discovered: DiscoveredManifest[]): Manifest;

/** Classify every capture the ledger references by the cache root's sidecars. */
export function against(discovered: DiscoveredManifest[], cacheRoot: string): Promise<Worklists>;
