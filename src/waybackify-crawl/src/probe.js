/**
 * The dynamic probe driver — `remaster verify --tier dynamic` as the crawl's
 * gauge (design §C2).
 *
 * `remaster verify`'s dynamic tier boots a strict server over a remastered root
 * and renders documents through the agent-browser CLI with the archive.org
 * family abort-routed, then classifies every request the page attempted. Crawl
 * DRIVES that engine — it does not reinvent it. Because a `spv/` package may
 * never import `render/wayback` (the decouple gate), and because the probe's
 * home MOVES into this package in T4 (where `remaster verify --tier dynamic`
 * lands under its §G name), the browser handling + request classifier live
 * HERE, ported faithfully from `render/wayback/src/rmfsck.ts`'s dynamic tier so
 * T4's re-home is import-path churn only. Two adaptations for the fixpoint:
 *
 *   1. the SERVER is supplied by the caller (crawl boots ONE localized,
 *      report-only `serveCacheRoot` and re-probes each iteration against it —
 *      the pre-localized hermetic root would leak held-but-foreign refs every
 *      iteration and never terminate, design §D3), and
 *   2. each classified request keeps its `resourceType`, so the mapper can
 *      infer a leaked child's replay flag (a browser-only fact absent from the
 *      URL).
 *
 * The request classifier is pure and browser-free (unit-tested with stubbed
 * records); the browser session is a subprocess behind this module.
 */

import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { parseWaybackPath } from '@charlie.dev/waybackify-serve/path';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------------ *
 * Pure request classification (ported verbatim in spirit from rmfsck.ts,
 * enriched with resourceType)
 * ------------------------------------------------------------------------ */

/**
 * @typedef {{ url: string, resourceType?: string, status?: number,
 *   failure?: string | null }} RequestRecord
 */

/**
 * Schemes that never reach a remote host — inert, safely skipped. Everything
 * NOT in this allowlist (notably `ws:`/`wss:`/`ftp:`) is egress-capable and is
 * classified like any other request so it can become a verification-blocking
 * residual (fail closed).
 */
const INERT_SCHEMES = new Set(['data:', 'blob:', 'about:', 'filesystem:', 'chrome:', 'chrome-extension:']);

/**
 * Classify one page's request log against the corpus key-set and our origin.
 *
 * A request is a leak when:
 *   - its origin is not our server's origin (`non-local` — an escape attempt,
 *     which the mapper later splits into missing-wayback vs true third-party), or
 *   - it is a local capture path (`/web/<ts>/…` or `/<ts>/…`) whose key is not
 *     in the corpus (`dangling-local` — observed ⊄ corpus).
 * A local NON-capture path (`/favicon.ico`, `/`) is browser noise: recorded,
 * never a leak (it 404s locally under strict serving and never escapes).
 *
 * @param {RequestRecord[]} records
 * @param {{ has(key: string): boolean }} corpus
 * @param {string} ourOrigin
 * @returns {{ requests: Array<{url: string, origin: 'local'|'non-local',
 *   corpus: 'hit'|'miss'|'n/a', resourceType?: string}>,
 *   dangling: Array<{url: string, resourceType?: string}>,
 *   nonLocal: Array<{url: string, resourceType?: string}> }}
 */
export function classifyRequests(records, corpus, ourOrigin) {
  const requests = [];
  const dangling = [];
  const nonLocal = [];
  for (const rec of records) {
    let origin;
    let pathname;
    try {
      const u = new URL(rec.url);
      // Skip only genuinely INERT schemes — these never touch a remote host.
      // Every OTHER non-http(s) scheme (ws:/wss:/ftp:/…) is egress-capable and
      // MUST be classified: a `wss://web.archive.org/…` connection is live
      // archive egress, so it fails through to the non-local escape path below
      // (fail closed) rather than being silently dropped.
      if (INERT_SCHEMES.has(u.protocol)) continue;
      origin = u.origin;
      pathname = u.pathname;
    } catch {
      continue; // truly unparseable noise
    }
    if (origin !== ourOrigin) {
      requests.push({ url: rec.url, origin: 'non-local', corpus: 'n/a', resourceType: rec.resourceType });
      nonLocal.push({ url: rec.url, resourceType: rec.resourceType });
      continue;
    }
    const parsed = parseWaybackPath(pathname);
    if (parsed === null) {
      requests.push({ url: rec.url, origin: 'local', corpus: 'n/a', resourceType: rec.resourceType });
      continue; // non-capture local path — browser noise
    }
    if (corpus.has(parsed.key)) {
      requests.push({ url: rec.url, origin: 'local', corpus: 'hit', resourceType: rec.resourceType });
    } else {
      requests.push({ url: rec.url, origin: 'local', corpus: 'miss', resourceType: rec.resourceType });
      dangling.push({ url: rec.url, resourceType: rec.resourceType });
    }
  }
  return { requests, dangling, nonLocal };
}

/** Recognize a CSP-violation line in a console / page-error message. */
export function isCspViolation(message) {
  return /content security policy|refused to (?:load|connect|execute|apply|frame)/i.test(message);
}

/** Is the agent-browser CLI on PATH and runnable? The probe gates on this. */
export function isBrowserAvailable(browserCmd = 'agent-browser') {
  const probe = spawnSync(browserCmd, ['--help'], { encoding: 'utf8', timeout: 15000 });
  return probe.error === undefined && probe.status === 0;
}

