/**
 * Hand-authored declarations for manifest.js so render/wayback's TypeScript
 * can import it under `tsc` without this package growing a TypeScript
 * toolchain (same pattern as key.d.ts). Keep in lockstep with manifest.js.
 * Typechecks under BOTH render/wayback tsconfigs (types:["node"] and
 * types:["@fastly/js-compute"]) — pure data shapes, no DOM/Node globals.
 */

/** One archive resolution: url → its replay capture. */
export interface ManifestEntry {
  wayback: string;
  timestamp: string;
  checkedAt?: string;
}

/** The in-memory Manifest (normalized schema v2; see manifest.js header). */
export interface Manifest {
  version: number;
  rewrites: Record<string, string>;
  entries: Record<string, ManifestEntry>;
  exclude: string[];
}

/** One wayback reference of one source file (paths are identity). */
export interface SourceRef {
  /** The source file path, exactly as given. */
  path: string;
  /** Where the reference lives: prose markdown or the sibling manifest. */
  source: 'inline' | 'manifest';
  /** Capture timestamp, as parsed from the wayback URL itself. */
  timestamp: string;
  /** The archived original URL embedded in the wayback URL. */
  originalUrl: string;
  /** The wayback URL exactly as spelled. */
  waybackUrl: string;
}

/** The schema version new writes stamp. */
export const MANIFEST_VERSION: number;

/** Versions readers understand ({1, 2}). */
export const SUPPORTED_MANIFEST_VERSIONS: ReadonlySet<number>;

/** An empty manifest — the in-memory canonical shape. */
export function emptyManifest(): Manifest;

/** Validate + normalize a parsed manifest (v1 or v2; v1 nulls → exclude). */
export function validateManifest(raw: unknown, context?: string): Manifest;

/** Read + validate a manifest file (versions {1, 2} accepted). */
export function readManifest(file: string): Manifest;

/** Write a manifest as canonical schema v2. */
export function writeManifest(file: string, manifest: Manifest): void;

/** Extract every web.archive.org/web/ URL from markdown text. */
export function extractArchiveUrls(markdown: string): string[];

/** Enumerate one markdown file's wayback references (deduped, ordered). */
export function sourceRefs(filePath: string, options?: { manifest?: boolean }): SourceRef[];

/** Apply a manifest to a source (exclude → rewrites → entries → warn). */
export function apply(source: string, manifest: Manifest): { content: string; warnings: string[] };
