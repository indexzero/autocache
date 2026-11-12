// enumerate — a site's CDX index → a capture list `cache fill` can drive to
// closure.
//
// For every site in the config this walks the CDX index for each of its
// queries, inside the config's window, and writes under <ledger>/<site>/:
//
//   captures.jsonl          the CAPTURE LIST (waybackify ledger.js): one row
//                           per distinct version of every URL. `rank` is the
//                           version's rank within its URL, so rank 0 alone is
//                           a one-capture-per-URL mirror and `cache fill`
//                           fetches it first.
//   cdx/<query>.pNNN.json   the raw CDX pages, verbatim — provenance, and
//                           the whole input of an --offline rebuild
//   cdx/target~<url>.p…     exact CDX rows for redirect targets
//   redirects.jsonl         the resolved Location of each distinct 3xx
//   inventory.jsonl         every CDX row, with its disposition
//   summary.json            counts
//
// A VERSION is one distinct CDX digest of one URL (urlkey), taken at its
// earliest 200 capture inside the window. Grouping by urlkey folds the
// index's own aliasing (`www.`, `:80`, case) into one URL; the row's
// `original` is kept verbatim, because that spelling is the capture's key.
//
// REPLAY MODE. HTML is fetched through the normal replay, so `cache fill`
// records and fetches its page requisites — unless a config rule marks its
// host `"html": "raw"`. Everything else is fetched raw (`id_`): the normal
// replay of a non-HTML capture is the archive's viewer page, which the cache
// refuses as a wrapper-stub interstitial.
//
// REDIRECTS. A 3xx capture stores no content, only a Location the index does
// not list. Each distinct one is probed once (raw replay, redirect not
// followed); a target inside a configured site that no 200 capture covers
// gets its own exact query, up to three rounds deep.
//
// DETERMINISTIC. Nothing written here carries a clock reading, and every
// file is written only when its bytes change — a rerun over the same CDX
// pages leaves the ledger byte-identical, and `offline: true` proves it
// without touching the network.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseWaybackUrl } from '@autocache/waybackify/audit.js';
import { readSidecar } from '@autocache/waybackify/cache.js';
import { cdxPages, parseCdxPage } from '@autocache/waybackify/cdx.js';
import { captureKey } from '@autocache/waybackify/key.js';
import { CAPTURE_LIST } from '@autocache/waybackify/ledger.js';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order: locale-independent
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)$/i;
const isRedirect = status => /^3\d\d$/.test(String(status));
const pad3 = n => String(n).padStart(3, '0');
const firstLine = error => String(error?.message ?? error).split('\n')[0];
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** A file-name-safe slug of a query or URL; long ones keep a hash suffix. */
function slug(s) {
  const out = s.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.@=-]+/g, '_');
  return out.length <= 150 ? out : `${out.slice(0, 140)}-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)}`;
}

/** Write only when the bytes differ, so reruns leave mtimes (and git) alone. */
function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/* ------------------------------------------------------------------ scope */

/** IA-style match key: scheme-less, lowercase, no www., no default port, no fragment. */
function normKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\d*\./, '');
    return `${host}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

function queryHost(q) {
  return (/^https?:\/\//.test(q.url) ? new URL(q.url).hostname : q.url.split('/')[0]).toLowerCase().replace(/:\d+$/, '');
}

/** The configured site whose queries cover `url`, or null. */
function siteFor(url, sites) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const s of sites) {
    for (const q of s.queries) {
      const qh = queryHost(q);
      if (q.matchType === 'domain' && (host === qh || host.endsWith(`.${qh}`))) return s.name;
      if (q.matchType === 'host' && host.replace(/^www\./, '') === qh.replace(/^www\./, '')) return s.name;
      if ((q.matchType === 'prefix' || q.matchType === 'exact') &&
        normKey(url).startsWith(normKey(/^https?:/.test(q.url) ? q.url : `http://${q.url}`))) return s.name;
    }
  }
  return null;
}

/** Replay mode for an HTML capture: the first rule whose host matches; default replay. */
function htmlMode(original, rules) {
  let host;
  try {
    host = new URL(original).hostname.toLowerCase();
  } catch {
    return 'replay';
  }
  for (const rule of rules) {
    if (host === rule.host || host.endsWith(`.${rule.host}`)) return rule.html;
  }
  return 'replay';
}

