// `waybackify audit <dir>` handler — a generic, checkpointed wayback-404 audit
// (Q-T4-C). The captures to audit are discovered via generic ledger discovery
// of <dir> (waybackify/ledger.js — the same corpus-agnostic frontier `cache
// fill` uses): every capture the union manifest references, deduped by capture
// key. The old corpus-aware inline-markdown walk + post attribution are DROPPED
// (corpus-specific — the series layer supplies the content tree). The
// checkpointed verdict loop lives in src/audit-engine.js.
//
// Slow, network-heavy, HUMAN-SUPERVISED: archive.org takes 25–60s per request
// when it's grumpy. The command REFUSES to run under CI (the checkpoint is a
// local artifact, never committed).
//
// Library members are imported by workspace specifier and lazily inside the
// runner; a test injects `deps.auditCapture` + `deps.WaybackMachine` (and
// `deps.env` to bypass the CI guard) to exercise the wiring offline over a tiny
// ledger fixture.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../cli.js';

/** Print the verdict summary (counts + the captures needing a human pass). */
function printSummary(result, log) {
  const { counts, bad } = result.summary;
  log('');
  log(`— audit summary: ${result.audited} audited this scope (${result.total} unique captures in the ledger) —`);
  log(`  good:       ${counts.good}`);
  log(`  wayback404: ${counts.wayback404}`);
  log(`  suspect:    ${counts.suspect}`);
  if (bad.length > 0) {
    log('');
    log('— captures needing a human pass —');
    for (const v of bad) {
      log(`  [${v.verdict}] ${v.url}`);
      log(`    statuscode: ${v.statuscode ?? '(none)'} | reason: ${v.reason}`);
      // Interstitial captures (#363/#431) carry a precise signature; redirect
      // interstitials also carry the decoded destination the re-point pass needs.
      // Ported from render/wayback/bin/audit-corpus.js's printer (#431), retired
      // when the bin moved here — `auditCapture` still emits these fields.
      if (v.signature) log(`    signature: ${v.signature}`);
      if (v.target) log(`    redirects to: ${v.target.timestamp}/${v.target.url}`);
      if (v.evidence) log(`    evidence: ${v.evidence.slice(0, 300)}`);
    }
  }
}

/**
 * Build the `audit` handler. Dependency-injectable for tests; the bin wires the
 * defaults.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.discover] - waybackify/ledger.js#discover
 * @param {Function} [deps.flatten] - waybackify/ledger.js#flatten
 * @param {Function} [deps.captureKey] - waybackify/key.js#captureKey
 * @param {Function} [deps.auditCapture] - waybackify#auditCapture
 * @param {Function} [deps.WaybackMachine] - waybackify#WaybackMachine
 * @param {Function} [deps.runAudit] - audit-engine.js#runAudit
 * @param {Object}   [deps.env] - environment (default process.env; CI guard)
 * @returns {Function} paparam runner: ({ args, flags, out, logger }) => Promise<void>
 *   `out` (stdout result sink) and `logger` (stderr diagnostics) are run()-wired.
 */
export function auditHandler(deps = {}) {
  return async ({ args, flags, logger, out = console.log }) => {
    // Progress/verdicts fold onto the logger now (§2), so this handler no longer
    // writes to a stderr `error` sink of its own — only the summary to stdout.
    const { env = process.env } = deps;

    if (env.CI) {
      // Refusing hundreds of archive.org round-trips under CI — this is a
      // supervised, checkpointed, local tool. Domain failure (exit 1).
      const e = new Error('waybackify audit: refusing hundreds of archive.org round-trips under CI (supervised, checkpointed, local tool)');
      e.exitCode = EXIT.DOMAIN;
      throw e;
    }

    if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
      // Domain failure via the root bail handler → exit 1.
      throw new Error(`no such directory: ${args.dir}`);
    }

    const discover = deps.discover ?? (await import('@autocache/waybackify/ledger.js')).discover;
    const flatten = deps.flatten ?? (await import('@autocache/waybackify/ledger.js')).flatten;
    const captureKey = deps.captureKey ?? (await import('@autocache/waybackify/key.js')).captureKey;

    // Generic ledger discovery → the union manifest → the unique captures it
    // references. Entries are `<originalUrl> → { wayback, timestamp }`.
    const union = flatten(discover(args.dir));
    const captures = Object.entries(union.entries)
      .map(([url, entry]) => ({
        key: captureKey(entry.timestamp, url),
        waybackUrl: entry.wayback,
        timestamp: entry.timestamp,
        original: url
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    out(`enumerated ${captures.length} unique captures from the ledger under ${args.dir}`);

    const auditCapture = deps.auditCapture ?? (await import('@autocache/waybackify')).auditCapture;
    const WaybackMachine = deps.WaybackMachine ?? (await import('@autocache/waybackify')).WaybackMachine;
    const runAudit = deps.runAudit ?? (await import('../audit-engine.js')).runAudit;

    const checkpointFile = flags.checkpoint
      ? path.resolve(flags.checkpoint)
      : path.join(path.resolve(args.dir), '.audit', 'checkpoint.jsonl');

    const result = await runAudit(captures, {
      checkpointFile,
      auditCapture,
      WaybackMachine,
      limit: flags.limit !== undefined ? Number(flags.limit) : Infinity,
      delayMs: flags.delayMs !== undefined ? Number(flags.delayMs) : 500,
      timeout: flags.timeout !== undefined ? Number(flags.timeout) : 60000,
      // Progress + verdicts + the CDX retry firehose fold onto the logger (§2);
      // the logger's human stream is stderr, so progress still lands on stderr.
      logger
    });

    out(
      `scope: ${result.scope} captures` +
        (Number.isFinite(flags.limit !== undefined ? Number(flags.limit) : Infinity) ? ` (--limit ${flags.limit}, first-N by capture key)` : '') +
        ` | checkpointed: ${result.checkpointed} | audited: ${result.audited}`
    );
    printSummary(result, out);

    if (flags.report) {
      const report = path.resolve(flags.report);
      fs.writeFileSync(
        report,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            ledger: { dir: args.dir, uniqueCaptures: captures.length },
            scope: result.scope,
            counts: result.summary.counts,
            bad: result.summary.bad
          },
          null,
          2
        ) + '\n'
      );
      out(`\nreport written: ${report}`);
    }
  };
}
