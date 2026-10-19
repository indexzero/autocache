// node --test — the GitHub root probe, driven by a scripted fetch.
// A GitHub deep-link 404 is not evidence of gone: the probe asks the repo
// root, grafts the original path onto a rename target, and re-verifies.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubRepo, graftGithub, probeGithub } from '../github.js';

const OLD = 'https://github.com/old-owner/old-repo';
const NEW = 'https://github.com/new-owner/new-repo';
const DEEP = `${OLD}/commit/0123456789abcdef0123456789abcdef01234567`;
const GRAFTED = `${NEW}/commit/0123456789abcdef0123456789abcdef01234567`;

/** A fetch whose reply per URL comes from `script` (status, optional location). */
function scriptedFetch(script) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, redirect: init.redirect });
    const queue = script[url];
    if (queue === undefined) throw new Error(`unscripted fetch: ${url}`);
    const reply = Array.isArray(queue) ? queue.shift() : queue;
    if (reply instanceof Error) throw reply;
    const headers = new Headers(reply.location ? { location: reply.location } : {});
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers };
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

describe('githubRepo: which URLs the probe applies to', () => {
  it('parses a deep github.com link into owner, repo, and the verbatim rest', () => {
    assert.deepEqual(githubRepo(`${DEEP}?w=1#L3`), {
      owner: 'old-owner',
      repo: 'old-repo',
      rest: '/commit/0123456789abcdef0123456789abcdef01234567?w=1#L3'
    });
    assert.equal(githubRepo('http://www.github.com/a/b/issues/1').rest, '/issues/1');
  });

  it('accepts github.com on its default port, in any letter case', () => {
    // The archive spells many originals of that era with an explicit :80.
    assert.deepEqual(githubRepo('http://github.com:80/example/legacy-settings/tree/master'), {
      owner: 'example',
      repo: 'legacy-settings',
      rest: '/tree/master'
    });
    assert.equal(githubRepo('http://github.com:80/example/legacy-templates/tree/master').repo, 'legacy-templates');
    assert.equal(githubRepo('https://github.com:443/a/b/issues/1').rest, '/issues/1');
    assert.equal(githubRepo('HTTP://GitHub.COM/a/b/pull/2').rest, '/pull/2');
    assert.equal(graftGithub('http://github.com:80/a/b/tree/master', 'c', 'd'), 'https://github.com/c/d/tree/master');
  });

  it('rejects github.com on a port that is not the default', () => {
    assert.equal(githubRepo('https://github.com:80/a/b/issues/1'), null);
    assert.equal(githubRepo('http://github.com:8080/a/b/issues/1'), null);
  });

  it('returns null for a repo root, a user page, and other hosts', () => {
    assert.equal(githubRepo(OLD), null);
    assert.equal(githubRepo(`${OLD}/`), null);
    assert.equal(githubRepo('https://github.com/old-owner'), null);
    assert.equal(githubRepo('https://gist.github.com/a/b/c'), null);
    assert.equal(githubRepo('https://example.com/a/b/c'), null);
  });

  it('returns null for a GitHub route whose first segment is not an owner', () => {
    assert.equal(githubRepo('https://github.com/orgs/old-owner/people'), null);
    assert.equal(githubRepo('https://github.com/login/oauth/authorize?x=1'), null);
    assert.equal(githubRepo('https://github.com/settings/profile/x'), null);
    assert.equal(githubRepo('https://github.com/ORGS/old-owner/people'), null);
    assert.equal(githubRepo('https://github.com/users/old-owner/followers'), null);
  });

  it('returns null for a path with a dot segment, which a fetch resolves elsewhere', () => {
    assert.equal(githubRepo('https://github.com/../old-owner/old-repo/issues/1'), null);
    assert.equal(githubRepo('https://github.com/old-owner/../old-repo/issues/1'), null);
    assert.equal(githubRepo(`${OLD}/../../login`), null);
    assert.equal(githubRepo(`${OLD}/./issues/1`), null);
    assert.equal(githubRepo(`${OLD}/x/../../old-repo/y`), null, 'a path that pops out and back in is not the text as written');
    assert.equal(githubRepo(`${OLD}/issues/1?next=../x`).rest, '/issues/1?next=../x', 'a dot in the query is not a segment');
    assert.equal(githubRepo('https://github.com/old-owner/old.repo.js/issues/1').repo, 'old.repo.js');
  });

  it('returns null for a dot segment the parser spells another way: percent-encoded, backslash, or tab', () => {
    assert.equal(githubRepo(`${OLD}/%2e%2e/%2E%2E/login`), null);
    assert.equal(githubRepo(`${OLD}/issues/%2e./x`), null);
    assert.equal(githubRepo(`${OLD}/issues/.%2E/x`), null);
    assert.equal(githubRepo(`${OLD}/issues\\..\\..\\login`), null, 'a backslash is a slash to the URL parser');
    assert.equal(githubRepo(`${OLD}/issues\\x`), null);
    assert.equal(githubRepo(`${OLD}/issues/.\t./.\t./login`), null, 'a tab vanishes under the URL parser');
    assert.equal(githubRepo(`${OLD}/a b/c`), null, 'a character the parser must encode is not the text as written');
    assert.equal(githubRepo(`${OLD}/caf%C3%A9/x`).rest, '/caf%C3%A9/x', 'an already-encoded path reads as written');
  });

  it('returns null for an owner or repo outside GitHub naming', () => {
    assert.equal(githubRepo('https://github.com/old%20owner/old-repo/issues/1'), null);
    assert.equal(githubRepo('https://github.com/old_owner/old-repo/issues/1'), null);
    assert.equal(githubRepo('https://github.com/old-owner/old%2Frepo/issues/1'), null);
    assert.equal(githubRepo('https://github.com/old-owner/old_repo/issues/1').repo, 'old_repo');
  });
});

