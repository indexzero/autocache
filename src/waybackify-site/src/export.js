// export — project a cache root onto a browsable path tree.
//
//   <out>/<host>/<timestamp>/<path…>   the stored body bytes, as-is
//   <out>/index.jsonl                  one row per exported capture
//   <out>/_unexported.jsonl            sidecars with no body (interstitial,
//                                      error, redirect, empty)
//   <out>/_collisions.jsonl            every path the export had to adjust
//
// A cache root is content-addressed (cap/<dd>/<digest> + meta/ sidecars), and
// `remaster` keeps that layout — it is built to be served, not read. This
// lays the same bodies out by URL, for a reader with a file browser and
// `grep`. The bytes are untouched: a page fetched through the normal replay
// still carries the archive's toolbar and `/web/<ts>/…` links; a page fetched
// raw is the captured bytes. index.jsonl's `wayback` says which.
//
// PATH RULES. <host> is the lowercased hostname without a leading "www."
// (the exact original URL is in index.jsonl); a non-default port becomes
// "<host>_<port>". A URL ending in "/" becomes ".../index.html". A query
// string is appended to the file name as "%3F<query>", path-hostile
// characters percent-encoded. A page's requisites share its timestamp, so a
// page and the images it embedded land in the same <timestamp>/ tree.
//
// COLLISIONS. The default macOS filesystem is case- and normalization-
// insensitive, and real sites hold both `E.gif` and `e.gif`. Paths are
// compared folded and a clash is resolved the same way on every filesystem:
// a file that is also a directory moves to <path>/index.html; a file clash
// gets a "~N" suffix; a directory spelled two ways reuses the first
// spelling. Every adjustment is a row in _collisions.jsonl — nothing is
// silently overwritten.
//
// IDEMPOTENT. A re-run rewrites only files whose bytes changed and removes
// files a previous export wrote that this one no longer plans.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SIDECAR_VERSION } from '@autocache/waybackify/cache.js';
import { bodyPath } from '@autocache/waybackify/key.js';
import { captures, discover } from '@autocache/waybackify/ledger.js';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order: locale-independent
const SAFE = /[A-Za-z0-9._~,=&@+!$'();%-]/;
const enc = s => [...s].map(ch => (SAFE.test(ch) || ch.codePointAt(0) > 0x7f
  ? ch
  : encodeURIComponent(ch).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))).join('');
const fold = s => s.toLowerCase().normalize('NFC');
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** Keep one path component under the 255-byte limit; a long one keeps a hash. */
function fitComponent(name) {
  if (Buffer.byteLength(name) <= 200) return name;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name.replace(/%3F.*$/, ''))?.[0] ?? '';
  let head = name;
  while (Buffer.byteLength(head) > 170) head = head.slice(0, -1);
  return `${head}~${crypto.createHash('sha1').update(name).digest('hex').slice(0, 10)}${ext}`;
}

function segment(raw) {
  if (raw === '') return '_';
  let s = raw;
  try {
    const d = decodeURIComponent(raw);
    if (!/[/\\\0]/.test(d)) s = d;
  } catch { /* keep raw */ }
  if (s === '.' || s === '..') s = s.replace(/\./g, '%2E');
  return enc(s);
}

/**
 * The planned relative path (`/`-joined) for one capture key, before any
 * collision handling. PURE.
 * @param {string} key - capture key `<timestamp>/<original>`
 * @returns {string}
 */
export function planPath(key) {
  const sep = key.indexOf('/');
  const ts = key.slice(0, sep);
  const original = key.slice(sep + 1);
  let u;
  try {
    u = new URL(original);
  } catch {
    u = null;
  }
  if (!u || !/^https?:$/.test(u.protocol)) return ['_unparsed', ts, fitComponent(enc(original))].join('/');
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.port) host += `_${u.port}`;
  const segs = u.pathname.split('/').slice(1);
  if (segs.length === 0 || segs[segs.length - 1] === '') segs[segs.length ? segs.length - 1 : 0] = 'index.html';
  const parts = segs.map((s, i) => (i === segs.length - 1 && s === 'index.html' ? s : segment(s)));
  if (u.search) parts[parts.length - 1] += `%3F${enc(u.search.slice(1))}`;
  return [enc(host), ts, ...parts.map(fitComponent)].join('/');
}

