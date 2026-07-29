/**
 * Hand-authored declarations for strip.js so the serving core
 * (spv/waybackify-serve) and rewrite.js consumers can import it under `tsc`
 * without this package growing a TypeScript toolchain. Keep in lockstep with
 * strip.js — no deps, no DOM/Node types (this typechecks under BOTH the
 * serving core's tsconfigs: types:["node"] and types:["@fastly/js-compute"]).
 */

/** Strip the Wayback Machine's injected chrome from a replayed HTML capture. */
export function stripWaybackChrome(html: string): string;
