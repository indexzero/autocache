// Remaster a hermetic cache root into a standalone remastered root.
//
//   remaster <hermetic-root> <remastered-root>
//
// The hermetic root is the sealed truth — captures exactly as archive.org's
// replay returned them (cache.js's write protocol; layout in
// spv/waybackify-cli/docs/CACHE.md). The remastered root is the same layout
// with text-bearing bodies rewritten for standalone serving (rewrite.js):
// chrome stripped, wayback references localized to the root-relative
// `/web/<ts><flag>/<orig>` form. Everything an FsStore needs to serve —
// `cap/<aa>/<hash>` + `meta/<aa>/<hash>.json` — comes out the far side, so a
// remastered root drops straight under `serve.js --root`.
//
// WHY A BUILD, NOT SERVE-TIME (issue #362): storage is cheap; serve-time
// compute is the expensive, latency-adding, forever-verified path. The
// rewrite rules stay pure functions so the SAME rules can also run per-request
// in a `--root` dev mode — iterating on a rule never requires a rebuild — but
// production serves pre-rewritten bytes.
//
// DETERMINISM is a hard requirement: the same hermetic tree yields a
// byte-identical remastered tree AND a byte-identical build record. Every
// step is a pure function of the input bytes + the corpus: sidecars re-emit
// through canonicalJSON, bodies through the deterministic rewrite engine, the
// build record sorts its entries by key. remaster.test.js proves it by running
// twice and hashing both trees.
//
// THE AUTHORITY IS meta/. We walk sidecars, never cap/: a sidecar's presence
// is the writer's sole completion token (CACHE.md), so an orphan cap/ body
// with no sidecar is ingest garbage — never served, and therefore never
// carried into the remastered tree.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RULE_VERSION, classifyContentType, rewrite } from './rewrite.js';
import { SUPPORTED_SIDECAR_VERSIONS } from './cache.js';

/** Remaster tool version. Bump on a change to the build's OUTPUT contract
 *  (build-record shape, sidecar carry-over rules, tree layout) — distinct from
 *  rewrite.js's RULE_VERSION (the reference-rewriting behavior). */
export const ENGINE_VERSION = 1;

/** Build-record schema version + filename. NOT a "manifest": in waybackify a
 *  Manifest is a wayback.json rewrite program (manifest.js) — this file is
 *  the remaster build's content-addressed output record. */
export const BUILD_VERSION = 1;
export const BUILD_NAME = 'remaster.build.json';

/* ------------------------------------------------------------------------ *
 * Small local copies (kept out of cache.js's dependency graph on purpose:
 * cache.js pulls in the live WaybackMachine/impit stack, and remaster is a
 * pure offline transform. The same LOCAL-COPY stance fsck.js takes.)
 * ------------------------------------------------------------------------ */

/** Canonical JSON — recursively sorted keys, single line, no insignificant
 *  whitespace. Byte-identical to what cache.js writes, so an unchanged sidecar
 *  re-emits to the exact same bytes. */
