// Corpus wayback-URL enumerator — the canonical implementation.
//
// Enumerates EVERY wayback capture the corpus references, from both places
// references live:
//
//   - inline:  markdown link/image URLs in words/**​/index.md that point at
//              web.archive.org/web/... (inline `](...)` destinations,
//              reference definitions `[label]: url`, and autolinks `<url>` —
//              all three occur in the corpus);
//   - ledger:  the per-post wayback.json files written by waybackify-words
//              ({ version, entries: { [liveUrl]: { wayback, timestamp } } }).
//
// LIBRARY-FIRST / CONVERGENCE: this module is the single enumeration
// implementation shared across the two packages. It absorbed the canonical
// logic that previously lived in render/wayback/src/enumerate.ts (balanced-
// paren inline links, reference definitions, autolinks, the ledger schema
// incl. `wayback: null` skips); that TypeScript module is now a re-export
// shim over this file (with a hand-authored enumerate.d.ts alongside), exactly
// like key.ts → key.js. The waybackify-cli `manifest` command consumes the
// per-file entry point (enumerateFile); render/wayback's edge + audit consume
// the same primitives through the shim.
//
// Parser note: references round-trip through parseWaybackUrl (audit.js) — the
// library's one wayback-URL parser. It is equivalent to render/wayback's
// serving parser (src/path.ts parseArchiveUrl) on every reference the corpus
// actually makes: an offline diff over all 1900+ corpus references shows zero
// divergence in (timestamp, originalUrl), so render/wayback's "every reference
// round-trips to the same capture key" smoke stays green through the shim.

import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from './audit.js';

/**
 * @typedef {Object} WaybackRef
 * @property {string} post - Post id relative to the words root, e.g. `1/043`.
 * @property {'inline'|'ledger'} source - Where the reference lives.
 * @property {string} timestamp - Capture timestamp, parsed from the URL itself.
 * @property {string} originalUrl - The archived original URL embedded in the URL.
 * @property {string} waybackUrl - The wayback URL exactly as the corpus spells it.
 */

/**
 * @typedef {Object} WaybackRefSummary
 * @property {number} total
 * @property {number} inline
 * @property {number} ledger
 * @property {number} uniqueCaptures - Distinct (timestamp, originalUrl) pairs.
 * @property {number} posts - Distinct posts referencing at least one capture.
 */

/**
 * Extract every web.archive.org/web/ URL from markdown text.
 *
 * Deliberately NOT a markdown parse — a scanner that starts at each
 * `http(s)://web.archive.org/web/` occurrence and consumes forward until a
 * character that ends a URL in every markdown context the corpus uses:
 * whitespace/newline ends reference definitions, `>` ends autolinks, `"`/`'`
 * end titled links, `]` ends a bare-bracket label, and `)` ends an inline
 * destination — but only at paren depth 0, because CommonMark allows BALANCED
 * parens inside destinations and the corpus exercises that (the
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
 * Enumerate every wayback reference for a single post, deduped per
 * (source, capture) and deterministically ordered. The shared core of both
 * the tree walk (enumerateCorpus) and the per-file CLI (enumerateFile).
 *
 * @param {string} post - Post id, e.g. `1/043` (or a bare path for stray files).
 * @param {Object} sources
 * @param {string|null} [sources.markdown] - index.md text, or null when absent.
 * @param {Object|null} [sources.ledger] - parsed wayback.json, or null.
 * @returns {WaybackRef[]}
 */
function collectPostRefs(post, { markdown = null, ledger = null } = {}) {
  const refs = new Map();

  if (markdown !== null) {
    for (const url of extractArchiveUrls(markdown)) add(refs, post, 'inline', url);
  }

  if (ledger !== null) {
    for (const entry of Object.values(ledger.entries ?? {})) {
      // The entry's `wayback` URL is authoritative: its embedded original can
      // differ from the ledger's live-URL key (waybackify records e.g.
      // `:80`-suffixed originals as the CDX index spells them). `wayback: null`
      // is a real ledger state — waybackify recording "no capture exists" —
      // i.e. NOT a reference; skip, don't throw.
      if (entry?.wayback != null) add(refs, post, 'ledger', entry.wayback);
    }
  }

  return [...refs.values()].sort(compareRefs);
}

/**
 * Enumerate every wayback reference under a words root. Deduped (a post
 * linking the same capture twice from the same source counts once) and
 * deterministically ordered (post, then source, then timestamp, then
 * originalUrl) so diffs of the output are meaningful.
 *
 * Throws — loudly, with post + URL context — if a reference does not parse
 * with the wayback-URL parser. That is a corpus contract, not a convenience:
 * an unparseable wayback URL is a URL the mirror could never serve, and the
 * fix belongs in the corpus, not in silent skipping here.
 *
 * @param {string} wordsDir - the words/ tree to walk.
 * @returns {WaybackRef[]}
 */