/** Every sidecar under a root, in shard order. */
function readSidecars(root) {
  const sidecars = [];
  const metaDir = path.join(root, 'meta');
  for (const aa of fs.readdirSync(metaDir).sort()) {
    const dir = path.join(metaDir, aa);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      const sc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (sc?.v !== SIDECAR_VERSION || typeof sc.key !== 'string') throw new Error(`export: unsupported sidecar ${path.join(dir, f)}`);
      sidecars.push(sc);
    }
  }
  return sidecars;
}

/**
 * Assign every bodied sidecar its final path, resolving collisions.
 * @returns {{ bodies: Array<{ sc: object, path: string }>, collisions: object[] }}
 */
function plan(sidecars) {
  const bodies = sidecars.filter(sc => sc.status === 'body').map(sc => ({ sc, raw: planPath(sc.key) }));
  bodies.sort((a, b) => cmp(a.raw, b.raw) || cmp(a.sc.key, b.sc.key));

  const dirsNeeded = new Set();
  for (const b of bodies) {
    const parts = b.raw.split('/');
    for (let i = 1; i < parts.length; i++) dirsNeeded.add(fold(parts.slice(0, i).join('/')));
  }

  const collisions = [];
  const takenFiles = new Map(); // folded file path → { key, path }
  const dirSpelling = new Map(); // folded dir path → first spelling
  for (const b of bodies) {
    let target = b.raw;
    if (dirsNeeded.has(fold(target))) {
      collisions.push({ kind: 'file-is-also-directory', key: b.sc.key, planned: target, path: `${target}/index.html` });
      target = `${target}/index.html`;
    }
    // Reuse the first spelling of every directory (a case-insensitive
    // filesystem would merge them anyway).
    const parts = target.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      const first = dirSpelling.get(fold(d));
      if (first === undefined) dirSpelling.set(fold(d), d);
      else if (first !== d) {
        collisions.push({ kind: 'directory-case-merged', key: b.sc.key, planned: d, path: first });
        parts.splice(0, i, ...first.split('/'));
      }
    }
    target = parts.join('/');
    const holder = takenFiles.get(fold(target));
    if (holder) {
      const ext = /(\.[A-Za-z0-9]{1,8})$/.exec(target.split('/').pop())?.[1] ?? '';
      const stem = ext ? target.slice(0, -ext.length) : target;
      let n = 2;
      while (takenFiles.has(fold(`${stem}~${n}${ext}`)) || dirsNeeded.has(fold(`${stem}~${n}${ext}`))) n++;
      const moved = `${stem}~${n}${ext}`;
      collisions.push({ kind: target === holder.path ? 'duplicate-path' : 'case-collision', key: b.sc.key, planned: target, path: moved, with: holder.key });
      target = moved;
    }
    takenFiles.set(fold(target), { key: b.sc.key, path: target });
    b.path = target;
  }
  return { bodies: bodies.sort((x, y) => cmp(x.path, y.path)), collisions };
}

function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const byCount = o => Object.fromEntries(Object.entries(o).sort(([a, x], [b, y]) => y - x || cmp(a, b)));

/**
 * Export a cache root as a path tree.
 *
 * @param {string} root - the cache root to read (never written)
 * @param {string} out - the directory to write the tree under
 * @param {Object} [options]
 * @param {string} [options.ledger] - a ledger directory: a capture it names
 *   is a `document` (with the file that names it and, for a capture list,
 *   its `rank`); every other body is a `requisite`
 * @param {boolean} [options.dryRun=false] - plan and count; write nothing
 * @returns {{ root: string, out: string, dryRun: boolean, sidecars: number,
 *   exported: number, written: number, unchanged: number, removed: number,
 *   bytes: number, documents: number, requisites: number,
 *   byContentType: Record<string, number>, byHost: Record<string, number>,
 *   unexported: number, collisions: number }}
 */
