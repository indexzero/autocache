/**
 * allowed-escapes policy (design §F / Q-004).
 *
 * The dynamic probe's `non-local-request` findings are of two kinds: refs to a
 * `web.archive.org` capture we simply do not hold yet (a FETCH gap — those are
 * mapped to the worklist by src/mapkeys.js, never here), and deliberate
 * third-party requests (analytics/trackers/CDNs) that the deployed strict CSP
 * is SUPPOSED to block. This module answers the second question only: is a
 * genuinely third-party non-local request one the policy sanctions as an
 * expected, non-failing escape?
 *
 * A matched escape is reported as `allowed-escape` (visible, non-failing); an
 * UNMATCHED non-local request still fails the document. The policy is committed
 * source (`policy/allowed-escapes.json`), overridable per-run with
 * `--allow-escapes <file>`. Every entry carries a `reason` string so the report
 * explains, in the operator's words, why a blocked request is not a defect.
 */

import fsp from 'node:fs/promises';

/**
 * @typedef {{ host: string, reason: string }} EscapeEntry
 * @typedef {{ version: number, entries: EscapeEntry[],
 *   match(url: string): EscapeEntry | null }} CompiledPolicy
 */

/**
 * Compile a parsed policy document into a matcher. Host matching is
 * suffix-aware: an entry `host: "google-analytics.com"` matches both
 * `google-analytics.com` and any subdomain (`www.google-analytics.com`), but
 * never a look-alike (`evilgoogle-analytics.com`) — the boundary is a literal
 * `.` label separator. Matching is case-insensitive (hostnames are).
 *
 * @param {{ version?: number, escapes?: Array<{host?: string, reason?: string}> }} doc
 * @returns {CompiledPolicy}
 */
export function compilePolicy(doc) {
  const raw = Array.isArray(doc?.escapes) ? doc.escapes : [];
  const entries = raw
    .map(e => ({ host: String(e?.host ?? '').trim().toLowerCase(), reason: String(e?.reason ?? '') }))
    .filter(e => e.host.length > 0);
  return {
    version: typeof doc?.version === 'number' ? doc.version : 1,
    entries,
    match(url) {
      let host;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (host === entry.host || host.endsWith('.' + entry.host)) return entry;
      }
      return null;
    }
  };
}

/**
 * Load and compile the committed policy (or a `--allow-escapes` override).
 * @param {string} file
 * @returns {Promise<CompiledPolicy>}
 */
export async function loadPolicy(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return compilePolicy(JSON.parse(raw));
}

/** The default policy path, resolved relative to this package. */
export const DEFAULT_POLICY_URL = new URL('../policy/allowed-escapes.json', import.meta.url);
