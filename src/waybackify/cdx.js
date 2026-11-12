// CDX enumeration — the paged, outage-aware face of the capture index.
//
// WaybackMachine (index.js) asks the CDX index one question: "which capture
// of THIS url". Its three faces (getSnapshot / getCapture / getSnapshots) are
// exact-url lookups with a short retry (400/800/1600 ms). Enumeration is a
// different question — "every capture under this host / domain / prefix" —
// and it has different failure modes:
//
//   • THE INDEX REJECTS AN UNBOUNDED QUERY. A domain query with no `limit`
//     is refused. Every request here carries an explicit `limit` and pages
//     with `showResumeKey`.
//   • AN OUTAGE ANSWERS IN HTML. "Temporarily Offline" arrives as an HTML
//     page, sometimes under a 200. A body that is not a JSON array is a
//     failure, whatever the status says — never "no captures".
//   • OUTAGES LAST MINUTES, NOT SECONDS. The retry backs off from
//     `backoffMs` (30 s), doubling to `maxBackoffMs` (10 min), for
//     `maxAttempts` (10) attempts, then throws CdxUnavailableError. A throttle
//     is never read as an empty result.
//
// The raw page text is part of the result: a caller that saves every page
// verbatim can rebuild its whole derivation offline (parseCdxPage is pure).
//
// LIBRARY-FIRST: `fetch` and `sleep` are injectable, so the offline suite
// drives this against fixture pages; the default fetch is a WaybackMachine's
// impit (browser-impersonated — see index.js), constructed lazily.

import { NOOP_LOGGER } from './noop-logger.js';

/** The fields every enumeration row carries, in CDX column order. */
export const CDX_FIELDS = Object.freeze(['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']);

/** The `matchType` values the CDX server accepts. */
export const CDX_MATCH_TYPES = Object.freeze(['exact', 'prefix', 'host', 'domain']);

const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';

/** Every attempt at one CDX request failed (outage or throttle) — retry later. */
export class CdxUnavailableError extends Error {
  code = 'ERR_CDX_UNAVAILABLE';
  constructor(message, { url, attempts } = {}) {
    super(message);
    this.name = 'CdxUnavailableError';
    this.url = url;
    this.attempts = attempts;
  }
}

/**
 * Build a CDX request URL. A null/undefined param is omitted.
 * @param {Record<string, string|number|null|undefined>} params
 * @returns {string}
 */
