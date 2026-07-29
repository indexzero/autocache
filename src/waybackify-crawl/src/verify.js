/**
 * `remaster verify` — does the remastered tier STAND ALONE? (#365)
 *
 * The remaster family's validator, homed into the crawl package because its
 * dynamic tier drives the SAME strict-serving browser probe the crawler uses
 * (probe.js — reused verbatim, never re-implemented). Two tiers, read-only
 * throughout (verify never mutates a tree, a bucket, or the corpus — it reads
 * bytes and, for the dynamic tier, renders them):
 *
 *   STATIC  — walk every text-bearing body in a remastered tree and scan for
 *             `web.archive.org` / `archive.org` / absolute `http(s)://…/web/<ts>`
 *             escapes. ZERO allowlist, zero tolerance: capture bytes carry
 *             nothing of ours, so nothing is exempt (root-relative `/web/<ts>/…`
 *             refs are the CORRECT remastered form and are never findings).
 *             Plus the determinism check: every remastered body must hash to
 *             its build-record outputHash (a tampered served body is caught
 *             here), and — given the hermetic source — a fresh rebuild must
 *             reproduce the committed build record byte-for-byte (a stale
 *             build is caught here).
 *
 *   DYNAMIC — boot a STRICT-mode server over the remastered root (serveCacheRoot,
 *             ephemeral port) and render documents through the shared probe with
 *             non-local origins abort-routed so nothing actually escapes. A
 *             document passes iff it attempted zero non-local requests, raised
 *             zero CSP violations, and every local URL it requested resolves to
 *             a capture in the corpus (observed ⊆ corpus). The tier requires a
 *             browser: it is detected and skips cleanly when agent-browser is
 *             absent.
 *
 * Conventions match the family: report-only, exit 0 (pass) / 1 (findings) / 2
 * (usage) is the caller's job, `--json` is the machine form, the tool NEVER
 * writes a file unless given `--out`. The library is importable (the bin thin);
 * the request-classification core lives in probe.js (unit-tested there without
 * a browser).
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveCacheRoot } from '@charlie.dev/waybackify-serve/node';
import { BUILD_NAME, remaster } from '@charlie.dev/waybackify/remaster.js';
import { classifyContentType } from '@charlie.dev/waybackify/rewrite.js';
import { createBrowserProbe, isBrowserAvailable } from './probe.js';

/* ------------------------------------------------------------------------ *
 * Report shape (the family's LayerReport/Finding vocabulary)
 * ------------------------------------------------------------------------ */

/**
 * @typedef {'static' | 'dynamic'} Tier
 *
 * @typedef {Object} Finding
 * @property {Tier} tier
 * @property {string} layer   - which check surfaced it: `escape` | `build` | `browser`
 * @property {string} key     - the capture key (or a document key) at fault
 * @property {string} kind    - the defect class, e.g. `archive-org`, `body-hash`, `non-local-request`
 * @property {string} detail  - human one-liner
 * @property {number} [offset] - byte offset of an escape within the body
 * @property {string} [excerpt] - a sanitized window around an escape
 * @property {string} [expected]
 * @property {string} [actual]
 * @property {string} [url]   - dynamic tier: the offending request URL
 *
 * @typedef {Object} LayerReport
 * @property {Tier} tier
 * @property {string} layer
 * @property {string} name
 * @property {boolean} pass
 * @property {number} checked
 * @property {Finding[]} findings
 * @property {string} [skipped]
 * @property {Record<string, number>} [counts]
 * @property {DynamicDocResult[]} [documents]
 *
 * @typedef {Object} DynamicDocResult
 * @property {string} key
 * @property {string} url
 * @property {boolean} pass
 * @property {Array<{url: string, origin: 'local'|'non-local', corpus: 'hit'|'miss'|'n/a', resourceType?: string}>} requests
 * @property {Finding[]} findings
 *
 * @typedef {Object} RemasterVerifyReport
 * @property {'remaster-verify'} tool
 * @property {string} root
 * @property {string} [hermetic]
 * @property {boolean} pass
 * @property {LayerReport[]} layers
 *
 * @typedef {Object} RemasterVerifyOptions
 * @property {string} root
 * @property {string} [hermetic]
 * @property {Tier[]} [tiers]
 * @property {boolean} [skipDeterminism]
 * @property {number} [sample]
 * @property {(line: string) => void} [onProgress]
 * @property {string} [browserCmd]
 * @property {Function} [createProbe] - probe factory seam (tests inject a fake; default createBrowserProbe)
 */

