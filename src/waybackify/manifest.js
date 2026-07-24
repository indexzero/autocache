// The Manifest concept — wayback.json made code.
//
// A manifest is a STANDALONE REWRITE PROGRAM for one source file: everything
// needed to turn the pristine source (live links) into its published form
// (archived links), with no corpus conventions and no compile-time policy in
// sight. Schema v2:
//
//   {
//     "version": 2,
//     "rewrites": { "<url>": "<replacement-url>", ... },     // optional
//     "entries":  { "<url>": { "wayback": "<replay-url>",
//                              "timestamp": "<YYYYMMDDHHMMSS>",
//                              "checkedAt": "<ISO-8601>" }, ... },
//     "exclude":  [ "<url>", ... ]                            // optional
//   }
//
//   - `entries`:  archive resolutions — rewrite each url to its `wayback`
//     replay URL. Every `wayback` is non-null and parseable; "checked, not
//     archived" is NOT an entry state in v2 (see `exclude`).
//   - `rewrites`: unconditional url → url substitutions, baked from the
//     Universe subset whose URLs appear in THIS source (universe.js).
//   - `exclude`:  urls deliberately left untouched — policy-live links AND
//     confirmed-not-archived links. This replaces schema v1's
//     `wayback: null` convention outright.
//
// Readers accept versions {1, 2}: a v1 file ({ version: 1, entries } with
// possible `wayback: null` entries) reads as a v2 manifest whose null
// entries became `exclude` — the legacy-exclude migration rule. A version
// outside {1, 2} fails loud, never silently treated as understood.
//
// Rewrite precedence (apply): exclude → rewrites → entries → untouched+warn.
// A URL claimed by two sections fails safe (the earlier, more conservative
// section wins); a URL claimed by none is surfaced, never guessed at.
//
// Provenance: `apply` generalizes the importer's proven normalize equation
// (index.md ≡ apply(README.md, wayback.json)) — same delimiter-bounded URL
// matching, same scheme/slash/port-insensitive match key, same fenced-code
// and link-text guards — so applying a v1-read manifest reproduces the old
// pipeline's output byte-for-byte.

import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from './audit.js';
import { WaybackMachine, extractLinks } from './index.js';
import { emptyUniverse, isExcluded, subset } from './universe.js';

/** The schema version new writes stamp. */
export const MANIFEST_VERSION = 2;

/** Versions readers understand. Anything else is unknown → loud failure. */
export const SUPPORTED_MANIFEST_VERSIONS = Object.freeze(new Set([1, 2]));

/** An empty manifest — the in-memory canonical shape. */
export function emptyManifest() {
  return { version: MANIFEST_VERSION, rewrites: {}, entries: {}, exclude: [] };
}

/**
 * Structurally validate a parsed manifest (schema v1 OR v2) and return the
 * normalized in-memory shape: `{ version: 2, rewrites, entries, exclude }`,
 * all sections present, no `wayback: null` entries (v1 nulls become
 * `exclude`). Throws with `context` in the message on the first violation.
 *
 * @param {unknown} raw
 * @param {string} [context] - label for error messages (usually a file path)
 * @returns {{ version: number, rewrites: Record<string,string>,
 *   entries: Record<string,{wayback:string,timestamp:string,checkedAt?:string}>,
 *   exclude: string[] }}
 */