export function cdxUrl(params) {
  const u = new URL(CDX_ENDPOINT);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Parse one `output=json` CDX page into row objects. PURE. The page is a JSON
 * array whose first row is the header; with `showResumeKey` an empty row
 * followed by a one-cell row carries the key of the next page.
 *
 * @param {string} text - the page body, verbatim
 * @param {string} [context] - label for error messages (usually a file path)
 * @returns {{ rows: Array<Record<string,string>>, resumeKey: string|null }}
 */
export function parseCdxPage(text, context = 'cdx page') {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${context}: not JSON (an outage page?)`);
  }
  if (!Array.isArray(data)) throw new Error(`${context}: CDX page is not a JSON array`);
  if (data.length === 0) return { rows: [], resumeKey: null };
  const header = data[0];
  if (!Array.isArray(header) || header.some(f => typeof f !== 'string')) {
    throw new Error(`${context}: CDX page has no header row`);
  }
  const rows = [];
  let resumeKey = null;
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (Array.isArray(r) && r.length === 0) {
      resumeKey = data[i + 1]?.[0] ?? null;
      break;
    }
    rows.push(Object.fromEntries(header.map((f, j) => [f, r[j]])));
  }
  return { rows, resumeKey };
}

/** First line of an error message — impit's connect errors are multi-line debug dumps. */
const firstLine = error => String(error?.message ?? error).split('\n')[0];

/**
 * GET one CDX request and return its body text, retrying an outage with a
 * long backoff. Success is a 200 whose body is a JSON array.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {Function} [options.fetch] - fetch-like (default: WaybackMachine impit)
 * @param {Function} [options.sleep] - (ms) => Promise (injectable)
 * @param {number} [options.maxAttempts=10]
 * @param {number} [options.backoffMs=30000] - first backoff; doubles per attempt
 * @param {number} [options.maxBackoffMs=600000]
 * @param {Object} [options.logger]
 * @returns {Promise<string>}
 */
export async function cdxFetch(url, options = {}) {
  const {
    maxAttempts = 10,
    backoffMs = 30000,
    maxBackoffMs = 600000,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    logger = NOOP_LOGGER
  } = options;
  const fetchImpl = options.fetch ?? (await defaultFetch());
  for (let attempt = 1; ; attempt++) {
    logger.info({ evt: 'request', method: 'GET', url, attempt, maxAttempts });
    const started = Date.now();
    let problem;
    let status = null;
    try {
      const res = await fetchImpl(url);
      status = res.status;
      const text = await res.text();
      if (res.status === 200 && /^\s*\[/.test(text)) {
        logger.info({ evt: 'response', url, status: 200, ms: Date.now() - started, attempt, bytes: text.length });
        return text;
      }
      problem = `HTTP ${res.status}${/^\s*</.test(text) ? ' (HTML body — the index is offline)' : ''}`;
    } catch (error) {
      problem = firstLine(error);
    }
    if (attempt >= maxAttempts) {
      logger.error({ evt: 'response', url, status, attempt, outcome: 'failed', error: problem, note: `${problem} · gave up after ${attempt} attempts` });
      throw new CdxUnavailableError(`${problem} after ${attempt} attempts: ${url}`, { url, attempts: attempt });
    }
    const wait = Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs);
    logger.warn({ evt: 'response', url, status, ms: Date.now() - started, attempt, error: problem, backoffMs: wait, note: `retry ${attempt}/${maxAttempts - 1}, backoff ${Math.round(wait / 1000)}s` });
    await sleep(wait);
  }
}

let sharedFetch = null;
async function defaultFetch() {
  if (!sharedFetch) {
    const { WaybackMachine } = await import('./index.js');
    const wayback = new WaybackMachine({ timeout: 120000 });
    sharedFetch = url => wayback.impit.fetch(url);
  }
  return sharedFetch;
}

/**
 * Enumerate one CDX query page by page. Yields each page as it arrives —
 * `{ page, text, rows, resumeKey }` — so a caller can persist `text` before
 * asking for the next one.
 *
 * @param {Object} query
 * @param {string} query.url - url, host, or domain to match
 * @param {'exact'|'prefix'|'host'|'domain'} [query.matchType='exact']
 * @param {string} [query.from] - window start (1–14 digits)
 * @param {string} [query.to] - window end (1–14 digits)
 * @param {string} [query.filter] - a CDX `filter` expression (e.g. `statuscode:200`)
 * @param {number} [query.pageLimit=100000] - rows per page; always sent
 * @param {string[]} [query.fields] - CDX `fl` (default CDX_FIELDS)
 * @param {Object} [options] - cdxFetch options, plus:
 * @param {number} [options.pauseMs=0] - pause between pages
 * @param {number} [options.maxPages=Infinity]
 * @returns {AsyncGenerator<{ page: number, text: string,
 *   rows: Array<Record<string,string>>, resumeKey: string|null }>}
 */
export async function* cdxPages(query, options = {}) {
  const { url, matchType = 'exact', from, to, filter, pageLimit = 100000, fields = CDX_FIELDS } = query ?? {};
  if (!url) throw new TypeError('cdxPages: query.url is required');
  if (!CDX_MATCH_TYPES.includes(matchType)) {
    throw new TypeError(`cdxPages: matchType must be one of ${CDX_MATCH_TYPES.join(' | ')} (got ${JSON.stringify(matchType)})`);
  }
  const { pauseMs = 0, maxPages = Infinity, sleep = ms => new Promise(r => setTimeout(r, ms)) } = options;
  let resumeKey = null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pauseMs > 0) await sleep(pauseMs);
    const requestUrl = cdxUrl({
      url,
      matchType: matchType === 'exact' ? undefined : matchType,
      from,
      to,
      filter,
      output: 'json',
      fl: fields.join(','),
      limit: pageLimit,
      showResumeKey: 'true',
      resumeKey: resumeKey ?? undefined
    });
    const text = await cdxFetch(requestUrl, { ...options, sleep });
    const parsed = parseCdxPage(text, requestUrl);
    yield { page, text, rows: parsed.rows, resumeKey: parsed.resumeKey };
    resumeKey = parsed.resumeKey;
    if (!resumeKey) return;
  }
}
