import { Impit } from 'impit';
import { NOOP_LOGGER } from './noop-logger.js';

/** CDX from/to (YYYYMMDD) spanning ±`months` around a YYYYMMDD[HHMMSS] date. */
function window(near, months) {
  const y = Number(near.slice(0, 4));
  const m = Number(near.slice(4, 6)) || 1;
  const d = Number(near.slice(6, 8)) || 1;
  const fmt = dt => dt.toISOString().slice(0, 10).replace(/-/g, '');
  const from = new Date(Date.UTC(y, m - 1, d));
  from.setUTCMonth(from.getUTCMonth() - months);
  const to = new Date(Date.UTC(y, m - 1, d));
  to.setUTCMonth(to.getUTCMonth() + months);
  return { from: fmt(from), to: fmt(to) };
}

/**
 * Internet Archive Wayback Machine API client.
 *
 * HTTP goes through `impit` (browser impersonation) rather than a plain client
 * — the Internet Archive throttles/blocks naive bulk clients, and impit's
 * real-browser TLS/HTTP fingerprint sustains the throughput a corpus-wide
 * re-import needs. The fingerprint is FIREFOX, not chrome: as of impit 0.14.1
 * archive.org's edge answers the chrome fingerprint with a hard 498 on every
 * request (an nginx "404 Not Found" body) while the firefox fingerprint gets a
 * clean 200. Override via `options.impit` if that flips again.
 *
 * Lookups use the CDX index (`/cdx/search/cdx`), not `/wayback/available`:
 * `/available` intermittently returns an empty result for URLs that ARE
 * archived (even on a single request), which silently leaves live links
 * un-rewritten. CDX is authoritative.
 */
class WaybackMachine {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'http://archive.org';
    this.maxAttempts = options.maxAttempts ?? 3;
    this.impit = options.impit || new Impit({ browser: 'firefox', timeout: options.timeout ?? 20000 });
    // The injected diagnostic logger (default no-op). This is the load-bearing
    // request/response trace seam (design §4): every CDX request AND every retry
    // attempt emits an `evt:'request'` on send and an `evt:'response'` on
    // receive, curl-style. Levels: 2xx info (the firehose); 429/5xx mid-retry
    // warn; final give-up error. The pretty rendering lives in the CLI; the
    // library only emits the structured facts (§1: a library emits, the caller
    // renders). (This subsumes the former onRequest/onResponse observers, which
    // no caller consumed for data.)
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Get an archived snapshot for a URL via the CDX index. Returns the 200
   * capture CLOSEST to `near` (a YYYYMMDD[HHMMSS] target — e.g. the post's
   * date) so a link points at the version that was live when it was written,
   * not the earliest snapshot ever taken. Without `near`, returns the latest
   * capture. Retries transient failures with backoff; a clean empty result is
   * "not archived" → null.
   * @param {string} url - The URL to find an archived version of
   * @param {Object} [opts]
   * @param {string} [opts.near] - Preferred timestamp (YYYYMMDD[HHMMSS])
   * @returns {Promise<Object|null>} { url, timestamp, available } or null
   */
  async getSnapshot(url, { near } = {}) {
    // Bound the CDX scan with a date WINDOW around the target rather than
    // collapsing the URL's whole history — `collapse` forces a full-history
    // scan that hangs on heavily-archived domains (e.g. github.com paths).
    //
    // Try a tight window first (a capture from the post's exact era), widening
    // only when the IA simply has nothing that close — archiving is sparse, so
    // a fixed ±2mo window would usually be empty. Each step is still bounded.
    let rows = [];
    if (near) {
      for (const months of [2, 12, 60]) {
        rows = await this.#cdxRows(url, { ...window(near, months), limit: 50 });
        if (rows.length > 0) break;
      }
    }
    // No date, or nothing within ~5y of it: take the latest capture (if any).
    if (rows.length === 0) rows = await this.#cdxRows(url, { fastLatest: 'true', limit: 1 });
    if (rows.length === 0) return null; // authoritatively not archived

    const target = near ? Number(near.padEnd(14, '0')) : Number(rows[rows.length - 1][0]);
    const [ts, original] = rows.reduce((best, r) =>
      Math.abs(Number(r[0]) - target) < Math.abs(Number(best[0]) - target) ? r : best
    );
    return { url: `https://web.archive.org/web/${ts}/${original}`, timestamp: ts, available: true };
  }