export function validateManifest(raw, context = 'manifest') {
  const bad = detail => new Error(`${context}: invalid manifest — ${detail}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('not an object');
  }
  const version = raw.version;
  if (!SUPPORTED_MANIFEST_VERSIONS.has(version)) {
    throw bad(`unsupported version ${JSON.stringify(version)} (supported: 1, 2)`);
  }
  const { rewrites = {}, entries = {}, exclude = [] } = raw;
  if (rewrites === null || typeof rewrites !== 'object' || Array.isArray(rewrites)) {
    throw bad('`rewrites` must be an object of url → replacement-url');
  }
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw bad('`entries` must be an object of url → { wayback, timestamp }');
  }
  if (!Array.isArray(exclude) || exclude.some(u => typeof u !== 'string' || u.length === 0)) {
    throw bad('`exclude` must be an array of non-empty strings');
  }
  for (const [url, target] of Object.entries(rewrites)) {
    if (typeof target !== 'string' || target.length === 0) {
      throw bad(`rewrite target for ${url} must be a non-empty string`);
    }
  }

  const out = emptyManifest();
  out.rewrites = { ...rewrites };
  out.exclude = [...exclude];
  for (const [url, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') {
      throw bad(`entry for ${url} must be an object`);
    }
    if (entry.wayback == null) {
      // v1's "checked, not archived" state — the legacy-exclude migration
      // rule. (Tolerated in a v2 file too: the meaning is unambiguous, and
      // refusing it would strand any hand-edited manifest.)
      out.exclude.push(url);
      continue;
    }
    if (typeof entry.wayback !== 'string' || parseWaybackUrl(entry.wayback) === null) {
      // An unparseable replay URL is a capture no mirror could ever serve —
      // a corpus defect to fix at the source, never to skip silently.
      throw bad(`entry for ${url} has an unparseable wayback URL: ${entry.wayback}`);
    }
    out.entries[url] = { ...entry };
  }
  return out;
}

/**
 * Read + validate a manifest file (versions {1, 2} accepted; v1 nulls read
 * as `exclude`). Returns the normalized in-memory shape.
 *
 * @param {string} file
 * @returns {ReturnType<typeof validateManifest>}
 */
export function readManifest(file) {
  return validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/**
 * Normalize a manifest into its canonical schema-v2 JSON shape: `version`
 * first, then (only when non-empty) `rewrites`, then `entries`, then (only
 * when non-empty) `exclude`; url keys sorted, `exclude` deduped. This is THE
 * serialization order — writeManifest stringifies exactly this object, and
 * anything else that prints a manifest (e.g. `ledger --flatten` on stdout)
 * goes through it too, so there is one canonical form, not two.
 *
 * @param {object} manifest - in-memory shape (validated on entry)
 * @param {string} [context] - label for validation errors
 * @returns {object} a plain object ready for JSON.stringify
 */
export function canonicalize(manifest, context = 'manifest') {
  const m = validateManifest(manifest, context);
  const sortKeys = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
  const out = { version: MANIFEST_VERSION };
  if (Object.keys(m.rewrites).length > 0) out.rewrites = sortKeys(m.rewrites);
  out.entries = sortKeys(m.entries);
  if (m.exclude.length > 0) out.exclude = [...new Set(m.exclude)].sort();
  return out;
}

/**
 * Write a manifest as canonical schema v2 (see canonicalize); 2-space indent
 * + trailing newline (the same on-disk convention the corpus always used).
 *
 * @param {string} file
 * @param {object} manifest - in-memory shape (validated before writing)
 */
export function writeManifest(file, manifest) {
  fs.writeFileSync(file, `${JSON.stringify(canonicalize(manifest, file), null, 2)}\n`);
}

/* ------------------------------------------------------------------------ *
 * Source scanning
 * ------------------------------------------------------------------------ */

/**
 * Extract every web.archive.org/web/ URL from markdown text — the scanner
 * for ALREADY-APPLIED sources (extractLinks in index.js is its dual: the
 * live, not-yet-resolved links `generate` starts from).
 *
 * Deliberately NOT a markdown parse — a scanner that starts at each
 * `http(s)://web.archive.org/web/` occurrence and consumes forward until a
 * character that ends a URL in every markdown context real corpora use:
 * whitespace/newline ends reference definitions, `>` ends autolinks, `"`/`'`
 * end titled links, `]` ends a bare-bracket label, and `)` ends an inline
 * destination — but only at paren depth 0, because CommonMark allows BALANCED
 * parens inside destinations and real content exercises that (the
 * msdn.microsoft.com/...dd129517(VS.85).aspx style URLs).
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractArchiveUrls(markdown) {
  const urls = [];
  const startRe = /https?:\/\/web\.archive\.org\/web\//gi;

  for (let m = startRe.exec(markdown); m !== null; m = startRe.exec(markdown)) {
    let depth = 0;
    let end = m.index;
    scan: for (; end < markdown.length; end += 1) {
      const ch = markdown[end];
      switch (ch) {
        case '(':
          depth += 1;
          break;
        case ')':
          if (depth === 0) break scan;
          depth -= 1;
          break;
        case ' ':
        case '\t':
        case '\n':
        case '\r':
        case '<':
        case '>':
        case '"':
        case "'":
        case '`':
        case ']':
          break scan;
      }
    }
    urls.push(markdown.slice(m.index, end));
    startRe.lastIndex = end;
  }

  return urls;
}

/**
 * @typedef {Object} SourceRef
 * @property {string} path - The source file path, exactly as given — file
 *   paths are identity here; no directory-layout conventions.
 * @property {'inline'|'manifest'} source - Where the reference lives: prose
 *   markdown, or the sibling manifest's entries.
 * @property {string} timestamp - Capture timestamp, parsed from the URL itself.
 * @property {string} originalUrl - The archived original URL embedded in the URL.
 * @property {string} waybackUrl - The wayback URL exactly as spelled.
 */

/**
 * Enumerate the wayback references of one markdown source file, deduped per
 * (source, capture) and deterministically ordered (source, then timestamp,
 * then originalUrl). Inline links only by default; `manifest: true` also
 * folds in the sibling `wayback.json` entries (excluded urls reference
 * nothing and are rightly absent).
 *
 * Throws — loudly, with path + URL context — if an inline reference does not
 * parse with the wayback-URL parser: an unparseable wayback URL is a URL no
 * mirror could serve, and the fix belongs in the content, not in silent
 * skipping here.
 *
 * @param {string} filePath - path to a markdown file
 * @param {Object} [options]
 * @param {boolean} [options.manifest=false] - fold in the sibling wayback.json
 * @returns {SourceRef[]}
 */
export function sourceRefs(filePath, { manifest = false } = {}) {
  const refs = new Map();
  const add = (source, url) => {
    const parsed = parseWaybackUrl(url);
    if (parsed === null) {
      throw new Error(`${filePath} (${source}): unparseable wayback URL: ${url}`);
    }
    const key = [source, parsed.timestamp, parsed.original].join(' ');
    if (!refs.has(key)) {
      refs.set(key, {
        path: filePath,
        source,
        timestamp: parsed.timestamp,
        originalUrl: parsed.original,
        waybackUrl: url
      });
    }
  };

  const markdown = readText(filePath);
  if (markdown !== null) {
    for (const url of extractArchiveUrls(markdown)) add('inline', url);
  }

  if (manifest) {
    const sibling = path.join(path.dirname(filePath), 'wayback.json');
    if (fs.existsSync(sibling)) {
      for (const entry of Object.values(readManifest(sibling).entries)) {
        add('manifest', entry.wayback);
      }
    }
  }

  return [...refs.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.timestamp.localeCompare(b.timestamp) ||
      a.originalUrl.localeCompare(b.originalUrl)
  );
}

/* ------------------------------------------------------------------------ *
 * generate — source + universe (+ seen) → manifest
 * ------------------------------------------------------------------------ */

/**
 * Generate a manifest for one markdown source.
 *
 * Classification per extracted live URL, in order:
 *
 *   1. Universe policy (no network): an excluded url is baked into
 *      `exclude`; a rewritten url is baked into `rewrites` — the subset
 *      rule: only THIS source's urls carry policy into the manifest.
 *   2. The seen file (no network): a previously resolved url — matched
 *      scheme/slash/port-insensitively, so respellings stay idempotent —
 *      copies its verdict (entry or exclude) straight in.
 *   3. The archive: `resolve(url, { near })` (injectable; defaults to
 *      WaybackMachine#getSnapshot — the CDX plumbing). A snapshot becomes an
 *      entry; a clean "not archived" becomes `exclude`. Either way the
 *      verdict is APPENDED TO SEEN, so the next generation — of this source
 *      or any other — answers from step 2. A resolver THROW records the url
 *      in `deferred` and keeps going: transient archive trouble defers work
 *      to a later run, it never fabricates a verdict.
 *
 * `seen` is Manifest-shaped and READ-WRITE: pass the parsed union file
 * (bootstrap it with ledger.js#flatten), and write the RETURNED `seen` — a
 * normalized copy extended with this run's verdicts — back to disk after
 * the run. (A normalized copy, not in-place mutation: validation may have
 * rewritten sections, e.g. a v1-shaped seen's nulls into `exclude`.)
 *
 * @param {string} source - markdown text (the pristine, live-link form)
 * @param {{ rewrites: Record<string,string>, exclude: string[] } | null} universe
 * @param {object | null} seen - Manifest-shaped resolution union (mutated)
 * @param {Object} [options]
 * @param {string} [options.near] - preferred capture timestamp (YYYYMMDD[HHMMSS])
 * @param {Function} [options.resolve] - async (url, { near }) →
 *   { url: waybackUrl, timestamp } | null; injectable for offline use/tests
 * @param {WaybackMachine} [options.wayback] - client backing the default resolver
 * @returns {Promise<{ manifest: object, seen: object,
 *   deferred: Array<{ url: string, error: string }>,
 *   stats: { urls: number, fromUniverse: number, fromSeen: number, resolved: number } }>}
 */
export async function generate(source, universe, seen, options = {}) {
  const { near } = options;
  const resolve =
    options.resolve ??
    ((url, opts) => (options.wayback ?? (generate._wayback ??= new WaybackMachine())).getSnapshot(url, opts));

  const uni = universe ?? emptyUniverse();
  const manifest = emptyManifest();
  seen = seen ? validateManifest(seen, 'seen') : emptyManifest();
  const deferred = [];
  const stats = { urls: 0, fromUniverse: 0, fromSeen: 0, resolved: 0 };

  // Index the seen file by match key once per run.
  const seenExclude = new Set(seen.exclude.map(matchKey));
  const seenEntries = new Map(Object.entries(seen.entries).map(([u, e]) => [matchKey(u), e]));
  const seenRewrites = new Map(Object.entries(seen.rewrites).map(([u, t]) => [matchKey(u), t]));

  const urls = extractLinks(source);
  stats.urls = urls.length;

  // Step 1 — universe classification + subset baking (offline).
  const baked = subset(uni, urls);
  manifest.rewrites = { ...baked.rewrites };
  manifest.exclude.push(...baked.exclude);
  stats.fromUniverse = baked.exclude.length + Object.keys(baked.rewrites).length;

  for (const url of urls) {
    if (isExcluded(uni, url) || Object.hasOwn(baked.rewrites, url)) continue; // step 1 handled it

    // Step 2 — the seen union (offline). Precedence mirrors apply:
    // exclude → rewrites → entries.
    const key = matchKey(url);
    if (seenExclude.has(key)) {
      manifest.exclude.push(url);
      stats.fromSeen += 1;
      continue;
    }
    if (seenRewrites.has(key)) {
      manifest.rewrites[url] = seenRewrites.get(key);
      stats.fromSeen += 1;
      continue;
    }
    if (seenEntries.has(key)) {
      manifest.entries[url] = { ...seenEntries.get(key) };
      stats.fromSeen += 1;
      continue;
    }

    // Step 3 — the archive. Only never-seen urls cost a round-trip.
    let snapshot;
    try {
      snapshot = await resolve(url, { near });
    } catch (error) {
      deferred.push({ url, error: error?.message ?? String(error) });
      continue;
    }
    stats.resolved += 1;
    if (snapshot) {
      const entry = { wayback: snapshot.url, timestamp: snapshot.timestamp, checkedAt: new Date().toISOString() };
      manifest.entries[url] = entry;
      seen.entries[url] = entry;
      seenEntries.set(key, entry);
    } else {
      // Authoritatively not archived — v2 spells that `exclude`.
      manifest.exclude.push(url);
      seen.exclude.push(url);
      seenExclude.add(key);
    }
  }

  return { manifest, seen, deferred, stats };
}

/* ------------------------------------------------------------------------ *
 * apply — source + manifest → published form
 * ------------------------------------------------------------------------ */

/**
 * Apply a manifest to a markdown source: rewrite each live URL per the
 * manifest, precedence `exclude → rewrites → entries → untouched + warn`.
 *
 * The scan is the importer-proven one, generalized: one delimiter-bounded
 * pass over prose (fenced code blocks are never touched — a URL in a code
 * sample is literal text), every http(s) URL matched whole (greedy to the
 * next delimiter, so a prefix URL can't shadow a longer one; one level of
 * BALANCED parens is part of the URL — the msdn `…(VS.85).aspx` style —
 * matching extractLinks/extractArchiveUrls) and looked up by a
 * scheme/slash/port-insensitive key. Only link TARGETS rewrite — a URL
 * immediately followed by `]` is the visible text of `[http://x](…)` and
 * stays as-is. Already-archived URLs pass through untouched (and unwarned).
 *
 * @param {string} source - markdown text
 * @param {object} manifest - in-memory manifest (normalized on entry, so a
 *   freshly parsed v1 file works too)
 * @returns {{ content: string, warnings: string[] }} the rewritten source
 *   plus every distinct live URL the manifest had no verdict for
 */
export function apply(source, manifest) {
  const m = validateManifest(manifest, 'apply');
  const excludeKeys = new Set(m.exclude.map(matchKey));
  const rewriteByKey = new Map(Object.entries(m.rewrites).map(([u, t]) => [matchKey(u), t]));
  const entryByKey = new Map(Object.entries(m.entries).map(([u, e]) => [matchKey(u), e.wayback]));

  const warned = new Set();
  const content = mapOutsideFences(source, prose =>
    prose.replace(/https?:\/\/(?:\([^()\s"'<>\]]*\)|[^\s"'<>()\]])+/g, (url, offset, str) => {
      if (str[offset + url.length] === ']') return url; // link text, not a target
      if (url.includes('web.archive.org/web/')) return url; // already applied
      const key = matchKey(url);
      if (excludeKeys.has(key)) return url;
      if (rewriteByKey.has(key)) return rewriteByKey.get(key);
      if (entryByKey.has(key)) return entryByKey.get(key);
      warned.add(url); // no verdict anywhere — surface it, don't guess
      return url;
    })
  );

  return { content, warnings: [...warned] };
}

/* ------------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------------ */

/** Strip a default port (:80 on http, :443 on https) from a URL's host. */
function cleanOriginal(url) {
  return url
    .replace(/^(http:\/\/[^/:]+):80(?=\/|$)/, '$1')
    .replace(/^(https:\/\/[^/:]+):443(?=\/|$)/, '$1');
}

/**
 * A scheme/slash/port-insensitive comparison key for a URL. A manifest key
 * can be the archive's CANONICAL original (from the CDX `original` field),
 * which may differ from the AUTHORED link by protocol (a later capture
 * redirected http→https), a root trailing slash, a www↔apex redirect, or a
 * default port. Normalizing both sides lets the authored link still match
 * its verdict — the exact key the importer pipeline proved over the whole
 * corpus.
 */
function matchKey(url) {
  return cleanOriginal(url)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^([^/]+?)\.(?=\/|$)/, '$1') // FQDN root dot (host. → host)
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Apply `fn` to prose only, passing ``` fenced blocks through verbatim. */
function mapOutsideFences(content, fn) {
  return content
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 0 ? fn(part) : part))
    .join('');
}

/** Read a file as UTF-8, or null when it doesn't exist. */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}