/* ------------------------------------------------------------------------ *
 * agent-browser subprocess handling (ported from rmfsck.ts)
 * ------------------------------------------------------------------------ */

/**
 * Run one agent-browser subcommand → its parsed stdout. `tolerant` swallows a
 * non-zero exit / timeout (a navigation that half-loads still leaves a request
 * log worth reading); otherwise a failure throws.
 */
async function browser(browserCmd, session, args, tolerant = false) {
  try {
    const { stdout } = await execFileAsync(browserCmd, ['--session', session, '--json', ...args], {
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024
    });
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  } catch (error) {
    if (!tolerant) throw new Error(`agent-browser ${args.join(' ')}: ${error.message}`);
    const stdout = error.stdout ?? '';
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }
}

/** agent-browser wraps results as `{ success, data }`; peel to the data. */
function unwrap(raw) {
  if (raw && typeof raw === 'object' && 'data' in raw) return raw.data;
  return raw;
}

/** Reduce an agent-browser `network requests` payload to RequestRecords. */
function normalizeRecords(data) {
  const list = Array.isArray(data) ? data : (data?.requests ?? []);
  const out = [];
  for (const item of list) {
    if (item && typeof item.url === 'string') {
      out.push({ url: item.url, resourceType: item.resourceType, status: item.status, failure: item.failure ?? null });
    }
  }
  return out;
}

/** Pull message strings out of a console/errors payload. */
function extractMessages(data) {
  const list = Array.isArray(data) ? data : (data?.messages ?? []);
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      if (typeof item.text === 'string') out.push(item.text);
      else if (typeof item.message === 'string') out.push(item.message);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * The injectable probe (crawl's deps.probe)
 * ------------------------------------------------------------------------ */

/**
 * A probe drives a browser against a caller-supplied strict server and returns,
 * per document, the classified leak lists. This factory produces the REAL,
 * agent-browser-backed probe; tests inject a fake with the same shape.
 *
 *   probe.available()                         → boolean
 *   await probe.open()                         launch the session, stage the
 *                                              archive.org abort routes BEFORE
 *                                              any navigation (a route
 *                                              registered post-launch/pre-nav is
 *                                              what actually intercepts — the
 *                                              archive family cannot phone home)
 *   await probe.render(serverUrl, docKey, corpus)
 *                                             → { pass, dangling, nonLocal,
 *                                                 csp, requests }
 *   await probe.close()                        teardown (idempotent, tolerant)
 *
 * @param {object} [opts]
 * @param {string} [opts.browserCmd='agent-browser']
 * @param {(line: string) => void} [opts.onProgress]
 * @param {number} [opts.settleMs=800] - post-navigate settle for late requisites.
 */
export function createBrowserProbe(opts = {}) {
  const browserCmd = opts.browserCmd ?? 'agent-browser';
  const onProgress = opts.onProgress ?? (() => {});
  const settleMs = opts.settleMs ?? 800;
  const session = `wbcrawl-${crypto.randomBytes(4).toString('hex')}`;
  let opened = false;

  return {
    available() {
      return isBrowserAvailable(browserCmd);
    },

    async open() {
      if (opened) return;
      await browser(browserCmd, session, ['open']); // launch, stay on about:blank
      // Abort anything bound for the archive.org family so a still-foreign
      // reference cannot actually escape while we measure the attempt (RAILS
      // §23: observe, never fetch, during probing).
      for (const pattern of ['**web.archive.org/**', '**archive.org/**']) {
        await browser(browserCmd, session, ['network', 'route', pattern, '--abort']);
      }
      opened = true;
    },

    async render(serverUrl, docKey, corpus) {
      if (!opened) await this.open();
      const url = `${serverUrl}/web/${docKey}`;
      onProgress(`probe: ${docKey}`);

      await browser(browserCmd, session, ['network', 'requests', '--clear'], true);
      await browser(browserCmd, session, ['console', '--clear'], true);
      await browser(browserCmd, session, ['errors', '--clear'], true);
      await browser(browserCmd, session, ['navigate', url], true); // half-loads still measured
      await browser(browserCmd, session, ['wait', String(settleMs)], true);

      const records = normalizeRecords(unwrap(await browser(browserCmd, session, ['network', 'requests'], true)));
      const messages = extractMessages(unwrap(await browser(browserCmd, session, ['console'], true))).concat(
        extractMessages(unwrap(await browser(browserCmd, session, ['errors'], true)))
      );

      const classified = classifyRequests(records, corpus, new URL(serverUrl).origin);
      const csp = messages.filter(isCspViolation).map(m => m.slice(0, 200));
      const pass = classified.dangling.length === 0 && classified.nonLocal.length === 0 && csp.length === 0;
      // `observed` is the RAW request count. A real render always issues at
      // least the top-level document request (a local hit), so `observed === 0`
      // means navigation or log-collection failed under the tolerant runner —
      // an EMPTY finding set that must NOT be mistaken for a clean render. The
      // fixpoint fails such a probe closed (never verifies on no evidence).
      return { pass, observed: records.length, dangling: classified.dangling, nonLocal: classified.nonLocal, csp, requests: classified.requests, url };
    },

    async close() {
      if (!opened) return;
      opened = false;
      try {
        await browser(browserCmd, session, ['close'], true);
      } catch {
        /* a failed close never fails the audit */
      }
    }
  };
}
