// The GitHub root probe: a github.com deep-link 404 is not evidence of
// gone.
//
// GitHub implements its rename redirect per route type, and the coverage is
// uneven. Under an old owner/name, `/commit/<sha>`, `/pull/<n>`, `/blob/…`, and
// the `/issues` listing 301 to the new name, but `/issues/<n>` 404s. The repo
// root itself always answers the rename. So before a caller classifies a deep
// link as gone, it asks the root:
//
//   1. GET https://github.com/<owner>/<repo>, the root with no path.
//   2. If the root redirects to another repo, graft the original path
//      verbatim onto the new owner/repo, and re-verify the grafted URL.
//   3. A grafted URL that answers is a rename: a rewrite candidate.
//   4. A conclusive reply leaves the 404 standing. The root answers 2xx
//      itself, the root or the grafted URL answers 404 or 410, or the root
//      redirects to the same repo. Only then can a caller record a terminal
//      verdict.
//
// Every other reply is inconclusive and THROWS. That covers a 403, a 408, a
// 429, a 5xx, a 3xx that is not a redirect, and a network error. It also
// covers a redirect off GitHub or without a Location, and a grafted URL that
// redirects out of the renamed repo. Thus no caller records a verdict on a
// guess, and the caller defers the link. Backfill (gone.jsonl) and manifest
// generation (the `exclude` verdict) share this one helper.