export function exportTree(root, out, options = {}) {
  const { ledger, dryRun = false } = options;
  const ROOT = path.resolve(root);
  const OUT = path.resolve(out);
  if (!fs.existsSync(path.join(ROOT, 'meta'))) throw new Error(`export: no meta/ under ${ROOT} — not a cache root`);
  const rel = path.relative(ROOT, OUT);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('export: the output directory must be outside the cache root (the root holds only its own store)');
  }

  // The ledger says which captures were asked for by name, and how.
  const docs = new Map();
  if (ledger) for (const item of captures(discover(ledger))) docs.set(item.key, item);

  const sidecars = readSidecars(ROOT);
  const { bodies, collisions } = plan(sidecars);
  const unexported = sidecars.filter(sc => sc.status !== 'body').map(sc => ({
    key: sc.key, status: sc.status, contentType: sc.contentType, flag: sc.flag,
    ...(sc.signature ? { signature: sc.signature } : {}), ...(sc.target ? { target: sc.target } : {})
  })).sort((a, b) => cmp(a.key, b.key));

  const index = [];
  const stats = { exported: 0, written: 0, unchanged: 0, removed: 0, bytes: 0, documents: 0, requisites: 0, byContentType: {}, byHost: {} };
  for (const { sc, path: relPath } of bodies) {
    const src = path.join(ROOT, bodyPath(sc.contentHash));
    const digestHex = path.basename(src);
    const sep = sc.key.indexOf('/');
    const timestamp = sc.key.slice(0, sep);
    const original = sc.key.slice(sep + 1);
    const doc = docs.get(sc.key);
    const dst = path.join(OUT, ...relPath.split('/'));
    if (!dryRun) {
      let same = false;
      try {
        same = fs.statSync(dst).size === sc.contentLength && sha256File(dst) === digestHex;
      } catch { /* absent */ }
      if (same) stats.unchanged++;
      else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.rmSync(dst, { force: true, recursive: true });
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE); // a clone where the filesystem has them
        stats.written++;
      }
    }
    const ct = (sc.contentType || '').split(';')[0].trim().toLowerCase() || '(none)';
    const host = relPath.split('/')[0];
    stats.exported++;
    stats.bytes += sc.contentLength;
    stats.byContentType[ct] = (stats.byContentType[ct] ?? 0) + 1;
    stats.byHost[host] = (stats.byHost[host] ?? 0) + 1;
    stats[doc ? 'documents' : 'requisites']++;
    index.push({
      path: relPath,
      original,
      timestamp,
      // The ledger's spelling says how a document was asked for; a root
      // written since sidecars record `id_` says so itself.
      wayback: doc?.waybackUrl ?? `https://web.archive.org/web/${timestamp}${sc.flag ?? ''}/${original}`,
      role: doc ? 'document' : 'requisite',
      ...(doc ? { files: doc.files, rank: doc.rank } : {}),
      flag: sc.flag,
      contentType: sc.contentType,
      digest: sc.contentHash,
      sha256: digestHex,
      bytes: sc.contentLength,
      fetchedAt: sc.fetchedAt
    });
  }

  if (!dryRun) {
    // Remove what a previous export wrote and this one no longer plans.
    const prevIndex = path.join(OUT, 'index.jsonl');
    if (fs.existsSync(prevIndex)) {
      const now = new Set(index.map(r => r.path));
      for (const line of fs.readFileSync(prevIndex, 'utf8').split('\n').filter(Boolean)) {
        const { path: p } = JSON.parse(line);
        if (typeof p !== 'string' || now.has(p) || p.split('/').includes('..') || path.isAbsolute(p)) continue;
        const stale = path.join(OUT, ...p.split('/'));
        // Only ever a file: a path that is now a directory holds this run's files.
        if (fs.statSync(stale, { throwIfNoEntry: false })?.isFile()) {
          fs.rmSync(stale, { force: true });
          stats.removed++;
        }
      }
    }
    writeIfChanged(path.join(OUT, 'index.jsonl'), jsonl(index));
    writeIfChanged(path.join(OUT, '_unexported.jsonl'), jsonl(unexported));
    writeIfChanged(path.join(OUT, '_collisions.jsonl'), jsonl(collisions));
  }

  return {
    root: ROOT, out: OUT, dryRun, sidecars: sidecars.length, ...stats,
    byContentType: byCount(stats.byContentType), byHost: byCount(stats.byHost),
    unexported: unexported.length, collisions: collisions.length
  };
}
