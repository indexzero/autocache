/**
 * Hand-authored declarations for enumerate.js so render/wayback/src/enumerate.ts
 * can re-export it under `tsc` without this package growing a TypeScript
 * toolchain (same pattern as key.d.ts). Keep in lockstep with enumerate.js.
 * Typechecks under BOTH render/wayback tsconfigs (types:["node"] and
 * types:["@fastly/js-compute"]) — pure data shapes, no DOM/Node globals.
 */

/** One corpus reference to one wayback capture. */
export interface WaybackRef {
  /** Post id relative to the words root, e.g. `1/043`. */
  post: string;
  /** Where the reference lives: prose markdown or the wayback.json ledger. */
  source: 'inline' | 'ledger';
  /** Capture timestamp, as parsed from the wayback URL itself. */
  timestamp: string;
  /** The archived original URL embedded in the wayback URL. */
  originalUrl: string;
  /** The wayback URL exactly as the corpus references it. */
  waybackUrl: string;
}

/** Roll-up counts for reporting (the corpus audit's scope numbers). */
export interface WaybackRefSummary {
  total: number;
  inline: number;
  ledger: number;
  /** Distinct (timestamp, originalUrl) pairs — i.e. captures to audit/mirror. */
  uniqueCaptures: number;
  /** Distinct posts referencing at least one capture. */
  posts: number;
}

/** Extract every web.archive.org/web/ URL from markdown text. */
export function extractArchiveUrls(markdown: string): string[];

/** Enumerate every wayback reference under a words root (deduped, ordered). */
export function enumerateCorpus(wordsDir: string): WaybackRef[];

/** Enumerate one markdown file's wayback references — the manifest unit. */
export function enumerateFile(filePath: string, options?: { ledger?: boolean }): WaybackRef[];

/** Derive a post id (`words/<series>/<mono>` or the path) from a file path. */
export function postIdForPath(filePath: string): string;

/** Roll a ref list up into the reporting counts. */
export function summarize(refs: WaybackRef[]): WaybackRefSummary;