/* ------------------------------------------------------------------------ *
 * Remastered-tree enumeration — the sidecar IS the entry (parity stance)
 * ------------------------------------------------------------------------ */

async function readdirOrEmpty(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Walk `<root>/meta/<aa>/*.json` in a stable order. */
export async function enumerateRemastered(root) {
  const metaDir = path.join(root, 'meta');
  const out = [];
  for (const aa of (await readdirOrEmpty(metaDir)).sort()) {
    for (const file of (await readdirOrEmpty(path.join(metaDir, aa))).sort()) {
      if (!file.endsWith('.json')) continue;
      const metaPath = path.join(metaDir, aa, file);
      const sidecar = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      const hash = file.slice(0, -'.json'.length);
      out.push({
        key: sidecar.key,
        aa,
        hash,
        status: sidecar.status,
        contentType: sidecar.contentType,
        contentHash: sidecar.contentHash,
        contentLength: sidecar.contentLength,
        capPath: path.join(root, 'cap', aa, hash),
        metaPath
      });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** SRI `sha256-<base64>` over bytes — the form the sidecar + build record use. */
function sri(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

/* ------------------------------------------------------------------------ *
 * STATIC · escape scan
 * ------------------------------------------------------------------------ */

// Any occurrence of the archive.org host family — `web.archive.org`,
// `web-static.archive.org`, or bare `archive.org`. One pattern subsumes them
// all; ZERO allowlist means every hit is a finding.
const ARCHIVE_ORG_RE = /archive\.org/gi;

// An ABSOLUTE wayback-shaped URL to a NON-archive host: `http(s)://host/web/<ts>`.
// The archive-host family is already covered above, so this catches a wayback
// path escaping through some other host. Root-relative `/web/<ts>/…` (no scheme
// + host) is the CORRECT remastered form and never matches here.
const ABSOLUTE_WEB_PATH_RE = /https?:\/\/[^\s"'<>)]+\/web\/\d{4,14}/gi;

/**
 * Is this content-type a text body a browser would parse for references? The
 * remaster engine only rewrites html/css/js, so those are the primary surface;
 * other text types (json/xml/svg) pass through hermetic-verbatim and can still
 * carry an escaping reference, so they are scanned too. Binary types (images,
 * fonts, octet-stream) are NOT scanned — a random byte run spelling
 * "archive.org" inside a PNG is a false positive, and capture bytes carry
 * nothing of ours.
 */
export function isTextBearing(contentType) {
  if (classifyContentType(contentType)) return true;
  const type = (contentType || '').split(';', 1)[0].trim().toLowerCase();
  return /^text\//.test(type) || type === 'application/json' || /\+xml$/.test(type) || type === 'application/xml';
}

/** A sanitized ±40-char window around `[start,end)` for a finding excerpt. */
function excerptAround(text, start, end) {
  const from = Math.max(0, start - 40);
  const to = Math.min(text.length, end + 40);
  const window = text.slice(from, to);
  // Collapse anything non-printable so the excerpt is a safe single line.
  return (from > 0 ? '…' : '') + window.replace(/[^\x20-\x7e]/g, '·') + (to < text.length ? '…' : '');
}

/**
 * Scan one text body for escapes. Pure: (key, text) → findings. Non-overlapping
 * by construction — the archive-host scan owns every `archive.org` hit, and the
 * absolute-web-path scan skips any match whose host is in that family.
 */
export function scanBody(key, text) {
  const findings = [];
  for (const m of text.matchAll(ARCHIVE_ORG_RE)) {
    findings.push({
      tier: 'static',
      layer: 'escape',
      key,
      kind: 'archive-org',
      detail: `archive.org reference at byte ${m.index}`,
      offset: m.index,
      excerpt: excerptAround(text, m.index, m.index + m[0].length)
    });
  }
  for (const m of text.matchAll(ABSOLUTE_WEB_PATH_RE)) {
    if (/archive\.org/i.test(m[0])) continue; // owned by the archive-host scan above
    findings.push({
      tier: 'static',
      layer: 'escape',
      key,
      kind: 'absolute-web-escape',
      detail: `absolute wayback-shaped URL at byte ${m.index}`,
      offset: m.index,
      excerpt: excerptAround(text, m.index, m.index + m[0].length)
    });
  }
  return findings;
}

/** Scan every text-bearing body in a remastered tree. */
export async function scanEscapes(entries) {
  const findings = [];
  let scanned = 0;
  for (const entry of entries) {
    if (entry.status !== 'body' || !isTextBearing(entry.contentType)) continue;
    let bytes;
    try {
      bytes = await fsp.readFile(entry.capPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        findings.push({ tier: 'static', layer: 'escape', key: entry.key, kind: 'body-missing', detail: `no cap/ body for a status:body sidecar` });
        continue;
      }
      throw error;
    }
    scanned++;
    // latin1 is a lossless byte↔char map, so byte offset === string index.
    findings.push(...scanBody(entry.key, bytes.toString('latin1')));
  }
  return {
    tier: 'static',
    layer: 'escape',
    name: 'archive-escape scan (zero allowlist)',
    pass: findings.length === 0,
    checked: scanned,
    findings,
    counts: { scanned }
  };
}

/* ------------------------------------------------------------------------ *
 * STATIC · determinism (build-record integrity + rebuild reproducibility)
 * ------------------------------------------------------------------------ */

/** Canonical JSON — byte-identical to what remaster.js / cache.js write. */
function canonicalJSON(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

async function readBuild(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, BUILD_NAME), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The determinism check. Two parts, both zero-tolerance:
 *   INTEGRITY     every remastered body hashes to its build-record outputHash
 *                 and its sidecar contentHash (a tampered served body is caught).
 *   REPRODUCIBLE  (given `hermetic`) a fresh rebuild reproduces the committed
 *                 build record byte-for-byte (a stale / drifted build is caught).
 *
 * @param {string} root
 * @param {Awaited<ReturnType<typeof enumerateRemastered>>} entries
 * @param {{ hermetic?: string, skipReproduce?: boolean, onProgress?: (line: string) => void }} [options]
 */
export async function checkDeterminism(root, entries, options = {}) {
  const findings = [];
  const build = await readBuild(root);
  if (build === null) {
    return {
      tier: 'static',
      layer: 'build',
      name: 'determinism (build-record integrity + rebuild)',
      pass: false,
      checked: 0,
      findings: [{ tier: 'static', layer: 'build', key: BUILD_NAME, kind: 'build-missing', detail: `no ${BUILD_NAME} at the remastered root` }]
    };
  }

  const byKey = new Map(build.entries.map(e => [e.key, e]));

  // INTEGRITY — every remastered body vs its build-record + sidecar hash.
  let verified = 0;
  for (const entry of entries) {
    if (entry.status !== 'body') continue;
    const row = byKey.get(entry.key);
    if (!row) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'build-orphan', detail: 'body present but absent from the build record' });
      continue;
    }
    let bytes;
    try {
      bytes = await fsp.readFile(entry.capPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'body-missing', detail: 'build record lists a body the tree lacks' });
        continue;
      }
      throw error;
    }
    const got = sri(bytes);
    verified++;
    if (row.outputHash !== got) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'body-hash', detail: 'body bytes diverge from the build record', expected: row.outputHash ?? '(none)', actual: got });
    }
    if (entry.contentHash !== got) {
      findings.push({ tier: 'static', layer: 'build', key: entry.key, kind: 'sidecar-hash', detail: 'sidecar contentHash diverges from the body', expected: entry.contentHash ?? '(none)', actual: got });
    }
  }

  // REPRODUCIBLE — rebuild from the hermetic source and compare build records.
  let reproduced = false;
  if (options.hermetic && !options.skipReproduce) {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'remaster-verify-rebuild-'));
    try {
      options.onProgress?.(`determinism: rebuilding from ${options.hermetic}`);
      const { build: rebuilt } = await remaster(options.hermetic, tmp);
      reproduced = true;
      if (rebuilt.engineVersion !== build.engineVersion) findings.push(driftFinding('engineVersion', String(build.engineVersion), String(rebuilt.engineVersion)));
      if (rebuilt.ruleVersion !== build.ruleVersion) findings.push(driftFinding('ruleVersion', String(build.ruleVersion), String(rebuilt.ruleVersion)));
      if (rebuilt.v !== build.v) findings.push(driftFinding('buildVersion', String(build.v), String(rebuilt.v)));
      const rebuiltByKey = new Map(rebuilt.entries.map(e => [e.key, e]));
      for (const [key, row] of byKey) {
        const other = rebuiltByKey.get(key);
        if (!other) {
          findings.push({ tier: 'static', layer: 'build', key, kind: 'rebuild-drift', detail: 'entry present in the committed build record, absent from a fresh rebuild', expected: 'present', actual: 'absent' });
          continue;
        }
        if (canonicalJSON(row) !== canonicalJSON(other)) {
          findings.push({ tier: 'static', layer: 'build', key, kind: 'rebuild-drift', detail: 'build-record entry differs from a fresh rebuild', expected: canonicalJSON(row), actual: canonicalJSON(other) });
        }
      }
      for (const key of rebuiltByKey.keys()) {
        if (!byKey.has(key)) findings.push({ tier: 'static', layer: 'build', key, kind: 'rebuild-drift', detail: 'entry produced by a fresh rebuild, absent from the committed build record', expected: 'absent', actual: 'present' });
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  return {
    tier: 'static',
    layer: 'build',
    name: 'determinism (build-record integrity + rebuild)',
    pass: findings.length === 0,
    checked: verified,
    findings,
    ...(options.hermetic && !options.skipReproduce ? {} : { skipped: 'reproducibility skipped (no --hermetic or --no-determinism)' }),
    counts: { verified, entries: build.entries.length, reproduced: reproduced ? 1 : 0 }
  };
}

function driftFinding(field, expected, actual) {
  return { tier: 'static', layer: 'build', key: `(build.${field})`, kind: 'rebuild-drift', detail: `build-record ${field} differs from a fresh rebuild`, expected, actual };
}

/* ------------------------------------------------------------------------ *
 * DYNAMIC · strict-serving browser sweep (reuses probe.js)
 * ------------------------------------------------------------------------ */

/**
 * Render the remastered HTML documents through the shared browser probe against
 * a strict server this function boots. Requires agent-browser; the caller gates
 * on isBrowserAvailable and this throws (via the probe) if invoked without one.
 *
 * @param {string} root
 * @param {RemasterVerifyOptions} options
 * @returns {Promise<LayerReport>}
 */
export async function runDynamic(root, options) {
  const entries = await enumerateRemastered(root);
  const corpus = new Set(entries.map(e => e.key));
  let docs = entries.filter(e => e.status === 'body' && classifyContentType(e.contentType) === 'html');
  if (options.sample !== undefined) docs = docs.slice(0, options.sample);

  const server = await serveCacheRoot({ root });
  // The probe factory is injectable (deps.createProbe) so this loop's
  // fail-closed handling is unit-testable without a real browser; the bin wires
  // the default createBrowserProbe.
  const probe = (options.createProbe ?? createBrowserProbe)({ browserCmd: options.browserCmd, onProgress: options.onProgress });
  const documents = [];
  const findings = [];

  try {
    await probe.open();
    for (const doc of docs) {
      const result = await probe.render(server.url, doc.key, corpus);
      const docFindings = [];
      // A real render always issues at least the top-level document request, so
      // `observed === 0` is not a clean pass — it means navigation or
      // log-collection failed under the tolerant runner (probe.js ~line 241).
      // Fail closed: an empty finding set on no evidence must NOT verify.
      if (result.observed === 0) {
        docFindings.push({
          tier: 'dynamic',
          layer: 'browser',
          key: doc.key,
          kind: 'no-evidence',
          detail: 'browser render produced zero requests — navigation or log collection failed; failing closed'
        });
      }
      for (const req of result.nonLocal) {
        docFindings.push({ tier: 'dynamic', layer: 'browser', key: doc.key, kind: 'non-local-request', detail: 'attempted a request to a non-local origin', url: req.url });
      }
      for (const req of result.dangling) {
        docFindings.push({ tier: 'dynamic', layer: 'browser', key: doc.key, kind: 'dangling-local', detail: 'local capture path not in the corpus', url: req.url });
      }
      for (const msg of result.csp) {
        docFindings.push({ tier: 'dynamic', layer: 'browser', key: doc.key, kind: 'csp-violation', detail: msg.slice(0, 200) });
      }
      documents.push({ key: doc.key, url: result.url, pass: docFindings.length === 0, requests: result.requests, findings: docFindings });
      findings.push(...docFindings);
    }
  } finally {
    try {
      await probe.close();
    } catch {
      /* a failed close never fails the audit */
    }
    await new Promise((resolve, reject) => server.server.close(err => (err ? reject(err) : resolve())));
  }

  return {
    tier: 'dynamic',
    layer: 'browser',
    name: 'strict-serving browser sweep',
    pass: findings.length === 0,
    checked: documents.length,
    findings,
    counts: { documents: documents.length, htmlTotal: entries.filter(e => classifyContentType(e.contentType) === 'html').length },
    documents
  };
}

/* ------------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------------ */

/**
 * Run the requested tiers over a remastered root and return the full report.
 *
 * @param {RemasterVerifyOptions} options
 * @returns {Promise<RemasterVerifyReport>}
 */
export async function runRemasterVerify(options) {
  const tiers = options.tiers ?? ['static'];
  const layers = [];

  if (tiers.includes('static')) {
    const entries = await enumerateRemastered(options.root);
    layers.push(await scanEscapes(entries));
    layers.push(await checkDeterminism(options.root, entries, { hermetic: options.hermetic, skipReproduce: options.skipDeterminism, onProgress: options.onProgress }));
  }

  if (tiers.includes('dynamic')) {
    if (!isBrowserAvailable(options.browserCmd)) {
      layers.push({ tier: 'dynamic', layer: 'browser', name: 'strict-serving browser sweep', pass: true, checked: 0, findings: [], skipped: 'agent-browser not found on PATH' });
    } else {
      layers.push(await runDynamic(options.root, options));
    }
  }

  return {
    tool: 'remaster-verify',
    root: options.root,
    ...(options.hermetic ? { hermetic: options.hermetic } : {}),
    pass: layers.every(l => l.pass),
    layers
  };
}

/**
 * Render a report as a human summary: one line per layer + the first `firstK`
 * findings under each. The `--json` output is the machine form; this is the
 * terminal form.
 *
 * @param {RemasterVerifyReport} report
 * @param {number} [firstK]
 */
export function formatReport(report, firstK = 10) {
  const lines = [];
  lines.push(`remaster verify: ${report.root}${report.hermetic ? ` (hermetic ${report.hermetic})` : ''}`);
  lines.push(`  ${report.pass ? 'PASS' : 'FAIL'}`);
  for (const layer of report.layers) {
    const counts = layer.counts ? ` [${Object.entries(layer.counts).map(([k, v]) => `${k}=${v}`).join(' ')}]` : '';
    const verdict = layer.skipped && layer.findings.length === 0 && layer.pass && layer.checked === 0 ? 'SKIP' : layer.pass ? 'PASS' : `FAIL (${layer.findings.length})`;
    lines.push(`  ${layer.tier}/${layer.layer} — ${layer.name}: ${verdict} · ${layer.checked} checked${counts}`);
    if (layer.skipped) lines.push(`      note: ${layer.skipped}`);
    for (const f of layer.findings.slice(0, firstK)) {
      const loc = f.offset !== undefined ? ` @${f.offset}` : f.url ? ` ${f.url}` : '';
      const cmp = f.expected !== undefined ? ` (expected ${f.expected}, got ${f.actual})` : '';
      lines.push(`      ${f.kind} · ${f.key}${loc}: ${f.detail}${cmp}`);
      if (f.excerpt) lines.push(`        ${f.excerpt}`);
    }
    if (layer.findings.length > firstK) lines.push(`      … and ${layer.findings.length - firstK} more`);
  }
  return lines.join('\n');
}