export function enumerateCorpus(wordsDir) {
  const all = [];

  for (const postDir of findPostDirs(wordsDir)) {
    // Posts are words/<series>/<number>/ — identify them the way the repo
    // talks about them ("1/043"), normalized to forward slashes.
    const post = path.relative(wordsDir, postDir).split(path.sep).join('/');
    all.push(
      ...collectPostRefs(post, {
        markdown: readText(path.join(postDir, 'index.md')),
        ledger: readLedger(path.join(postDir, 'wayback.json'))
      })
    );
  }

  return all.sort(compareRefs);
}

/**
 * Enumerate the wayback references of a single markdown file — the composable
 * unit behind `waybackify manifest`. `post` is derived from the file path
 * (`words/<series>/<mono>` when applicable, else the path itself). Inline
 * links only by default; pass `{ ledger: true }` to fold in the sibling
 * wayback.json entries. Deduped and deterministically ordered within the file.
 *
 * @param {string} filePath - path to a markdown file (typically an index.md).
 * @param {Object} [options]
 * @param {boolean} [options.ledger=false] - also fold in the sibling wayback.json.
 * @returns {WaybackRef[]}
 */
export function enumerateFile(filePath, { ledger = false } = {}) {
  const post = postIdForPath(filePath);
  const markdown = readText(filePath);
  const ledgerObj = ledger ? readLedger(path.join(path.dirname(filePath), 'wayback.json')) : null;
  return collectPostRefs(post, { markdown, ledger: ledgerObj });
}

/**
 * Derive a post id from a markdown file path: the two path segments under a
 * `words/` ancestor (`words/1/043/index.md` → `1/043`), or the path itself
 * when the file isn't under a recognizable words tree.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function postIdForPath(filePath) {
  const parts = filePath.split(/[\\/]+/);
  const fileIdx = parts.length - 1;
  // Last `words` segment that still leaves at least one directory before the
  // filename — that's the post directory chain.
  for (let i = fileIdx - 1; i >= 0; i -= 1) {
    if (parts[i] === 'words' && i + 1 < fileIdx) {
      return parts.slice(i + 1, fileIdx).join('/');
    }
  }
  return filePath;
}

/**
 * Roll a ref list up into the counts reporting wants (audit scope numbers).
 *
 * @param {WaybackRef[]} refs
 * @returns {WaybackRefSummary}
 */
export function summarize(refs) {
  const captures = new Set();
  const posts = new Set();
  let inline = 0;
  for (const ref of refs) {
    captures.add(`${ref.timestamp} ${ref.originalUrl}`);
    posts.add(ref.post);
    if (ref.source === 'inline') inline += 1;
  }
  return {
    total: refs.length,
    inline,
    ledger: refs.length - inline,
    uniqueCaptures: captures.size,
    posts: posts.size
  };
}

/* ------------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------------ */

/** Deterministic order: post, then source, then timestamp, then originalUrl. */
function compareRefs(a, b) {
  return (
    a.post.localeCompare(b.post) ||
    a.source.localeCompare(b.source) ||
    a.timestamp.localeCompare(b.timestamp) ||
    a.originalUrl.localeCompare(b.originalUrl)
  );
}

/** Parse + record one reference, enforcing the parser contract. */
function add(refs, post, source, url) {
  const parsed = parseWaybackUrl(url);
  if (parsed === null) {
    throw new Error(`words/${post} (${source}): unparseable wayback URL: ${url}`);
  }
  const key = [post, source, parsed.timestamp, parsed.original].join(' ');
  if (!refs.has(key)) {
    refs.set(key, {
      post,
      source,
      timestamp: parsed.timestamp,
      originalUrl: parsed.original,
      waybackUrl: url
    });
  }
}

/** Every directory under the words root that holds an index.md — a post. */
function findPostDirs(dir) {
  const dirs = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return dirs;
    throw err;
  }
  if (entries.some(e => e.isFile() && e.name === 'index.md')) dirs.push(dir);
  for (const entry of entries) {
    // node_modules never appears under words/, but stay cheap to re-point at a
    // fixture tree; hidden dirs (.git in tests' tmp trees) are skipped.
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      dirs.push(...findPostDirs(path.join(dir, entry.name)));
    }
  }
  return dirs;
}

/** Read + parse a wayback.json ledger, or null when it doesn't exist. */
function readLedger(ledgerPath) {
  const text = readText(ledgerPath);
  return text === null ? null : JSON.parse(text);
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