  /**
   * The CDX record for one EXACT capture (timestamp + original URL), with its
   * archived `statuscode` — the field the replay UI hides (web.archive.org
   * returns HTTP 200 for a replay whose captured content was itself a 404).
   * This is the audit primitive behind the wayback-404 verdicts (audit.js).
   *
   * No `statuscode:200` filter here — seeing the error captures is the point.
   * Returns { timestamp, original, statuscode, mimetype } for the row whose
   * timestamp matches exactly, null when the CDX index has no such capture.
   * Throws (like getSnapshot) if every attempt fails, so a throttle is never
   * mistaken for "capture does not exist".
   * @param {string} url - The ORIGINAL captured URL
   * @param {string} timestamp - Exact capture timestamp (YYYYMMDDHHMMSS)
   * @returns {Promise<Object|null>}
   */
  async getCapture(url, timestamp) {
    const rows = await this.#cdxRows(url, {
      from: timestamp,
      to: timestamp,
      limit: 10,
      filter: null, // drop the default statuscode:200 — error captures are the quarry
      fl: 'timestamp,original,statuscode,mimetype'
    });
    const row = rows.find(r => r[0] === timestamp);
    if (!row) return null;
    return { timestamp: row[0], original: row[1], statuscode: row[2], mimetype: row[3] };
  }

  /**
   * One CDX query → its data rows ([timestamp, original]). Retries transient
   * failures (timeout / non-200) with backoff and THROWS if all attempts fail,
   * so a caller never mistakes a throttle for "not archived".
   * `params` land after the defaults, so they can override them; a null/
   * undefined value DELETES the default (getCapture drops the statuscode:200
   * filter this way).
   */
  async #cdxRows(url, params) {
    const api = new URL('https://web.archive.org/cdx/search/cdx');
    api.searchParams.set('url', url);
    api.searchParams.set('output', 'json');
    api.searchParams.set('filter', 'statuscode:200');
    api.searchParams.set('fl', 'timestamp,original');
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) api.searchParams.delete(k);
      else api.searchParams.set(k, String(v));
    }
    const requestUrl = api.toString();

    let lastError;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1))); // 400/800/1600ms
      }
      const willRetry = attempt < this.maxAttempts - 1;
      this.logger.info({ evt: 'request', method: 'GET', url: requestUrl, attempt: attempt + 1, maxAttempts: this.maxAttempts });
      const started = Date.now();
      try {
        const res = await this.impit.fetch(requestUrl);
        const ms = Date.now() - started;
        if (res.status === 200) {
          const contentType = res.headers?.get?.('content-type') || '';
          const data = await res.json();
          // data[0] is the header; data rows are [timestamp, original].
          const rows = Array.isArray(data) ? data.slice(1) : [];
          this.logger.info({ evt: 'response', url: requestUrl, status: 200, ms, attempt: attempt + 1, contentType, rows: rows.length });
          return rows;
        }
        lastError = new Error(`HTTP ${res.status}`);
        // transient — back off and retry. The give-up (final attempt) is logged
        // ONCE below, at error level, so only actual retries speak here.
        if (willRetry) {
          const backoffMs = 400 * 2 ** attempt; // the sleep the NEXT iteration takes
          this.logger.warn({ evt: 'response', url: requestUrl, status: res.status, ms, attempt: attempt + 1, backoffMs, note: `retry ${attempt + 1}/${this.maxAttempts}, backoff ${backoffMs}ms` });
        }
      } catch (error) {
        const ms = Date.now() - started;
        lastError = error;
        if (willRetry) {
          const backoffMs = 400 * 2 ** attempt; // the sleep the NEXT iteration takes
          this.logger.warn({ evt: 'response', url: requestUrl, status: null, ms, attempt: attempt + 1, error: error?.message, backoffMs, note: `retry ${attempt + 1}/${this.maxAttempts}, backoff ${backoffMs}ms` });
        }
      }
    }
    // Every attempt failed → give up (the §4 ERR row; error level, §5).
    this.logger.error({
      evt: 'response',
      url: requestUrl,
      status: null,
      attempt: this.maxAttempts,
      outcome: 'failed',
      error: lastError?.message,
      note: `${lastError?.message ?? 'error'} · gave up after ${this.maxAttempts} attempts`
    });
    throw lastError ?? new Error(`waybackify: lookup failed for ${url}`);
  }

  /**
   * Get multiple snapshots for a URL
   * @param {string} url - The URL to find archived versions of
   * @param {Object} [options] - Query options
   * @param {string} [options.from] - Start timestamp (YYYYMMDD format)
   * @param {string} [options.to] - End timestamp (YYYYMMDD format)
   * @param {number} [options.limit=10] - Maximum number of results
   * @returns {Promise<Array>} Array of snapshot information
   */
  async getSnapshots(url, options = {}) {
    const { from, to, limit = 10 } = options;
    const apiUrl = new URL('/cdx/search/cdx', 'http://web.archive.org');
    
    apiUrl.searchParams.set('url', url);
    apiUrl.searchParams.set('output', 'json');
    apiUrl.searchParams.set('limit', limit.toString());
    
    if (from) {
      apiUrl.searchParams.set('from', from);
    }
    if (to) {
      apiUrl.searchParams.set('to', to);
    }

    const requestUrl = apiUrl.toString();
    this.logger.info({ evt: 'request', method: 'GET', url: requestUrl, attempt: 1, maxAttempts: 1 });
    const started = Date.now();
    try {
      const response = await this.impit.fetch(requestUrl);
      const ms = Date.now() - started;

      if (response.status !== 200) {
        this.logger.warn({ evt: 'response', url: requestUrl, status: response.status, ms, attempt: 1 });
        return [];
      }

      const contentType = response.headers?.get?.('content-type') || '';
      const data = await response.json();
      const rows = data.length > 1 ? data.slice(1) : [];
      this.logger.info({ evt: 'response', url: requestUrl, status: 200, ms, attempt: 1, contentType, rows: rows.length });

      // First row is headers, skip it
      if (rows.length === 0) {
        return [];
      }

      // Convert to objects with proper field names
      return rows.map(row => ({
        timestamp: row[1],
        url: row[2],
        mimetype: row[3],
        statuscode: row[4],
        digest: row[5],
        length: row[6],
        waybackUrl: `${this.baseUrl}/web/${row[1]}/${row[2]}`
      }));
    } catch (error) {
      // Was a bare console.error that returned [] (a silent fault — a throttle
      // read as "no snapshots"); now a structured warn (design §1 / blind
      // spot #7). Still returns [] to preserve the legacy contract.
      this.logger.warn({ evt: 'response', url: requestUrl, status: null, ms: Date.now() - started, attempt: 1, error: error?.message, note: error?.message });
      return [];
    }
  }
}