describe('graftGithub', () => {
  it('grafts the original path verbatim onto the new owner and repo', () => {
    assert.equal(graftGithub(`${DEEP}#L3`, 'new-owner', 'new-repo'), `${GRAFTED}#L3`);
  });
});

describe('probeGithub: the repo-root probe', () => {
  it('a rename redirect plus a grafted URL that answers is a rewrite candidate', async () => {
    const fetch = scriptedFetch({
      [OLD]: { status: 301, location: NEW },
      [GRAFTED]: { status: 200 }
    });
    assert.deepEqual(await probeGithub(DEEP, { fetch, sleep: noSleep }), { renamed: true, from: DEEP, to: GRAFTED });
    assert.equal(fetch.calls[0].redirect, 'manual', 'the root probe reads the redirect itself');
  });

  it('rescues the /issues/:number hole: the root redirect drives the graft', async () => {
    const issue = `${OLD}/issues/1`;
    const fetch = scriptedFetch({
      [OLD]: { status: 301, location: '/new-owner/new-repo' },
      [`${NEW}/issues/1`]: { status: 200 }
    });
    assert.deepEqual(await probeGithub(issue, { fetch, sleep: noSleep }), { renamed: true, from: issue, to: `${NEW}/issues/1` });
  });

  it('a root that answers itself is no rename: the 404 survives the probe', async () => {
    const fetch = scriptedFetch({ [OLD]: { status: 200 } });
    assert.deepEqual(await probeGithub(DEEP, { fetch, sleep: noSleep }), { renamed: false });
  });

  it('a grafted URL that 404s too is no rename', async () => {
    const fetch = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status: 404 } });
    assert.deepEqual(await probeGithub(DEEP, { fetch, sleep: noSleep }), { renamed: false });
  });

  it('a redirect that names no other repo is no rename', async () => {
    const caseOnly = scriptedFetch({ [OLD]: { status: 301, location: 'https://github.com/Old-Owner/Old-Repo' } });
    assert.deepEqual(await probeGithub(DEEP, { fetch: caseOnly, sleep: noSleep }), { renamed: false });
  });

  it('a redirect off GitHub is inconclusive, so it throws', async () => {
    const away = scriptedFetch({ [OLD]: { status: 302, location: 'https://example.com/login' } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: away, sleep: noSleep }), /inconclusive.*names no repo/);
    const login = scriptedFetch({ [OLD]: { status: 302, location: '/login?return_to=%2Fold-owner%2Fold-repo' } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: login, sleep: noSleep }), /inconclusive.*names no repo/);
  });

  it('a root 3xx without a Location is inconclusive, so it throws', async () => {
    const bare = scriptedFetch({ [OLD]: { status: 302 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: bare, sleep: noSleep }), /root redirect without a Location.*HTTP 302/);
    const empty = scriptedFetch({ [OLD]: { status: 301, location: '' } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: empty, sleep: noSleep }), /root redirect without a Location.*HTTP 301/);
    assert.equal(bare.calls.length, 1, 'no graft is attempted');
  });

  it('a root 304 is not a redirect: inconclusive, so it throws', async () => {
    const notModified = scriptedFetch({ [OLD]: { status: 304 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: notModified, sleep: noSleep }), /root returned HTTP 304/);
  });

  for (const status of [200, 404]) {
    it(`a grafted URL that redirects off GitHub is inconclusive, even when the other host answers ${status}`, async () => {
      const login = 'https://elsewhere.example/login';
      const fetch = scriptedFetch({
        [OLD]: { status: 301, location: NEW },
        [GRAFTED]: { status: 302, location: login },
        [login]: { status }
      });
      await assert.rejects(() => probeGithub(DEEP, { fetch, sleep: noSleep }), /grafted URL redirect off GitHub/);
      assert.ok(!fetch.calls.some(c => c.url === login), 'the probe never leaves github.com');
      assert.equal(fetch.calls.at(-1).redirect, 'manual', 'the graft walk reads each redirect itself');
    });
  }

  it('a grafted URL that redirects within GitHub is followed, and the rename keeps the grafted URL', async () => {
    const moved = `${NEW}/commit/0123456789abcdef0123456789abcdef01234567?moved=1`;
    const fetch = scriptedFetch({
      [OLD]: { status: 301, location: NEW },
      [GRAFTED]: { status: 301, location: moved },
      [moved]: { status: 200 }
    });
    assert.deepEqual(await probeGithub(DEEP, { fetch, sleep: noSleep }), { renamed: true, from: DEEP, to: GRAFTED });
  });

  it('a grafted URL that redirects to a GitHub route is inconclusive, even when the route answers 200', async () => {
    const login = 'https://github.com/login?return_to=%2Fnew-owner%2Fnew-repo';
    const fetch = scriptedFetch({
      [OLD]: { status: 301, location: NEW },
      [GRAFTED]: { status: 302, location: '/login?return_to=%2Fnew-owner%2Fnew-repo' },
      [login]: { status: 200 }
    });
    await assert.rejects(() => probeGithub(DEEP, { fetch, sleep: noSleep }), /grafted URL redirect out of the repo/);
    assert.ok(!fetch.calls.some(c => c.url === login), 'the probe never fetches the login page');
  });

  it('a grafted URL that redirects to the repo root or to another repo is inconclusive', async () => {
    const root = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status: 302, location: NEW }, [NEW]: { status: 200 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: root, sleep: noSleep }), /grafted URL redirect out of the repo/);
    assert.equal(root.calls.length, 2, 'the root of the renamed repo is never fetched as the graft');
    const other = `https://github.com/third-owner/third-repo${githubRepo(DEEP).rest}`;
    const moved = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status: 301, location: other }, [other]: { status: 200 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: moved, sleep: noSleep }), /grafted URL redirect out of the repo/);
  });

  it('a redirect to github.com on a port that is not the default is off GitHub', async () => {
    const graft = scriptedFetch({
      [OLD]: { status: 301, location: NEW },
      [GRAFTED]: { status: 302, location: GRAFTED.replace('github.com', 'github.com:8443') }
    });
    await assert.rejects(() => probeGithub(DEEP, { fetch: graft, sleep: noSleep }), /grafted URL redirect off GitHub/);
    assert.equal(graft.calls.length, 2, 'the probe never fetches the other port');
    const root = scriptedFetch({ [OLD]: { status: 301, location: NEW.replace('github.com', 'github.com:8443') } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: root, sleep: noSleep }), /inconclusive.*names no repo/);
    const defaultPort = scriptedFetch({ [OLD]: { status: 301, location: NEW.replace('github.com', 'github.com:443') }, [GRAFTED]: { status: 200 } });
    assert.deepEqual(await probeGithub(DEEP, { fetch: defaultPort, sleep: noSleep }), { renamed: true, from: DEEP, to: GRAFTED });
  });

  it('a root redirect to a GitHub route names no repo', async () => {
    const orgs = scriptedFetch({ [OLD]: { status: 301, location: '/orgs/new-owner/repositories' } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: orgs, sleep: noSleep }), /inconclusive.*names no repo/);
    const dots = scriptedFetch({ [OLD]: { status: 301, location: 'https://github.com/new-owner/..' } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: dots, sleep: noSleep }), /inconclusive.*names no repo/);
  });

  it('a grafted URL redirect without a Location, or a redirect loop, is inconclusive', async () => {
    const bare = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status: 302 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: bare, sleep: noSleep }), /without a Location/);
    const loop = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status: 302, location: GRAFTED } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: loop, sleep: noSleep }), /redirected more than/);
  });

  for (const status of [403, 408]) {
    it(`a ${status} at the root or at the graft is inconclusive, so it throws`, async () => {
      const root = scriptedFetch({ [OLD]: { status } });
      await assert.rejects(() => probeGithub(DEEP, { fetch: root, sleep: noSleep }), new RegExp(`HTTP ${status}`));
      const graft = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status } });
      await assert.rejects(() => probeGithub(DEEP, { fetch: graft, sleep: noSleep }), new RegExp(`HTTP ${status}`));
    });
  }

  it('retries a cold root 404 once before it counts', async () => {
    const fetch = scriptedFetch({
      [OLD]: [{ status: 404 }, { status: 301, location: NEW }],
      [GRAFTED]: { status: 200 }
    });
    assert.equal((await probeGithub(DEEP, { fetch, sleep: noSleep })).renamed, true);
    const fetch2 = scriptedFetch({ [OLD]: [{ status: 404 }, { status: 404 }] });
    assert.deepEqual(await probeGithub(DEEP, { fetch: fetch2, sleep: noSleep }), { renamed: false });
    assert.equal(fetch2.calls.length, 2);
  });

  it('throws on a transient reply, so no caller records a verdict', async () => {
    const busy = scriptedFetch({ [OLD]: { status: 503 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: busy, sleep: noSleep }), /HTTP 503/);
    const down = scriptedFetch({ [OLD]: new Error('fetch failed') });
    await assert.rejects(() => probeGithub(DEEP, { fetch: down, sleep: noSleep }), /fetch failed/);
    const graftBusy = scriptedFetch({ [OLD]: { status: 301, location: NEW }, [GRAFTED]: { status: 429 } });
    await assert.rejects(() => probeGithub(DEEP, { fetch: graftBusy, sleep: noSleep }), /HTTP 429/);
  });

  it('a path that escapes the repo through a backslash never reaches the network', async () => {
    const escape = `${OLD}/issues\\..\\..\\login`;
    const fetch = scriptedFetch({
      [OLD]: { status: 301, location: NEW },
      'https://github.com/new-owner/login': { status: 200 }
    });
    assert.equal(await probeGithub(escape, { fetch, sleep: noSleep }), null);
    assert.equal(fetch.calls.length, 0);
    const tab = `${OLD}/a/b/.\t./.\t./login`;
    assert.equal(await probeGithub(tab, { fetch, sleep: noSleep }), null);
    assert.equal(fetch.calls.length, 0);
  });

  it('returns null without network for a URL that is not a deep GitHub link', async () => {
    const fetch = scriptedFetch({});
    assert.equal(await probeGithub('https://example.com/a/b/c', { fetch }), null);
    assert.equal(fetch.calls.length, 0);
  });
});