function canonicalJSON(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** SRI `sha256-<base64>` over bytes — the form cache.js records in contentHash. */
function sri(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

/** readdir that treats a missing directory as empty. */
async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Walk `meta/<aa>/<hash>.json` in a stable order (aa then filename, both
 * sorted) — deterministic iteration, though final tree bytes don't depend on
 * order.
 * @param {string} root
 * @returns {Promise<Array<{ aa: string, hash: string, metaPath: string }>>}
 */
async function walkMeta(root) {
  const base = path.join(root, 'meta');
  const out = [];
  const aaDirs = (await readdirSafe(base))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  for (const aa of aaDirs) {
    const names = (await readdirSafe(path.join(base, aa)))
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => e.name)
      .sort();
    for (const name of names) {
      out.push({ aa, hash: name.slice(0, -'.json'.length), metaPath: path.join(base, aa, name) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------------ */

/**
 * Remaster `hermeticRoot` into `remasteredRoot`.
 *
 * @param {string} hermeticRoot - sealed cache root (contains cap/ + meta/)
 * @param {string} remasteredRoot - output root (created; caller supplies a
 *   fresh dir — remaster writes cap/, meta/, and the build record into it)
 * @param {Object} [options]
 * @param {number} [options.engineVersion=ENGINE_VERSION]
 * @returns {Promise<{ hermeticRoot: string, remasteredRoot: string,
 *   sidecars: number, bodies: number, rewritten: number,
 *   buildPath: string, build: object }>}
 */
export async function remaster(hermeticRoot, remasteredRoot, options = {}) {
  const engineVersion = options.engineVersion ?? ENGINE_VERSION;
  const found = await walkMeta(hermeticRoot);

  // ---- pass 1: read every sidecar, build the corpus map --------------------
  // The corpus map is captureKey → true, keyed EXACTLY as the sidecar stores
  // it (sidecar.key = `${timestamp}/${originalUrl}`). That is the identity the
  // FsStore resolves a request by, so "in the corpus" means "the server can
  // serve it" — the tightest possible coupling between what we rewrite to and
  // what actually resolves. Built fully before any rewrite so a document can
  // reference a requisite regardless of walk order.
  const corpus = new Map();
  const sidecars = [];
  for (const entry of found) {
    const sidecar = JSON.parse(await fsp.readFile(entry.metaPath, 'utf8'));
    // Accept every sidecar version cache.js currently writes (v1 + v2 + v3
    // today) — not a hard-pinned 1, which silently rejected the v2 sidecars
    // cacheCapture has written since the schema bump.
    if (!SUPPORTED_SIDECAR_VERSIONS.has(sidecar.v)) {
      throw new Error(`remaster: unsupported sidecar version ${sidecar.v} at ${entry.metaPath}`);
    }
    if (typeof sidecar.key !== 'string') {
      throw new Error(`remaster: sidecar missing a string key at ${entry.metaPath}`);
    }
    corpus.set(sidecar.key, true);
    sidecars.push({ ...entry, sidecar });
  }

  // ---- pass 2: rewrite bodies, carry sidecars, record the build ------------
  const buildEntries = [];
  let bodies = 0;
  let rewritten = 0;

  for (const { aa, hash, sidecar } of sidecars) {
    let outSidecar = sidecar;
    let inputHash = null;
    let outputHash = null;
    let didRewrite = false;

    if (sidecar.status === 'body') {
      bodies++;
      const inBody = path.join(hermeticRoot, 'cap', aa, hash);
      const inBytes = await fsp.readFile(inBody);
      inputHash = sri(inBytes);

      let outBytes = inBytes;
      if (classifyContentType(sidecar.contentType)) {
        // latin1 is a LOSSLESS byte↔char mapping (every byte 0x00–0xFF ↔ one
        // code point), so a capture's non-UTF-8 bytes round-trip untouched
        // while the ASCII-only wayback references get rewritten. Decoding as
        // UTF-8 and re-encoding would corrupt latin1/binary captures.
        const result = rewrite(sidecar.contentType, inBytes.toString('latin1'), corpus);
        if (result.changed) {
          outBytes = Buffer.from(result.text, 'latin1');
          didRewrite = true;
          rewritten++;
        }
      }

      outputHash = sri(outBytes);
      await writeFileMkdir(path.join(remasteredRoot, 'cap', aa, hash), outBytes);

      // A rewritten body changes its own hash + length; the carried sidecar
      // must tell the truth about the bytes it now sits beside (FsStore serves
      // contentLength as the Content-Length header, and rmfsck re-verifies
      // contentHash against the body). Unchanged bodies keep the sidecar
      // byte-identical. Every other field — including the v3 `dynamic[]` array
      // — carries through verbatim via the spread: it is a doc-level fact,
      // never rewritten, so the remastered sidecar preserves it untouched.
      if (outputHash !== inputHash) {
        outSidecar = { ...sidecar, contentHash: outputHash, contentLength: outBytes.length };
      }
    }
    // Bodiless entries (empty / redirect / error — and any future status such
    // as an interstitial) carry through unchanged: no cap/ body exists, and
    // there is nothing to rewrite.

    await writeFileMkdir(path.join(remasteredRoot, 'meta', aa, `${hash}.json`), canonicalJSON(outSidecar));

    buildEntries.push({
      contentType: sidecar.contentType,
      inputHash,
      key: sidecar.key,
      outputHash,
      rewritten: didRewrite,
      status: sidecar.status
    });
  }

  // ---- the content-addressed build record ----------------------------------
  // Placed at the remastered root, OUTSIDE cap/ and meta/: FsStore only ever
  // reads cap/<aa>/<hash> and meta/<aa>/<hash>.json, so a root-level file is
  // invisible to serving — it never collides with the capture namespace. It
  // is a build artifact (rule + engine version, per-entry input/output body
  // hashes) that rmfsck reads to prove a remastered tree is a current,
  // faithful derivation of its hermetic source.
  // No absolute paths ever enter the build record — the remastered tree is
  // portable, and a machine-specific root would break the determinism check.
  buildEntries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const build = {
    engineVersion,
    entries: buildEntries,
    ruleVersion: RULE_VERSION,
    v: BUILD_VERSION
  };
  const buildPath = path.join(remasteredRoot, BUILD_NAME);
  await writeFileMkdir(buildPath, canonicalJSON(build));

  return {
    hermeticRoot,
    remasteredRoot,
    sidecars: sidecars.length,
    bodies,
    rewritten,
    buildPath,
    build
  };
}

/** Write a file, creating parent directories as needed. */
async function writeFileMkdir(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
}
