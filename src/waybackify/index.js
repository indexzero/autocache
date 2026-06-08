import { Impit } from 'impit';

/**
 * Internet Archive Wayback Machine API client.
 *
 * HTTP goes through `impit` (browser impersonation) rather than a plain client
 * — the Internet Archive throttles/blocks naive bulk clients, and impit's
 * real-browser TLS/HTTP fingerprint sustains the throughput a corpus-wide
 * re-import needs.
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
    this.impit = options.impit || new Impit({ browser: 'chrome', timeout: options.timeout ?? 20000 });
  }

  /**
   * Get an archived snapshot for a URL via the CDX index (earliest 200
   * capture). Retries transient failures (timeouts, non-200) with backoff;
   * a clean empty result is treated as "not archived" → null.
   * @param {string} url - The URL to find an archived version of
   * @returns {Promise<Object|null>} { url, timestamp, available } or null
   */
  async getSnapshot(url) {
    const api = new URL('https://web.archive.org/cdx/search/cdx');
    api.searchParams.set('url', url);
    api.searchParams.set('output', 'json');
    api.searchParams.set('limit', '1'); // one capture is enough to build a permalink
    api.searchParams.set('filter', 'statuscode:200');
    api.searchParams.set('fl', 'timestamp,original');

    let lastError;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1))); // 400/800/1600ms
      }
      try {
        const res = await this.impit.fetch(api.toString());
        if (res.status !== 200) {
          lastError = new Error(`HTTP ${res.status}`);
          continue; // transient — back off and retry
        }
        const rows = await res.json();
        // rows[0] is the header; a data row is [timestamp, original]. A clean
        // 200 with no data row is authoritative: the URL is NOT archived.
        if (Array.isArray(rows) && rows.length > 1) {
          const [ts, original] = rows[1];
          return {
            url: `https://web.archive.org/web/${ts}/${original}`,
            timestamp: ts,
            available: true
          };
        }
        return null;
      } catch (error) {
        lastError = error;
      }
    }
    // Every attempt failed transiently (timeout / non-200). Distinct from a
    // clean "not archived" (null): callers that cache results must NOT record
    // this as a negative — it should be retried later. So we throw.
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

    try {
      const response = await this.impit.fetch(apiUrl.toString());

      if (response.status !== 200) {
        return [];
      }

      const data = await response.json();

      // First row is headers, skip it
      if (data.length <= 1) {
        return [];
      }

      // Convert to objects with proper field names
      return data.slice(1).map(row => ({
        timestamp: row[1],
        url: row[2],
        mimetype: row[3],
        statuscode: row[4],
        digest: row[5],
        length: row[6],
        waybackUrl: `${this.baseUrl}/web/${row[1]}/${row[2]}`
      }));
    } catch (error) {
      console.error(`Error fetching snapshots for ${url}:`, error.message);
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
  // (the ledger builder) call getSnapshot directly and handle the throw.
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
//   4. bare URL in prose            http(s)://…        — whole match; lookbehind keeps it
//      from re-matching a URL already captured by a link form above.
const LINK_PATTERN =
  /(!?)\[([^\]]+)\]\(([^)\s]+)\)|^[ \t]*\[([^\]]+)\]:[ \t]*(\S+)|<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>|(?<![("/<\]])https?:\/\/[^\s)<>"'\]]+/gm;

/** Classify a regex match into {url, form, text} or null if it carries no URL. */
function classifyMatch(m) {
  if (m[3] !== undefined) return { url: m[3], form: m[1] === '!' ? 'image' : 'inline', text: m[2] };
  if (m[5] !== undefined) return { url: m[5], form: 'reference', text: m[4] };
  if (m[6] !== undefined) return { url: m[6], form: 'html', text: m[7] };
  return { url: m[0], form: 'bare', text: m[0] };
}

/**
 * Extract the unique external http(s) URLs from markdown that
 * waybackifyMarkdown would archive — inline / reference / HTML links and bare
 * prose URLs, in document order. PURE (no network): this is the detection half
 * of waybackifyMarkdown, for callers that resolve + cache separately (e.g. an
 * incremental ledger builder). Image embeds, internal/relative links,
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
 * Handles inline links, reference definitions, HTML anchors, and bare prose
 * URLs. Image embeds (`![alt](url)`) are left untouched — they're assets, not
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
export default waybackify;