/**
 * Transform a URL into an Internet Archive Wayback Machine permalink
 * @param {string} url - The URL to waybackify
 * @param {Object} [options] - Wayback options
 * @param {WaybackMachine} [options.wayback] - Custom wayback instance
 * @returns {Promise<string|null>} Wayback URL, or null if not archived / lookup failed
 */
export async function waybackify(url, options = {}) {
  const { wayback = new WaybackMachine() } = options;

  // Skip if already a wayback URL
  if (url.includes('web.archive.org/web/')) {
    return url;
  }

  // Skip non-http URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return null;
  }

  // A transient lookup failure throws; here we treat it the same as "not
  // archived" — leave the link unchanged. Callers that need to retry later
  // (the manifest builder) call getSnapshot directly and handle the throw.
  let snapshot;
  try {
    snapshot = await wayback.getSnapshot(url);
  } catch {
    return null;
  }
  return snapshot?.available ? snapshot.url : null;
}

/**
 * Transform multiple URLs into Wayback Machine permalinks
 * @param {Array<string>} urls - Array of URLs to waybackify
 * @param {Object} [options] - Wayback options
 * @returns {Promise<Array<{url: string, waybackUrl: string|null}>>} Results
 */
export async function waybackifyBatch(urls, options = {}) {
  const wayback = options.wayback || new WaybackMachine();
  const results = [];

  for (const url of urls) {
    const waybackUrl = await waybackify(url, { ...options, wayback });
    results.push({ url, waybackUrl });
  }

  return results;
}

// Matches, in precedence order (non-overlapping, left-to-right):
//   1. inline link / image embed   (!?)[text](url)   — group 1 bang, 2 text, 3 url
//   2. reference definition         [label]: url      — group 4 label, 5 url  (line-anchored)
//   3. HTML anchor                  <a href="url">t</a> — group 6 url, 7 text
//   4. CommonMark autolink          <url>              — group 8 url; a real link
//      form (the corpus uses it), previously invisible to every consumer
//      because the bare-URL lookbehind rejects a preceding `<`.
//   5. bare URL in prose            http(s)://…        — whole match; lookbehind keeps it
//      from re-matching a URL already captured by a link form above.
//
// Inline destinations and bare URLs consume one level of BALANCED parens —
// CommonMark allows them and real corpora use them (the msdn.microsoft.com
// /…/dd129517(VS.85).aspx style); an unbalanced `(` or a bare `)` still
// terminates the URL. Same rule manifest.js#extractArchiveUrls applies when
// scanning already-archived sources, so the two scanners agree on where a
// URL ends.
const LINK_PATTERN =
  /(!?)\[([^\]]+)\]\(((?:\([^()\s]*\)|[^()\s])+)\)|^[ \t]*\[([^\]]+)\]:[ \t]*(\S+)|<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>|<(https?:\/\/[^>\s]+)>|(?<![("/<\]])https?:\/\/(?:\([^()\s<>"'\]]*\)|[^\s()<>"'\]])+/gm;