/* -------------------------------------------------------------- selection */

/**
 * Select the versions of one site from its CDX rows. PURE: rows in, the
 * inventory, the capture list, and the summary counts out.
 *
 * Dispositions (one per CDX row, in the inventory):
 *   version        the capture chosen for one distinct digest of its URL
 *   same-content   another capture of a digest that already has a version
 *   repicked-away  a capture the cache root already proved bad (`bad`)
 *   non-ok         a non-200 capture (a 3xx carries its resolved redirect)
 *   out-of-window  outside the config window (a redirect-target row)
 *   duplicate-row  an exact repeat of an earlier row
 *
 * @param {Array<Record<string,string>>} rows - CDX rows, each with `query`
 * @param {Object} options
 * @param {string} options.site - the site name
 * @param {{ from: string, to: string }} options.window - 14-digit bounds
 * @param {Array<{ host: string, html: string }>} [options.rules]
 * @param {Map<string, object>} [options.redirects] - `<ts>/<original>` → resolution
 * @param {Map<string, string>} [options.bad] - capture key → reason
 * @param {(url: string) => string|null} [options.siteOf] - redirect target → site
 * @returns {{ inventory: object[], captures: object[], counts: object }}
 */
export function selectVersions(rows, options) {
  const { site, window, rules = [], redirects = new Map(), bad = new Map(), siteOf = () => null } = options;
  const inWindow = ts => ts >= window.from.slice(0, ts.length) && ts <= window.to.slice(0, ts.length);
  const sorted = [...rows].sort((a, b) =>
    cmp(a.urlkey, b.urlkey) || cmp(a.timestamp, b.timestamp) || cmp(a.original, b.original) ||
    cmp(a.statuscode, b.statuscode) || cmp(a.digest, b.digest) || cmp(a.query ?? '', b.query ?? ''));

  const inventory = [];
  const seen = new Set();
  const groups = new Map(); // urlkey → Map(digest → rows[])
  for (const r of sorted) {
    const rec = { ...r, disposition: null };
    inventory.push(rec);
    const id = `${r.timestamp} ${r.original} ${r.statuscode} ${r.digest} ${r.mimetype} ${r.length}`;
    if (seen.has(id)) { rec.disposition = 'duplicate-row'; continue; }
    seen.add(id);
    if (!inWindow(r.timestamp)) { rec.disposition = 'out-of-window'; continue; }
    if (r.statuscode !== '200') {
      rec.disposition = 'non-ok';
      const res = redirects.get(`${r.timestamp}/${r.original}`);
      if (res) rec.redirect = { status: res.status, target: res.target, site: res.target ? siteOf(res.target) : null };
      continue;
    }
    if (!groups.has(r.urlkey)) groups.set(r.urlkey, new Map());
    const byDigest = groups.get(r.urlkey);
    if (!byDigest.has(r.digest)) byDigest.set(r.digest, []);
    byDigest.get(r.digest).push(rec);
  }

  const counts = {
    rows: sorted.length, okUrls: groups.size, versions: 0, maxVersionsPerUrl: 0,
    byStatus: {}, disposition: {}, versionsByMimetype: {},
    redirects: { rows: 0, resolved: 0, intoSites: 0 }
  };
  const captures = [];
  for (const byDigest of groups.values()) {
    const chosen = [];
    for (const cands of byDigest.values()) {
      let pick = null;
      for (const c of cands) {
        const reason = bad.get(captureKey(c.timestamp, c.original));
        if (reason) { c.disposition = 'repicked-away'; c.bad = reason; continue; }
        pick ??= c;
      }
      pick ??= cands[0]; // every capture of this digest is bad: keep the earliest anyway
      for (const c of cands) if (c !== pick && c.disposition === null) c.disposition = 'same-content';
      pick.disposition = 'version';
      chosen.push(pick);
    }
    chosen.sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.original, b.original));
    chosen.forEach((c, rank) => {
      const raw = !HTML_TYPES.test(c.mimetype) || htmlMode(c.original, rules) === 'raw';
      c.rank = rank;
      c.wayback = `https://web.archive.org/web/${c.timestamp}${raw ? 'id_' : ''}/${c.original}`;
      captures.push({
        wayback: c.wayback, rank, site, original: c.original, timestamp: c.timestamp,
        mimetype: c.mimetype, digest: c.digest, length: c.length, urlkey: c.urlkey
      });
      counts.versionsByMimetype[c.mimetype] = (counts.versionsByMimetype[c.mimetype] ?? 0) + 1;
    });
    counts.versions += chosen.length;
    counts.maxVersionsPerUrl = Math.max(counts.maxVersionsPerUrl, chosen.length);
  }

  for (const rec of inventory) {
    counts.byStatus[rec.statuscode] = (counts.byStatus[rec.statuscode] ?? 0) + 1;
    counts.disposition[rec.disposition] = (counts.disposition[rec.disposition] ?? 0) + 1;
    if (isRedirect(rec.statuscode) && rec.disposition === 'non-ok') {
      counts.redirects.rows++;
      if (rec.redirect?.target) counts.redirects.resolved++;
      if (rec.redirect?.site) counts.redirects.intoSites++;
    }
  }
  return { inventory, captures, counts };
}

