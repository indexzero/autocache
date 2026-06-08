import { Agent, request } from 'undici';

// Custom Agent with extended timeouts for Internet Archive requests
const agentDefaults = {
  keepAliveTimeout: 10 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  connections: 128,
  headersTimeout: 5 * 60 * 1000,
  bodyTimeout: 10 * 60 * 1000
};

const agent = new Agent(agentDefaults);

/**
 * Internet Archive Wayback Machine API client
 */
class WaybackMachine {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'http://archive.org';
    this.agent = options.agent || agent;
  }

  /**
   * Get the closest archived snapshot for a URL
   * @param {string} url - The URL to find an archived version of
   * @param {string} [timestamp] - Optional timestamp (YYYYMMDDHHMMSS format)
   * @returns {Promise<Object|null>} Archive info or null if not found
   */
  async getSnapshot(url, timestamp) {
    const apiUrl = new URL('/wayback/available', this.baseUrl);
    apiUrl.searchParams.set('url', url);
    if (timestamp) {
      apiUrl.searchParams.set('timestamp', timestamp);
    }

    try {
      const response = await request(apiUrl.toString(), {
        method: 'GET',
        dispatcher: this.agent,
        headers: {
          'User-Agent': 'waybackify/0.0.0 (+https://github.com/indexzero/.online)'
        }
      });

      if (response.statusCode !== 200) {
        return null;
      }

      const data = await response.body.json();
      
      // Return the closest snapshot if available
      if (data.archived_snapshots && data.archived_snapshots.closest) {
        return {
          url: data.archived_snapshots.closest.url,
          timestamp: data.archived_snapshots.closest.timestamp,
          status: data.archived_snapshots.closest.status,
          available: data.archived_snapshots.closest.available
        };
      }

      return null;
    } catch (error) {
      console.error(`Error fetching snapshot for ${url}:`, error.message);
      return null;
    }
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
      const response = await request(apiUrl.toString(), {
        method: 'GET',
        dispatcher: this.agent,
        headers: {
          'User-Agent': 'waybackify/0.0.0 (+https://github.com/indexzero/.online)'
        }
      });

      if (response.statusCode !== 200) {
        return [];
      }

      const data = await response.body.json();
      
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
 * @param {string} [options.timestamp] - Preferred timestamp
 * @param {WaybackMachine} [options.wayback] - Custom wayback instance
 * @returns {Promise<string|null>} Wayback URL or null if not found
 */
export async function waybackify(url, options = {}) {
  const { timestamp, wayback = new WaybackMachine() } = options;
  
  // Skip if already a wayback URL
  if (url.includes('web.archive.org/web/')) {
    return url;
  }

  // Skip non-http URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return null;
  }

  const snapshot = await wayback.getSnapshot(url, timestamp);
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