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
//   4. A conclusive reply leaves the 404 standing: a root that answers 2xx
//      itself, a root or a grafted URL that answers 404 or 410, or a redirect
//      to the same repo. Only then can a caller record a terminal verdict.
//
// Every other reply is inconclusive and THROWS: a 403, a 408, a 429, a 5xx, a
// redirect off GitHub, or a network error. Thus no caller records a verdict
// on a guess, and the caller defers the link. Backfill (gone.jsonl) and manifest generation
// (the `exclude` verdict) share this one helper.

const ORIGIN = 'https://github.com';
const HOST_RE = /^(?:www\.)?github\.com$/;
const AUTHORITY_RE = /^https?:\/\/[^/?#]*/i;
const PATH_RE = /^\/([^/?#]+)\/([^/?#]+)([/?#].*)$/;

/**
 * Split a deep github.com link into owner, repo, and the verbatim rest (path,
 * query, and fragment after the repo). The host matches in any letter case,
 * on its default port only. The archive spells many originals with an
 * explicit `:80`. A repo root, a user page, or any other host is not a deep
 * link: null.
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
  const m = PATH_RE.exec(url.replace(AUTHORITY_RE, ''));
  if (!m || m[3] === '/') return null;
  return { owner: m[1], repo: m[2], rest: m[3] };
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

/** The owner/repo a root redirect names, or null when it names no repo. */
function redirectRepo(location, root) {
  let target;
  try {
    target = new URL(location, root);
  } catch {
    return null;
  }
  if (!/^(?:www\.)?github\.com$/i.test(target.hostname)) return null;
  const [, owner, repo] = target.pathname.split('/');
  return owner && repo ? { owner, repo } : null;
}

/** A reply that proves the link is absent. */
function missing(status) {
  return status === 404 || status === 410;
}

/** An inconclusive reply: throw, so that the caller records nothing. */
function inconclusive(what, status, url) {
  return new Error(`github probe: inconclusive, ${what} returned HTTP ${status}: ${url}`);
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
  if (res.status < 300 || res.status >= 400) throw inconclusive('root', res.status, root);

  const target = redirectRepo(res.headers.get('location') ?? '', root);
  if (!target) throw inconclusive('root redirect off GitHub', res.status, root);
  if (`${target.owner}/${target.repo}`.toLowerCase() === `${parsed.owner}/${parsed.repo}`.toLowerCase()) {
    return { renamed: false };
  }

  const to = graftGithub(url, target.owner, target.repo);
  const check = await fetch(to, { redirect: 'follow' });
  if (check.ok) return { renamed: true, from: url, to };
  if (missing(check.status)) return { renamed: false };
  throw inconclusive('grafted URL', check.status, to);
}