/* ---------------------------------------------------------------- enumerate */

/**
 * Enumerate every site in a config into a ledger directory.
 *
 * @param {ReturnType<import('./config.js').validateSiteConfig>} config
 * @param {Object} options
 * @param {string} options.ledger - directory the per-site trees are written under (REQUIRED)
 * @param {string[]} [options.sites] - only these site names (default: all)
 * @param {boolean} [options.offline=false] - no network: rebuild from the saved CDX pages
 * @param {boolean} [options.redirects=true] - resolve 3xx Locations and query their targets
 * @param {string} [options.repickFrom] - a cache root: skip captures it holds
 *   as interstitial or error, or lists in .refetch/gone.jsonl, and pick the
 *   next capture with the same digest
 * @param {Function} [options.fetch] - fetch-like `(url, init?)` (default: WaybackMachine impit)
 * @param {Function} [options.sleep] - (ms) => Promise (injectable)
 * @param {(ev: object) => void} [options.onProgress]
 * @param {Object} [options.logger]
 * @returns {Promise<{ ledger: string, window: { from: string, to: string },
 *   offline: boolean, sites: Record<string, object> }>}
 */
export async function enumerate(config, options = {}) {
  const {
    ledger,
    offline = false,
    redirects: wantRedirects = true,
    repickFrom,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    onProgress = () => {},
    logger
  } = options;
  if (!ledger) throw new TypeError('enumerate: options.ledger is required');
  const LEDGER = path.resolve(ledger);
  const { window, cdx, rules } = config;
  const sites = config.sites.filter(s => !options.sites || options.sites.includes(s.name));
  if (sites.length === 0) throw new Error(`enumerate: no site named ${(options.sites ?? []).join(', ')} in the config`);
  const siteDir = name => path.join(LEDGER, name);
  const cdxDir = name => path.join(siteDir(name), 'cdx');
  const inWindow = ts => ts >= window.from.slice(0, ts.length) && ts <= window.to.slice(0, ts.length);

  // ---- network: one paced fetch for CDX pages and redirect probes alike.
  let fetchImpl = options.fetch;
  let lastAt = 0;
  const paced = async (url, init) => {
    if (!fetchImpl) {
      const { WaybackMachine } = await import('@autocache/waybackify');
      const wayback = new WaybackMachine({ timeout: 120000 });
      fetchImpl = (u, i) => wayback.impit.fetch(u, i);
    }
    const wait = lastAt + cdx.pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return fetchImpl(url, init);
  };
  const retry = { maxAttempts: cdx.maxAttempts, backoffMs: cdx.backoffMs, maxBackoffMs: cdx.maxBackoffMs, sleep, logger };

  /** Run one CDX query, saving each raw page; offline replays the saved pages. */
  async function runQuery(dir, name, query) {
    const rows = [];
    let pages = 0;
    if (offline) {
      for (let resumeKey = true; resumeKey; pages++) {
        const file = path.join(dir, `${name}.p${pad3(pages)}.json`);
        if (!fs.existsSync(file)) throw new Error(`enumerate: offline, and the saved CDX page is missing: ${file}`);
        const parsed = parseCdxPage(fs.readFileSync(file, 'utf8'), file);
        rows.push(...parsed.rows);
        resumeKey = parsed.resumeKey;
      }
      return rows;
    }
    for await (const page of cdxPages({ ...query, from: window.from, to: window.to, pageLimit: cdx.pageLimit }, { ...retry, fetch: paced })) {
      onProgress({ type: 'cdx-page', query: name, page: page.page, rows: page.rows.length });
      writeIfChanged(path.join(dir, `${name}.p${pad3(page.page)}.json`), page.text);
      rows.push(...page.rows);
      pages = page.page + 1;
    }
    // A shorter rerun must not leave stale trailing pages behind.
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const m = f.startsWith(`${name}.p`) && /\.p(\d{3})\.json$/.exec(f);
      if (m && Number(m[1]) >= pages) fs.unlinkSync(path.join(dir, f));
    }
    return rows;
  }

  /** Resolve one 3xx capture's Location through the raw replay, not followed. */
  async function resolveRedirect(row) {
    const url = `https://web.archive.org/web/${row.timestamp}id_/${row.original}`;
    for (let attempt = 1; ; attempt++) {
      let problem;
      try {
        const res = await paced(url, { redirect: 'manual' });
        if (res.status !== 429 && res.status < 500) {
          const location = res.headers?.get?.('location') ?? null;
          let target = null;
          if (location) {
            let abs = null;
            try { abs = new URL(location, 'https://web.archive.org/').href; } catch { /* unparseable */ }
            const parsed = abs ? parseWaybackUrl(abs) : null;
            if (parsed) target = parsed.original;
            else {
              try { target = new URL(location, row.original).href; } catch { target = null; }
            }
          }
          return { key: `${row.timestamp}/${row.original}`, status: res.status, location, target };
        }
        problem = `HTTP ${res.status}`;
      } catch (error) {
        problem = firstLine(error);
      }
      if (attempt >= cdx.maxAttempts) throw new Error(`${problem} after ${attempt} attempts: ${url}`);
      await sleep(Math.min(cdx.backoffMs * 2 ** (attempt - 1), cdx.maxBackoffMs));
    }
  }

  // ---- the site queries.
  const perSite = new Map(); // site name → { rows, redirects, targetQueries }
  for (const site of sites) {
    const rows = [];
    for (const q of site.queries) {
      const name = slug(`${q.url}~${q.matchType}`);
      for (const r of await runQuery(cdxDir(site.name), name, q)) rows.push({ ...r, query: name });
    }
    perSite.set(site.name, { rows, redirects: new Map(), targetQueries: new Set() });
    onProgress({ type: 'site-rows', site: site.name, rows: rows.length });
  }

  // ---- 3xx resolution: follow redirects that land inside the configured sites.
  if (wantRedirects) {
    for (let round = 0; round < 3; round++) {
      let added = 0;
      for (const site of sites) {
        const state = perSite.get(site.name);
        const cacheFile = path.join(siteDir(site.name), 'redirects.jsonl');
        const cache = new Map(readJsonl(cacheFile).map(r => [r.key, r]));
        // One probe per distinct (urlkey, digest): the earliest such capture.
        const reps = new Map();
        for (const r of [...state.rows].sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.original, b.original))) {
          if (!isRedirect(r.statuscode) || !inWindow(r.timestamp)) continue;
          const id = `${r.urlkey} ${r.digest}`;
          if (!reps.has(id)) reps.set(id, r);
        }
        let probed = 0;
        for (const r of reps.values()) {
          const key = `${r.timestamp}/${r.original}`;
          if (cache.has(key) || offline) continue;
          try {
            cache.set(key, await resolveRedirect(r));
            probed++;
          } catch (error) {
            onProgress({ type: 'redirect-failed', site: site.name, key, error: firstLine(error) });
          }
        }
        writeIfChanged(cacheFile, jsonl([...cache.values()].sort((a, b) => cmp(a.key, b.key))
          .map(r => ({ key: r.key, status: r.status, location: r.location, target: r.target }))));
        if (probed) onProgress({ type: 'redirects', site: site.name, resolved: probed });
        // Every 3xx row shares its representative's resolution.
        for (const r of state.rows) {
          if (!isRedirect(r.statuscode)) continue;
          const rep = reps.get(`${r.urlkey} ${r.digest}`);
          const res = rep && cache.get(`${rep.timestamp}/${rep.original}`);
          if (res) state.redirects.set(`${r.timestamp}/${r.original}`, res);
        }
      }
      // Targets inside a selected site that no 200 row covers → an exact query.
      const covered = new Set();
      for (const { rows } of perSite.values()) {
        for (const r of rows) if (r.statuscode === '200' && inWindow(r.timestamp)) covered.add(normKey(r.original));
      }
      const wanted = new Map(); // target site → Set(target url)
      for (const { redirects } of perSite.values()) {
        for (const res of redirects.values()) {
          if (!res.target) continue;
          const tsite = siteFor(res.target, config.sites);
          if (!tsite || !perSite.has(tsite) || covered.has(normKey(res.target))) continue;
          if (!wanted.has(tsite)) wanted.set(tsite, new Set());
          wanted.get(tsite).add(res.target);
        }
      }
      for (const [tsite, targets] of wanted) {
        const state = perSite.get(tsite);
        for (const target of [...targets].sort()) {
          const name = slug(`target~${target}`);
          if (state.targetQueries.has(name)) continue;
          state.targetQueries.add(name);
          if (offline && !fs.existsSync(path.join(cdxDir(tsite), `${name}.p000.json`))) continue;
          try {
            const rows = await runQuery(cdxDir(tsite), name, { url: target, matchType: 'exact' });
            for (const r of rows) state.rows.push({ ...r, query: name });
            added += rows.length;
          } catch (error) {
            onProgress({ type: 'target-failed', site: tsite, target, error: firstLine(error) });
          }
        }
      }
      if (added === 0) break;
      onProgress({ type: 'redirect-round', round, rows: added });
    }
  }

  // ---- re-pick: captures a cache root already proved bad.
  const bad = new Map(); // capture key → reason
  if (repickFrom) {
    for (const { waybackUrl } of readJsonl(path.join(repickFrom, '.refetch', 'gone.jsonl'))) {
      const p = waybackUrl ? parseWaybackUrl(waybackUrl) : null;
      if (p) bad.set(captureKey(p.timestamp, p.original), 'gone');
    }
    for (const { rows } of perSite.values()) {
      for (const r of rows) {
        if (r.statuscode !== '200') continue;
        const key = captureKey(r.timestamp, r.original);
        if (bad.has(key)) continue;
        const sidecar = await readSidecar(repickFrom, key).catch(() => null);
        if (sidecar && (sidecar.status === 'interstitial' || sidecar.status === 'error')) bad.set(key, sidecar.status);
      }
    }
  }

  // ---- select versions; write the capture list, inventory, and summary.
  const sortObj = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
  const field = (o, k) => (o[k] === undefined ? {} : { [k]: o[k] });
  const totals = {};
  for (const site of sites) {
    const state = perSite.get(site.name);
    const { inventory, captures, counts } = selectVersions(state.rows, {
      site: site.name, window, rules, redirects: state.redirects, bad,
      siteOf: url => siteFor(url, config.sites)
    });
    writeIfChanged(path.join(siteDir(site.name), CAPTURE_LIST), jsonl(captures));
    writeIfChanged(path.join(siteDir(site.name), 'inventory.jsonl'), jsonl(inventory.map(r => ({
      timestamp: r.timestamp, original: r.original, mimetype: r.mimetype, statuscode: r.statuscode,
      digest: r.digest, length: r.length, urlkey: r.urlkey, query: r.query, disposition: r.disposition,
      ...field(r, 'bad'), ...field(r, 'rank'), ...field(r, 'wayback'), ...field(r, 'redirect')
    }))));
    const summary = {
      site: site.name,
      window,
      queries: site.queries,
      rows: counts.rows,
      okUrls: counts.okUrls,
      versions: counts.versions,
      maxVersionsPerUrl: counts.maxVersionsPerUrl,
      byStatus: sortObj(counts.byStatus),
      disposition: sortObj(counts.disposition),
      versionsByMimetype: sortObj(counts.versionsByMimetype),
      redirects: counts.redirects
    };
    writeIfChanged(path.join(siteDir(site.name), 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    totals[site.name] = {
      rows: summary.rows, okUrls: summary.okUrls, versions: summary.versions,
      maxVersionsPerUrl: summary.maxVersionsPerUrl, redirects: summary.redirects
    };
    onProgress({ type: 'site', site: site.name, ...totals[site.name] });
  }

  return { ledger: LEDGER, window, offline, sites: totals };
}