/** Classify a regex match into {url, form, text} or null if it carries no URL. */
function classifyMatch(m) {
  if (m[3] !== undefined) return { url: m[3], form: m[1] === '!' ? 'image' : 'inline', text: m[2] };
  if (m[5] !== undefined) return { url: m[5], form: 'reference', text: m[4] };
  if (m[6] !== undefined) return { url: m[6], form: 'html', text: m[7] };
  if (m[8] !== undefined) return { url: m[8], form: 'autolink', text: m[8] };
  return { url: m[0], form: 'bare', text: m[0] };
}

/**
 * Extract the unique external http(s) URLs from markdown that
 * waybackifyMarkdown would archive — inline / reference / HTML links,
 * CommonMark `<url>` autolinks, and bare prose URLs, in document order. PURE (no network): this is the detection half
 * of waybackifyMarkdown, for callers that resolve + cache separately (e.g. an
 * incremental manifest builder). Image embeds, internal/relative links,
 * non-http(s) schemes, already-archived URLs, and anything in `skip` are
 * excluded.
 * @param {string} markdown
 * @param {Object} [options]
 * @param {Array<string>} [options.skip] - URLs to exclude (exact or prefix)
 * @returns {string[]} unique archivable URLs
 */
export function extractLinks(markdown, options = {}) {
  const { skip = [] } = options;
  const isSkipped = url => skip.some(s => url === s || url.startsWith(s));
  const seen = new Set();
  const out = [];
  for (const m of markdown.matchAll(LINK_PATTERN)) {
    const { url, form } = classifyMatch(m);
    if (form === 'image') continue;
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
    if (url.includes('web.archive.org/web/')) continue;
    if (isSkipped(url)) continue;
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Transform markdown content by replacing dead links with wayback URLs.
 * Handles inline links, reference definitions, HTML anchors, `<url>`
 * autolinks, and bare prose URLs. Image embeds (`![alt](url)`) are left untouched — they're assets, not
 * links. Internal/relative/anchor links and non-http(s) schemes are ignored.
 * @param {string} markdown - Markdown content
 * @param {Object} [options] - Wayback options
 * @param {Array<string>} [options.domains] - Only process links from these domains
 * @param {Array<string>} [options.skip] - URLs to leave untouched (exact match or
 *   prefix). Used for links that are still live and must NOT be archived.
 * @param {boolean} [options.dryRun=false] - Don't replace, just report
 * @param {WaybackMachine} [options.wayback] - Custom wayback instance
 * @returns {Promise<{content: string, replacements: Array}>}
 */
export async function waybackifyMarkdown(markdown, options = {}) {
  const { domains = [], skip = [], dryRun = false } = options;
  const wayback = options.wayback || new WaybackMachine();
  const isSkipped = url => skip.some(s => url === s || url.startsWith(s));

  const replacements = [];
  const edits = []; // { start, end, text } — applied right-to-left so indices stay valid

  for (const m of markdown.matchAll(LINK_PATTERN)) {
    const { url, form, text } = classifyMatch(m);

    if (form === 'image') continue; // never archive an image embed
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
    if (url.includes('web.archive.org/web/')) continue; // already archived
    if (isSkipped(url)) continue; // declared live (frontmatter liveUrls)
    if (domains.length > 0) {
      const host = new URL(url).hostname;
      if (!domains.some(d => host === d || host.endsWith('.' + d))) continue;
    }

    const waybackUrl = await waybackify(url, { wayback });
    if (!waybackUrl || waybackUrl === url) continue; // no archive → leave the live link

    replacements.push({
      original: m[0],
      url,
      waybackUrl,
      linkText: text,
      isReference: form === 'reference',
      isHtml: form === 'html',
      isBare: form === 'bare'
    });

    // Rebuild the matched span with only its URL swapped — preserves brackets,
    // attributes, indentation, and any trailing title.
    if (!dryRun) {
      const at = m[0].indexOf(url);
      const newText = m[0].slice(0, at) + waybackUrl + m[0].slice(at + url.length);
      edits.push({ start: m.index, end: m.index + m[0].length, text: newText });
    }
  }

  let content = markdown;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    content = content.slice(0, e.start) + e.text + content.slice(e.end);
  }

  return { content, replacements };
}

export { WaybackMachine };
export { auditCapture, parseWaybackUrl, stripWaybackChrome, classifyReplayHtml } from './audit.js';
export default waybackify;