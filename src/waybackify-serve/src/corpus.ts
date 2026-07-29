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
      try {
        const raw = await fsp.readFile(`${metaDir}/${aa}/${file}`, 'utf8');
        const key = (JSON.parse(raw) as { key?: unknown }).key;
        if (typeof key === 'string') keys.add(key);
      } catch {
        // Unreadable or unparseable sidecar: skip it. This set is an
        // optimization, not an authority (see the header) — one bad file must
        // not sink the boot walk.
      }
    }
  }
  return keys;
}
