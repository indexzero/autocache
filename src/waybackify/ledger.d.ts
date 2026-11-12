/**
 * Hand-authored declarations for ledger.js — the manifest-collection
 * concept — so a TypeScript consumer can import it under `tsc`
 * without this package growing a TypeScript toolchain (same pattern as
 * key.d.ts). Keep in lockstep with ledger.js.
 */

import type { Manifest } from './manifest.js';

/** One discovered manifest: root-relative path (identity) + parsed content. */
export interface DiscoveredManifest {
  file: string;
  /** For a capture list, the empty manifest. */
  manifest: Manifest;
  /** Present iff the file is a capture list (`captures.jsonl`). */
  captures?: CaptureRow[];
}

/** One capture-list row: a replay URL plus the producer's own provenance. */
export interface CaptureRow {
  wayback: string;
  /** Fetch order, lower first. */
  rank?: number;
  [field: string]: unknown;
}

/** One capture in an `against` worklist. */
export interface WorklistItem {
  key: string;
  waybackUrl: string;
  timestamp: string;
  originalUrl: string;
  files: string[];
  status: string | null;
  /** The sidecar's interstitial signature, when it has one. */
  signature?: string;
  /** Fetch order, lower first; 0 for a capture a manifest references. */
  rank: number;
}

/** The fetch-worklist join of a ledger against a cache root. */
export interface Worklists {
  unfetched: WorklistItem[];
  cached: WorklistItem[];
  interstitial: WorklistItem[];
  error: WorklistItem[];
}

/** The capture-list file name. */
export const CAPTURE_LIST: 'captures.jsonl';

/** Read + validate one capture list. */
export function readCaptureList(file: string): CaptureRow[];

/** Recursively discover every manifest and capture list under `root`. */
export function discover(root: string): DiscoveredManifest[];

/** Every capture the ledger references, deduped by capture key (no cache root). */
export function captures(discovered: DiscoveredManifest[]): WorklistItem[];

/** Union a discovered ledger into one manifest (the seen-file bootstrap). */
export function flatten(discovered: DiscoveredManifest[]): Manifest;

/** Classify every capture the ledger references by the cache root's sidecars. */
export function against(discovered: DiscoveredManifest[], cacheRoot: string): Promise<Worklists>;
