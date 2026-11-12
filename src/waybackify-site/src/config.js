// The site config — which sites, which window, which replay mode.
//
//   {
//     "window": { "from": "20020101000000", "to": "20071231235959" },
//     "cdx":    { "pageLimit": 100000, "pauseMs": 5000,
//                 "maxAttempts": 10, "backoffMs": 30000 },     // optional
//     "sites": [
//       { "name": "example.org",
//         "queries": [ { "url": "example.org", "matchType": "domain" } ] }
//     ],
//     "rules": [ { "host": "wiki.example.org", "html": "raw", "why": "…" } ]
//   }
//
//   - `window`: the capture window, 1–14 digit timestamps. `from` pads with
//     0s and `to` with 9s, so `"2002"`–`"2007"` spans both whole years.
//   - `sites[].name`: the directory the site's capture list is written under,
//     so it is one path segment.
//   - `sites[].queries`: CDX queries; `matchType` is exact | prefix | host |
//     domain (default exact).
//   - `rules`: per-host replay mode for HTML. `"replay"` (the default)
//     fetches a page through the normal replay, so `cache fill` records and
//     fetches its requisites. `"raw"` fetches it with `id_`: the captured
//     bytes, no requisite fan-out. A rule matches its host and every
//     subdomain; the first match wins. Non-HTML is always fetched raw.
//
// This file is the driver's whole stake in a mirror: everything else is
// derived from it and from the index.

import fs from 'node:fs';
import { CDX_MATCH_TYPES } from '@autocache/waybackify/cdx.js';

const CDX_DEFAULTS = Object.freeze({ pageLimit: 100000, pauseMs: 5000, maxAttempts: 10, backoffMs: 30000, maxBackoffMs: 600000 });
const HTML_MODES = ['raw', 'replay'];

/** Pad a 1–14 digit timestamp to 14 digits. */
const pad14 = (ts, fill) => String(ts).padEnd(14, fill).slice(0, 14);

/**
 * Validate a parsed site config and return its normalized shape: the window
 * padded to 14 digits, `cdx` filled with defaults, `rules` present.
 *
 * @param {unknown} raw
 * @param {string} [context] - label for error messages (usually a file path)
 * @returns {{ window: { from: string, to: string }, cdx: typeof CDX_DEFAULTS,
 *   sites: Array<{ name: string, queries: Array<{ url: string, matchType: string }> }>,
 *   rules: Array<{ host: string, html: 'raw'|'replay', why?: string }> }}
 */
export function validateSiteConfig(raw, context = 'site config') {
  const bad = detail => new Error(`${context}: invalid site config — ${detail}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');

  const { window = {}, cdx = {}, sites, rules = [] } = raw;
  const stamp = (v, name) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !/^\d{1,14}$/.test(v)) throw bad(`window.${name} must be a 1–14 digit timestamp string`);
    return v;
  };
  const from = pad14(stamp(window.from, 'from') ?? '', '0');
  const to = pad14(stamp(window.to, 'to') ?? '', '9');
  if (from > to) throw bad('window.from is after window.to');

  if (cdx === null || typeof cdx !== 'object' || Array.isArray(cdx)) throw bad('`cdx` must be an object');
  for (const [k, v] of Object.entries(cdx)) {
    if (!Object.hasOwn(CDX_DEFAULTS, k)) throw bad(`unknown cdx option ${JSON.stringify(k)}`);
    if (!(Number.isSafeInteger(v) && v >= 0)) throw bad(`cdx.${k} must be a non-negative integer`);
  }

  if (!Array.isArray(sites) || sites.length === 0) throw bad('`sites` must be a non-empty array');
  const names = new Set();
  const outSites = sites.map((site, i) => {
    if (site === null || typeof site !== 'object') throw bad(`sites[${i}] must be an object`);
    const { name, queries } = site;
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw bad(`sites[${i}].name must be one path segment of letters, digits, ".", "_" and "-"`);
    }
    if (names.has(name)) throw bad(`duplicate site name ${JSON.stringify(name)}`);
    names.add(name);
    if (!Array.isArray(queries) || queries.length === 0) throw bad(`site ${name}: \`queries\` must be a non-empty array`);
    return {
      name,
      queries: queries.map((q, j) => {
        if (q === null || typeof q !== 'object' || typeof q.url !== 'string' || q.url.length === 0) {
          throw bad(`site ${name}: queries[${j}].url must be a non-empty string`);
        }
        const matchType = q.matchType ?? 'exact';
        if (!CDX_MATCH_TYPES.includes(matchType)) {
          throw bad(`site ${name}: queries[${j}].matchType must be one of ${CDX_MATCH_TYPES.join(' | ')}`);
        }
        return { url: q.url, matchType };
      })
    };
  });

  if (!Array.isArray(rules)) throw bad('`rules` must be an array');
  const outRules = rules.map((rule, i) => {
    if (rule === null || typeof rule !== 'object' || typeof rule.host !== 'string' || rule.host.length === 0) {
      throw bad(`rules[${i}].host must be a non-empty string`);
    }
    if (!HTML_MODES.includes(rule.html)) throw bad(`rules[${i}].html must be "raw" or "replay"`);
    return { host: rule.host.toLowerCase(), html: rule.html, ...(rule.why === undefined ? {} : { why: String(rule.why) }) };
  });

  return { window: { from, to }, cdx: { ...CDX_DEFAULTS, ...cdx }, sites: outSites, rules: outRules };
}

/**
 * Read + validate a site config file.
 * @param {string} file
 * @returns {ReturnType<typeof validateSiteConfig>}
 */
export function readSiteConfig(file) {
  return validateSiteConfig(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}
