// Minimal corpus wayback-reference enumeration for the #248 audit runner.
//
// SCOPE NOTE / CONVERGENCE (#255): the canonical corpus enumerator lives in
// the unmerged PR #255 (render/wayback/src/enumerate.ts + bin/enumerate-corpus.js),
// whose identity contract is the mirror's capture-key parser. This module is
// deliberately the MINIMUM the audit needs — inline `web.archive.org/web/`
// links in words/**/index.md plus non-null wayback.json ledger entries — so
// #248 doesn't depend on an open PR. When #255 merges, the audit runner should
// swap this for `@charlie.dev/wayback/enumerate`; the numbers here are
// sanity-checked against #255's reported counts in the audit PR body.

import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from './audit.js';

// Characters that terminate a URL token in markdown prose.
const STOPPERS = new Set([' ', '\t', '\n', '\r', '<', '>', '"', "'", '`', ']', '\\']);
// Trailing punctuation that belongs to the prose, not the URL.
const TRAILING_PUNCT = /[.,;:!?]+$/;

/**
 * Extract every web.archive.org/web/ URL from markdown, in document order
 * (duplicates preserved — each occurrence is one ref). Handles the corpus's
 * real shapes: inline links `[t](url)` with CommonMark balanced parens (the
 * msdn `...(VS.85).aspx` URLs are real), reference definitions, HTML anchors,
 * and bare prose URLs.
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractInlineWaybackUrls(markdown) {
  const out = [];
  const needle = 'web.archive.org/web/';
  let from = 0;
  for (;;) {
    const hit = markdown.indexOf(needle, from);
    if (hit === -1) break;
    // Back up to the scheme. Corpus links are always schemed; if the scheme
    // isn't right there, treat the occurrence as prose and move on.
    let start = -1;
    for (const scheme of ['https://', 'http://']) {
      const s = hit - scheme.length;
      if (s >= 0 && markdown.startsWith(scheme, s)) start = s;
    }
    if (start === -1) {
      from = hit + needle.length;
      continue;
    }
    // Scan forward with paren-depth tracking: a ')' at depth 0 closes the
    // markdown link destination; nested '(' ... ')' pairs are part of the URL.
    let i = start;
    let depth = 0;
    while (i < markdown.length) {
      const ch = markdown[i];
      if (STOPPERS.has(ch)) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    const url = markdown.slice(start, i).replace(TRAILING_PUNCT, '');
    out.push(url);
    from = start + url.length;
  }
  return out;
}

/** All words/<...>/ post dirs (relative ids like "1/043") containing index.md or wayback.json. */
function* postDirs(wordsDir, rel = '') {
  const abs = path.join(wordsDir, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map(e => e.name));
  if (names.has('index.md') || names.has('wayback.json')) yield rel;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      yield* postDirs(wordsDir, rel ? `${rel}/${e.name}` : e.name);
    }
  }
}

/**
 * Enumerate every wayback reference the corpus makes.
 *
 * @param {string} rootDir - Repo root (contains words/)
 * @returns {{
 *   refs: Array<{ post: string, source: 'inline'|'ledger', waybackUrl: string,
 *                 timestamp: string, original: string }>,
 *   captures: Array<{ key: string, timestamp: string, original: string,
 *                     waybackUrl: string, posts: string[], refCount: number }>,
 *   posts: string[],
 *   skipped: Array<{ post: string, source: string, url: string }>
 * }}
 *   `refs` is every occurrence; `captures` is deduped by `<timestamp>/<original>`
 *   (flagless — the identity #255's capture key uses), each with the posts that
 *   reference it. `skipped` lists web.archive.org URLs that didn't parse as
 *   replay URLs (audit those by hand).
 */
export function enumerateCorpus(rootDir) {
  const wordsDir = path.join(rootDir, 'words');
  const refs = [];
  const skipped = [];
  const captures = new Map();
  const postsWithRefs = new Set();

  const addRef = (post, source, waybackUrl) => {
    const parsed = parseWaybackUrl(waybackUrl);
    if (!parsed) {
      skipped.push({ post, source, url: waybackUrl });
      return;
    }
    const { timestamp, original } = parsed;
    refs.push({ post, source, waybackUrl, timestamp, original });
    postsWithRefs.add(post);
    const key = `${timestamp}/${original}`;
    let cap = captures.get(key);
    if (!cap) {
      cap = { key, timestamp, original, waybackUrl, posts: new Set(), refCount: 0 };
      captures.set(key, cap);
    }
    cap.posts.add(post);
    cap.refCount++;
  };

  for (const post of [...postDirs(wordsDir)].sort()) {
    const dir = path.join(wordsDir, post);

    const mdPath = path.join(dir, 'index.md');
    if (fs.existsSync(mdPath)) {
      for (const url of extractInlineWaybackUrls(fs.readFileSync(mdPath, 'utf8'))) {
        addRef(post, 'inline', url);
      }
    }

    const ledgerPath = path.join(dir, 'wayback.json');
    if (fs.existsSync(ledgerPath)) {
      let ledger;
      try {
        ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      } catch {
        skipped.push({ post, source: 'ledger', url: '(unparseable wayback.json)' });
        continue;
      }
      for (const entry of Object.values(ledger.entries ?? {})) {
        // entry.wayback is authoritative for the embedded original (it can
        // differ from the ledger's live-URL key by :80 spellings, per #255);
        // wayback: null means "never captured" and is rightly not a ref.
        if (entry?.wayback) addRef(post, 'ledger', entry.wayback);
      }
    }
  }

  return {
    refs,
    captures: [...captures.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(c => ({ ...c, posts: [...c.posts].sort() })),
    posts: [...postsWithRefs].sort(),
    skipped
  };
}
