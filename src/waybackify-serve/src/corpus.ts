/**
 * Corpus key-set walker (#249, design §D3).
 *
 * Walk a cache-root's `meta/` sidecars once → a Set of the capture keys the
 * server holds. This is the floor the serve-time `localize` option stands on:
 * `rewrite()` (waybackify/rewrite.js) localizes a wayback reference only when
 * its key is in this set, so a reference the mirror cannot actually satisfy is
 * left byte-for-byte foreign. One meta-walk per run — the set is built at boot
 * and handed to createApp, never re-read per request.
 */

import fsp from 'node:fs/promises';

/**
 * The sidecar `flag` values that mark a capture as a page REQUISITE — an
 * image (`im_`), stylesheet (`cs_`), script (`js_`), or embedded media
 * (`oe_`) fetched to complete a page, as opposed to a top-level document
 * (whose sidecar carries an empty/absent flag). Established from the corpus;
 * inlined here on purpose so this module stays dependency-free.
 */
const REQUISITE_FLAGS = new Set(['im_', 'cs_', 'js_', 'oe_']);

/**
 * The one sidecar version every reader accepts (FsStore's rule, inlined so
 * this module stays dependency-free). A sidecar of another version is a
 * shape problem, not rot: the walk fails loud on it instead of skipping it,
 * because the server that boots on such a root must not serve it.
 */
const SIDECAR_VERSION = 3;

/** Throw on a parsed sidecar of another version. */
function assertSidecarVersion(sidecar: { v?: unknown }, meta: string): void {
  if (sidecar.v !== SIDECAR_VERSION) {
    throw new Error(`corpus: unsupported sidecar version ${String(sidecar.v)} at ${meta}`);
  }
}

/**
 * Build the set of capture keys a cache-root holds by reading every
 * `<root>/meta/<aa>/<hash>.json` sidecar and collecting its `.key`.
 *
 * DEFENSIVE-BY-DESIGN, unlike FsStore. FsStore treats a sidecar that fails to
 * parse as loud disk rot (it is the authority for a single lookup). This
 * whole-root pre-walk is the OPPOSITE stance on purpose: it builds an
 * OPTIMIZATION set, not an authority, so one unreadable/unparseable/keyless
 * sidecar must not abort the server's boot. Such a file is skipped and the walk
 * continues — a reference whose key is thereby missing from the set simply
 * stays foreign (the safe direction), exactly as an absent capture would.
 */
export async function loadCorpusKeySet(root: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const metaDir = `${root}/meta`;

  let shards: string[];
  try {
    shards = await fsp.readdir(metaDir);
  } catch {
    // No meta/ dir at all (empty or not-yet-populated root): an empty set,
    // which localizes nothing — every reference stays foreign.
    return keys;
  }

  for (const aa of shards) {
    let files: string[];
    try {
      files = await fsp.readdir(`${metaDir}/${aa}`);
    } catch {
      continue; // a stray non-directory entry under meta/ — skip it
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const meta = `${metaDir}/${aa}/${file}`;
      let sidecar: { v?: unknown; key?: unknown };
      try {
        sidecar = JSON.parse(await fsp.readFile(meta, 'utf8')) as { v?: unknown; key?: unknown };
      } catch {
        // Unreadable or unparseable sidecar: skip it. This set is an
        // optimization, not an authority (see the header) — one bad file must
        // not sink the boot walk.
        continue;
      }
      assertSidecarVersion(sidecar, meta);
      if (typeof sidecar.key === 'string') keys.add(sidecar.key);
    }
  }
  return keys;
}

/**
 * Walk a cache-root's `meta/` sidecars once → the full capture-key CATALOG:
 * every key the root holds (`keys`, exactly loadCorpusKeySet's set) plus the
 * subset whose sidecar `flag` marks it a page requisite (`requisites` ⊆
 * `keys`, per {@link REQUISITE_FLAGS}). The /_index search page stands on
 * this to filter top-level documents from their requisites server-side.
 *
 * DEFENSIVE-BY-DESIGN for the same reason as loadCorpusKeySet (see its
 * header): this is an optimization catalog, not an authority, so an
 * unreadable/unparseable/keyless sidecar is skipped, never a boot abort. A
 * sidecar of another version is the one exception: it is refused.
 */
export async function loadCorpusCatalog(root: string): Promise<{ keys: Set<string>; requisites: Set<string> }> {
  const keys = new Set<string>();
  const requisites = new Set<string>();
  const metaDir = `${root}/meta`;

  let shards: string[];
  try {
    shards = await fsp.readdir(metaDir);
  } catch {
    // No meta/ dir at all (empty or not-yet-populated root): empty catalog.
    return { keys, requisites };
  }

  for (const aa of shards) {
    let files: string[];
    try {
      files = await fsp.readdir(`${metaDir}/${aa}`);
    } catch {
      continue; // a stray non-directory entry under meta/ — skip it
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const meta = `${metaDir}/${aa}/${file}`;
      let sidecar: { v?: unknown; key?: unknown; flag?: unknown };
      try {
        sidecar = JSON.parse(await fsp.readFile(meta, 'utf8')) as { v?: unknown; key?: unknown; flag?: unknown };
      } catch {
        // Unreadable or unparseable sidecar: skip it (see loadCorpusKeySet).
        continue;
      }
      assertSidecarVersion(sidecar, meta);
      const { key, flag } = sidecar;
      if (typeof key !== 'string') continue;
      keys.add(key);
      if (typeof flag === 'string' && REQUISITE_FLAGS.has(flag)) requisites.add(key);
    }
  }
  return { keys, requisites };
}
