// The Universe concept — compile-time link policy.
//
// A Universe is the policy a corpus applies while GENERATING manifests:
//
//   {
//     "rewrites": { "<url>": "<replacement-url>", ... },
//     "exclude":  [ "<url-or-prefix>", ... ],
//     "fqdns":    { "<host>": { "<behavior>": "<value>" }, ... }
//   }
//
//   - `rewrites`: unconditional URL → URL substitutions (a domain move, a
//     canonical mirror) applied INSTEAD of archive resolution. Exact-match
//     on the URL as it appears in the source.
//   - `exclude`:  URLs to leave live, never resolved and never rewritten.
//     Each entry matches exactly OR as a prefix (the same rule the
//     frontmatter-skip convention always used), so one entry can cover a
//     whole path subtree.
//   - `fqdns`:    custom behavior per host. One place to say that the
//     urls on a host get special handling, for example
//     `"github.com": { "on404": "probe-repo-root-follow-rename" }`.
//     Keys are bare lowercase FQDNs. Behaviors and their values come from
//     the closed FQDN_BEHAVIORS table, so a typo fails loud. Use
//     fqdnBehavior(universe, url) to look one up. Like the rest of the
//     Universe, it is generation-time policy only. `subset` never bakes it
//     into a manifest, and no rewrite-time engine reads it.
//
// The Universe is never needed at rewrite time: manifest generation BAKES the
// relevant subset into each manifest (see `subset` below and
// manifest.js#generate), so a manifest is a standalone rewrite program for
// its one source file. That baking rule — a manifest carries only the
// rewrites/excludes whose URLs appear in ITS source — is what keeps
// manifests portable and the Universe free to evolve without invalidating
// previously generated manifests.

import fs from 'node:fs';

/**
 * The known per-FQDN behaviors: behavior name → its allowed values. A
 * universe that names anything else fails validation.
 *
 *   - `on404`: what a 404 from this host means.
 *     `probe-repo-root-follow-rename` probes the repo root and follows a
 *     rename before the url counts as gone (the github.com case).
 */
export const FQDN_BEHAVIORS = Object.freeze({
  on404: Object.freeze(['probe-repo-root-follow-rename'])
});

// A bare lowercase FQDN: two or more dot-separated LDH labels, no scheme,
// port, path, or trailing root dot.
const FQDN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** An empty Universe — the identity policy. */
export function emptyUniverse() {
  return { rewrites: {}, exclude: [], fqdns: {} };
}

/**
 * Structurally validate a parsed Universe. Throws with `context` in the
 * message on the first violation; returns the normalized in-memory shape
 * ({ rewrites, exclude, fqdns }, all always present).
 *
 * @param {unknown} raw
 * @param {string} [context] - label for error messages (usually a file path)
 * @returns {{ rewrites: Record<string,string>, exclude: string[],
 *   fqdns: Record<string, Record<string,string>> }}
 */
export function validateUniverse(raw, context = 'universe') {
  const bad = detail => new Error(`${context}: invalid universe — ${detail}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('not an object');
  }
  const { rewrites = {}, exclude = [], fqdns = {} } = raw;
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
  if (fqdns === null || typeof fqdns !== 'object' || Array.isArray(fqdns)) {
    throw bad('`fqdns` must be an object of host → behaviors');
  }
  const outFqdns = {};
  for (const [host, behaviors] of Object.entries(fqdns)) {
    if (!FQDN_RE.test(host)) throw bad(`fqdns key ${JSON.stringify(host)} is not a bare lowercase FQDN`);
    if (behaviors === null || typeof behaviors !== 'object' || Array.isArray(behaviors)) {
      throw bad(`behavior for ${host} must be an object of behavior → value`);
    }
    for (const [name, value] of Object.entries(behaviors)) {
      const allowed = Object.hasOwn(FQDN_BEHAVIORS, name) ? FQDN_BEHAVIORS[name] : null;
      if (allowed === null) throw bad(`unknown behavior \`${name}\` for ${host}`);
      if (!allowed.includes(value)) {
        throw bad(`unknown value ${JSON.stringify(value)} for \`${name}\` on ${host} (known: ${allowed.join(', ')})`);
      }
    }
    outFqdns[host] = { ...behaviors };
  }
  return { rewrites: { ...rewrites }, exclude: [...exclude], fqdns: outFqdns };
}

/**
 * Read + validate a Universe file. The file can carry any of its keys.
 * A missing key reads as empty.
 *
 * @param {string} file
 * @returns {ReturnType<typeof validateUniverse>}
 */
export function readUniverse(file) {
  return validateUniverse(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** True when `url` matches an exclude entry (exact or prefix). */
export function isExcluded(universe, url) {
  return universe.exclude.some(e => url === e || url.startsWith(e));
}

/**
 * The behaviors the Universe defines for the host of `url`, or null. The
 * match is on the exact host, case-insensitive, without a trailing root dot.
 * A subdomain does not inherit its parent's behaviors.
 *
 * @param {{ fqdns: Record<string, Record<string,string>> }} universe
 * @param {string} url
 * @returns {Record<string,string> | null}
 */
export function fqdnBehavior(universe, url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
  return Object.hasOwn(universe.fqdns, host) ? universe.fqdns[host] : null;
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
 * two policies fails safe. `fqdns` is never baked: it is generation-time
 * behavior, not a rewrite.
 *
 * @param {{ rewrites: Record<string,string>, exclude: string[] }} universe
 * @param {Iterable<string>} urls
 * @returns {{ rewrites: Record<string,string>, exclude: string[] }}
 */
export function subset(universe, urls) {
  const out = { rewrites: {}, exclude: [] };
  for (const url of urls) {
    if (isExcluded(universe, url)) out.exclude.push(url);
    else if (Object.hasOwn(universe.rewrites, url)) out.rewrites[url] = universe.rewrites[url];
  }
  return out;
}
