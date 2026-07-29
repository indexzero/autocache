/**
 * Hand-authored declarations for rewrite.js — the subset the serving core
 * (spv/waybackify-serve) imports for its serve-time `localize` option. Keep in
 * lockstep with rewrite.js; declare ONLY what is used (no deps, no DOM/Node
 * types, so this typechecks under BOTH the serve core's tsconfigs:
 * types:["node"] and types:["@fastly/js-compute"]).
 */

/** A corpus membership test: is a capture key one the server holds? */
export interface Corpus {
  has(key: string): boolean;
}

/**
 * Rewrite-rule version — bumped when matching/rewriting behavior changes, so a
 * remastered tree's build record can note which rules produced it.
 */
export const RULE_VERSION: number;

/**
 * Classify a capture's content type into the rewrite dialect that applies, or
 * null for "pass through untouched" (images, fonts, octet-stream, empty).
 */
export function classifyContentType(contentType: string): 'html' | 'css' | 'js' | null;

/**
 * Rewrite a capture body by its content type: localize wayback references whose
 * captures are in `corpus` to the root-relative `/web/<ts><flag>/<orig>` form.
 * HTML additionally has its injected chrome stripped internally. Unknown/binary
 * types pass through untouched.
 */
export function rewrite(
  contentType: string,
  text: string,
  corpus: Corpus
): { text: string; changed: boolean; count: number; dialect: 'html' | 'css' | 'js' | null };