const ORIGIN = 'https://github.com';
const HOST_RE = /^(?:www\.)?github\.com$/;
const AUTHORITY_RE = /^https?:\/\/[^/?#]*/i;
// GitHub's own naming rules: an owner is alphanumerics, hyphens, and the
// underscore of an Enterprise Managed User (`name_shortcode`), a repo adds
// periods. Neither is ever `.` or `..`.
const OWNER_RE = /^[A-Za-z0-9_-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

/** True when `owner` and `repo` are names GitHub can issue. */
function validNames(owner, repo) {
  return OWNER_RE.test(owner) && !RESERVED_OWNERS.has(owner.toLowerCase()) && REPO_RE.test(repo);
}
// The first path segment of a github.com URL that is a GitHub route, not an
// owner. A closed list: `/orgs/x/people` or `/login/oauth` is not a repo.
const RESERVED_OWNERS = new Set([
  'about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact',
  'copilot', 'customer-stories', 'dashboard', 'discussions', 'enterprise',
  'events', 'explore', 'features', 'issues', 'join', 'login', 'logout',
  'marketplace', 'mobile', 'new', 'notifications', 'organizations', 'orgs',
  'pricing', 'pulls', 'readme', 'resources', 'search', 'security', 'sessions',
  'settings', 'signup', 'site', 'sponsors', 'stars', 'team', 'topics',
  'trending', 'users'
]);

/**
 * Split a deep github.com link into owner, repo, and the verbatim rest (path,
 * query, and fragment after the repo). The host matches in any letter case,
 * on its default port only. The archive spells many originals with an
 * explicit `:80`. A repo root, with or without a query or a fragment, a user
 * page, or any other host is not a deep link: null. Neither is a GitHub
 * route such as `/orgs/...` or `/login`. Nor is a path the URL parser spells
 * differently from the text. A `.` or `..` segment (literal or `%2e`), a
 * backslash, or a tab all resolve to another page. A fetch of such text is
 * not a fetch of the path as written.
 * @param {string} url
 * @returns {{ owner: string, repo: string, rest: string } | null}
 */
export function githubRepo(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // URL drops a default port and lowercases the host, so a non-empty port
  // is a port that is not the default.
  if (!/^https?:$/.test(parsed.protocol) || parsed.port !== '' || !HOST_RE.test(parsed.hostname)) return null;
  // The parsed pathname is what a fetch requests: `\` is `/`, a tab is gone,
  // and every dot segment is folded away. The text must already read that
  // way, so the verbatim rest resolves under a graft exactly as it does here.
  const afterHost = url.replace(AUTHORITY_RE, '');
  if (parsed.pathname !== afterHost.split(/[?#]/, 1)[0]) return null;
  const [, owner = '', repo = '', ...deeper] = parsed.pathname.split('/');
  if (!owner || !repo || !validNames(owner, repo)) return null;
  // A deep link names a path inside the repo. The root with only a trailing
  // slash, a query, or a fragment is the repo's home page, not a deep link.
  if (deeper.join('') === '') return null;
  return { owner, repo, rest: afterHost.slice(`/${owner}/${repo}`.length) };
}

/** True when two deep links name the same owner/repo, in any letter case. */
function sameRepo(a, b) {
  return `${a.owner}/${a.repo}`.toLowerCase() === `${b.owner}/${b.repo}`.toLowerCase();
}

/**
 * Graft the original path of a deep link verbatim onto another owner/repo.
 * @param {string} url - a deep github.com link (see githubRepo)
 * @param {string} owner
 * @param {string} repo
 * @returns {string}
 */
export function graftGithub(url, owner, repo) {
  return `${ORIGIN}/${owner}/${repo}${githubRepo(url).rest}`;
}

/**
 * The URL a redirect names when it stays on github.com, on its default port,
 * else null. The same host and port rule as githubRepo, so a hop to
 * `github.com:8443` is as foreign as a hop to another host.
 */
function onGithub(location, from) {
  let target;
  try {
    target = new URL(location, from);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(target.protocol) || target.port !== '') return null;
  return HOST_RE.test(target.hostname) ? target : null;
}

/** The owner/repo a root redirect names, or null when it names no repo. */
function redirectRepo(location, root) {
  const target = onGithub(location, root);
  if (!target) return null;
  const [, owner, repo] = target.pathname.split('/');
  return owner && repo && validNames(owner, repo) ? { owner, repo } : null;
}

/**
 * True when a redirect target on github.com is the root of `repo`, with or
 * without a trailing slash or a query. GitHub sends a disabled tab (a wiki,
 * an empty issues list) there, so the renamed repo answers for that path.
 */
function isRepoRoot(target, repo) {
  return target.pathname.replace(/\/$/, '').toLowerCase() === `/${repo.owner}/${repo.repo}`.toLowerCase();
}

/** A reply that proves the link is absent. */
function missing(status) {
  return status === 404 || status === 410;
}

/** An inconclusive reply: throw, so that the caller records nothing. */
function inconclusive(what, status, url) {
  return new Error(`github probe: inconclusive, ${what} returned HTTP ${status}: ${url}`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_GRAFT_HOPS = 5;

/**
 * Fetch the grafted URL and walk its redirects by hand, one hop at a time.
 * Every hop must stay inside the renamed repo: a deep link on github.com's
 * default port under the same owner/repo, or that repo's root. A
 * `redirect: 'follow'` fetch hides the chain. A login page that answers 200
 * then looks like a verdict about the graft, on another host or at
 * `github.com/login` alike. The walk keeps the final reply attributable to
 * the repo. A hop off GitHub, to a GitHub route, or to another repo is
 * inconclusive. So is a hop with no Location, a chain longer than
 * MAX_GRAFT_HOPS, and a grafted URL that resolves outside `target` before
 * the first fetch.
 * @param {Function} fetch
 * @param {string} to - the grafted URL
 * @param {{ owner: string, repo: string }} target - the renamed repo
 * @returns {Promise<boolean>} true when the grafted link answers 2xx
 * @throws on an inconclusive reply
 */
async function verifyGraft(fetch, to, target) {
  const graft = githubRepo(new URL(to).href);
  if (!graft || !sameRepo(graft, target)) {
    throw new Error(`github probe: inconclusive, grafted URL resolves outside the renamed repo: ${to}`);
  }
  let url = to;
  for (let hop = 0; hop <= MAX_GRAFT_HOPS; hop++) {
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 200 && res.status < 300) return true;
    if (missing(res.status)) return false;
    if (!REDIRECT_STATUSES.has(res.status)) throw inconclusive('grafted URL', res.status, url);
    const location = res.headers.get('location');
    if (!location) throw inconclusive('grafted URL redirect without a Location', res.status, url);
    const next = onGithub(location, url);
    if (!next) throw inconclusive('grafted URL redirect off GitHub', res.status, url);
    const hopRepo = githubRepo(next.href);
    const inRepo = hopRepo ? sameRepo(hopRepo, target) : isRepoRoot(next, target);
    if (!inRepo) throw inconclusive('grafted URL redirect out of the repo', res.status, url);
    // A fragment never goes on the wire, so the next request drops it.
    next.hash = '';
    url = next.href;
  }
  throw new Error(`github probe: inconclusive, grafted URL redirected more than ${MAX_GRAFT_HOPS} times: ${to}`);
}

/**
 * Probe the repo root of a deep github.com link (see the header).
 *
 * @param {string} url - the original (live) URL, never a replay URL
 * @param {Object} [options]
 * @param {Function} [options.fetch=globalThis.fetch] - fetch-like, injectable
 * @param {Function} [options.sleep] - the pause before the cold-root retry
 * @param {number} [options.retryMs=1000] - the cold-root retry delay
 * @returns {Promise<{ renamed: true, from: string, to: string } | { renamed: false } | null>}
 *   null when `url` is not a deep github.com link (no network happens)
 * @throws on an inconclusive reply (see the header) or a network error
 */
export async function probeGithub(url, options = {}) {
  const parsed = githubRepo(url);
  if (!parsed) return null;
  const { fetch = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), retryMs = 1000 } = options;
  const root = `${ORIGIN}/${parsed.owner}/${parsed.repo}`;

  // A repo-level rename lookup can be cold: one 404 earns one retry.
  let res = await fetch(root, { redirect: 'manual' });
  if (res.status === 404) {
    await sleep(retryMs);
    res = await fetch(root, { redirect: 'manual' });
  }
  if (missing(res.status) || (res.status >= 200 && res.status < 300)) return { renamed: false };
  // Only a real redirect with a Location can name a rename. A 304, a 3xx
  // with no Location, or any other status proves nothing about the repo.
  if (!REDIRECT_STATUSES.has(res.status)) throw inconclusive('root', res.status, root);
  const location = res.headers.get('location');
  if (!location) throw inconclusive('root redirect without a Location', res.status, root);

  const target = redirectRepo(location, root);
  if (!target) throw inconclusive('root redirect that names no repo', res.status, root);
  if (sameRepo(target, parsed)) return { renamed: false };

  const to = graftGithub(url, target.owner, target.repo);
  return (await verifyGraft(fetch, to, target)) ? { renamed: true, from: url, to } : { renamed: false };
}
