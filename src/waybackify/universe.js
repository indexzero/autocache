// The Universe concept — compile-time link policy.
//
// A Universe is the policy a corpus applies while GENERATING manifests:
//
//   {
//     "rewrites": { "<url>": "<replacement-url>", ... },
//     "exclude":  [ "<url-or-prefix>", ... ]
//   }
//
//   - `rewrites`: unconditional URL → URL substitutions (a domain move, a
//     canonical mirror) applied INSTEAD of archive resolution. Exact-match
//     on the URL as it appears in the source.
//   - `exclude`:  URLs to leave live, never resolved and never rewritten.
//     Each entry matches exactly OR as a prefix (the same rule the
//     frontmatter-skip convention always used), so one entry can cover a
//     whole path subtree.
//
// The Universe is never needed at rewrite time: manifest generation BAKES the
// relevant subset into each manifest (see `subset` below and
// manifest.js#generate), so a manifest is a standalone rewrite program for
// its one source file. That baking rule — a manifest carries only the
// rewrites/excludes whose URLs appear in ITS source — is what keeps
// manifests portable and the Universe free to evolve without invalidating
// previously generated manifests.

import fs from 'node:fs';

/** An empty Universe — the identity policy. */
export function emptyUniverse() {
  return { rewrites: {}, exclude: [] };
}

/**
 * Structurally validate a parsed Universe. Throws with `context` in the
 * message on the first violation; returns the normalized in-memory shape
 * ({ rewrites, exclude }, both always present).
 *
 * @param {unknown} raw
 * @param {string} [context] - label for error messages (usually a file path)
 * @returns {{ rewrites: Record<string,string>, exclude: string[] }}
 */
export function validateUniverse(raw, context = 'universe') {
  const bad = detail => new Error(`${context}: invalid universe — ${detail}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('not an object');
  }
  const { rewrites = {}, exclude = [] } = raw;
  if (rewrites === null || typeof rewrites !== 'object' || Array.isArray(rewrites)) {
    throw bad('`rewrites` must be an object of url → replacement-url');
  }
  for (const [url, target] of Object.entries(rewrites)) {
    if (typeof target !== 'string' || target.length === 0) {
      throw bad(`rewrite target for ${url} must be a non-empty string`);
    }
  }
  if (!Array.isArray(exclude) || exclude.some(u => typeof u !== 'string' || u.length === 0)) {
    throw bad('`exclude` must be an array of non-empty strings');
  }
  return { rewrites: { ...rewrites }, exclude: [...exclude] };
}

/**
 * Read + validate a Universe file. The file may carry either or both keys;
 * missing keys read as empty.
 *
 * @param {string} file
 * @returns {{ rewrites: Record<string,string>, exclude: string[] }}
 */
export function readUniverse(file) {
  return validateUniverse(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** True when `url` matches an exclude entry (exact or prefix). */
export function isExcluded(universe, url) {
  return universe.exclude.some(e => url === e || url.startsWith(e));
}

/**
 * Restrict a Universe to a concrete URL set — the subset-baking primitive.
 * Returns the policy EXPRESSED IN THE SOURCE'S OWN URLS:
 *
 *   - `exclude`:  the given urls (verbatim) that match an exclude entry —
 *     concrete URLs, not the universe's patterns, so the baked manifest is
 *     self-contained and exact.
 *   - `rewrites`: the url → replacement pairs for given urls the universe
 *     rewrites.
 *
 * Precedence mirrors rewrite time (exclude wins): a url matching both an
 * exclude entry and a rewrite is excluded, not rewritten — a URL claimed by
 * two policies fails safe.
 *
 * @param {{ rewrites: Record<string,string>, exclude: string[] }} universe
 * @param {Iterable<string>} urls
 * @returns {{ rewrites: Record<string,string>, exclude: string[] }}
 */
export function subset(universe, urls) {
  const out = emptyUniverse();
  for (const url of urls) {
    if (isExcluded(universe, url)) out.exclude.push(url);
    else if (Object.hasOwn(universe.rewrites, url)) out.rewrites[url] = universe.rewrites[url];
  }
  return out;
}
