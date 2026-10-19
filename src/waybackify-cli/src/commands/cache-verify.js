// `waybackify cache verify` handler — thin wiring over the library, per the
// CLI's hard thin-wrapper rule: the load-bearing store fsck (walk meta/,
// re-hash bodies, re-derive paths, check requisite closure, quarantine orphan
// cap/ + delete stale tmp/ under --fix) is the library's fsck.js. This file translates the
// parsed argv payload into an fsck() call, formats the per-category report on
// stdout (--json for the raw record), and maps an unresolved store to a
// domain-failure exit (1). Report-only unless --fix is passed.
//
// The library is imported by workspace-relative specifier (both packages are
// private and in-repo) and lazily, inside the runner, so merely loading the
// CLI surface never pays for the fetch stack fsck.js pulls in transitively.

import path from 'node:path';
import { EXIT } from '../cli.js';

/** One human line per finding — enough to locate and explain it on disk. */
function describe(category, f) {
  switch (category) {
    case 'malformed':
      return `${f.aa}/${f.hash}.json — ${f.error}`;
    case 'hashMismatch':
      return `${f.aa}/${f.hash}  expected ${f.expected} · got ${f.actual}  (key: ${f.key})`;
    case 'keyMismatch':
      return `${f.aa}/${f.hash}  key hashes to ${f.derived}  (key: ${f.key})`;
    case 'missingBody':
      return f.quarantined ? `${f.aa}/${path.basename(f.quarantined)}  in quarantine: ${f.quarantined}  ${f.error ?? ''}`.trimEnd() : `${f.aa}/${f.hash}  (key: ${f.key})`;
    case 'incompleteClosure':
      return `${f.aa}/${f.hash}  (key: ${f.key})  → requisite absent: ${f.child}`;
    case 'interstitialAsBody':
      return `${f.aa}/${f.hash}  ${f.signature}${f.target ? ` → ${f.target}` : ''}  (key: ${f.key})`;
    case 'schemaVersion':
      return `${f.aa}/${f.hash}  v=${f.v}  (key: ${f.key})`;
    case 'foreignRoot':
      return `${f.name}${f.isDir ? '/' : ''}`;
    case 'orphanCap':
      return `${f.aa}/${f.hash}`;
    case 'staleTmp':
      return `${f.name}`;
    default:
      return JSON.stringify(f);
  }
}

/**
 * Print the human report (one block per category, then a summary line). Mirror
 * of the store's own severities: reapable → reaped/REAP, incomplete → SHORT,
 * advisory → flag, corruption → FAIL.
 */
function printReport(report, { quiet, CATEGORIES, totalFindings, unresolvedFindings }, log) {
  const { counts } = report;
  log(`fsck ${report.root}`);
  log(
    `  inventory: ${counts.sidecars} sidecars (${counts.bodies} bodied) · ` +
      `${counts.capFiles} cap/ files · ${counts.tmpFiles} tmp/ entries · ` +
      `${counts.trashFiles ?? 0} trash/ files · schema v${report.schemaVersion}`
  );
  log('');

  for (const { key, label, severity } of CATEGORIES) {
    const hits = report.findings[key];
    if (hits.length === 0) {
      if (!quiet) log(`  ${'ok'.padEnd(6)} ${label}`);
      continue;
    }
    const reaped = report.reaped?.[key]?.length ?? 0;
    let tag;
    if (severity === 'reapable') tag = reaped === hits.length ? (key === 'orphanCap' ? 'moved' : 'reaped') : 'REAP';
    else if (severity === 'incomplete') tag = 'SHORT';
    else if (severity === 'advisory') tag = 'flag';
    else tag = 'FAIL';
    log(`  ${tag.padEnd(6)} ${label}: ${hits.length}${reaped ? ` (${reaped} reaped)` : ''}`);
    for (const f of hits) {
      const mark = report.reaped?.[key]?.includes(f.path) ? '×' : '-';
      log(`        ${mark} ${describe(key, f)}${f.reapError ? `  [reap failed: ${f.reapError}]` : ''}`);
    }
  }

  log('');
  const total = totalFindings(report);
  const unresolved = unresolvedFindings(report);
  if (total === 0) {
    log('  clean — every sidecar verifies against its body; no orphans, no stragglers.');
  } else if (report.reaped) {
    const moved = report.reaped.orphanCap.length;
    const where = moved && report.reaped.trash ? ` (${moved} orphan cap/ file(s) moved to ${report.reaped.trash})` : '';
    log(`  ${total} finding(s); resolved ${total - unresolved}${where}; ${unresolved} unresolved.`);
  } else {
    log(`  ${total} finding(s) — report-only (pass --fix to quarantine orphan cap/ + delete stale tmp/).`);
  }
}

/**
 * Build the `cache verify` handler. Dependency-injectable for tests; the bin
 * wires the default. A test injects the four library members so the runner
 * never loads waybackify/fsck.js (which transitively pulls the fetch stack).
 *
 * @param {Object} [deps]
 * @param {Function} [deps.fsck] - fsck.js#fsck
 * @param {Function} [deps.emptyTrash] - fsck.js#emptyTrash (the --empty-trash action)
 * @param {Function} [deps.restoreTrash] - fsck.js#restoreTrash (the --restore <run> action)
 * @param {Array}    [deps.CATEGORIES] - fsck.js#CATEGORIES
 * @param {Function} [deps.totalFindings] - fsck.js#totalFindings
 * @param {Function} [deps.unresolvedFindings] - fsck.js#unresolvedFindings
 * @returns {Function} paparam runner: ({ flags, out, logger }) => Promise<void>
 *   — `out` (stdout result sink) and `logger` (stderr diagnostics) are run()-wired.
 */
export function cacheVerifyHandler(deps = {}) {
  return async ({ flags, logger, progressEvery, out = console.log }) => {
    // If fsck is injected, every helper comes off deps (no library load);
    // otherwise lazily import the module for all four members.
    const mod = deps.fsck ? deps : await import('@autocache/waybackify/fsck.js');
    const { fsck, emptyTrash, restoreTrash, CATEGORIES, totalFindings, unresolvedFindings } = mod;

    // --restore <run> moves a quarantined run's bodies back under cap/. It runs
    // before the verify so the report below describes the restored store. A
    // body whose live path is occupied is skipped and reported, never replaced.
    if (flags.restore) {
      const result = await restoreTrash(flags.root, flags.restore);
      for (const r of result.restored) logger.info({ evt: 'fsck-restore', ...r }, `cache verify: restored ${r.to}`);
      for (const s of result.skipped) logger.warn({ evt: 'fsck-restore-skipped', ...s }, `cache verify: kept ${s.from} in quarantine (${s.reason})`);
      logger.info(
        { evt: 'fsck-restore-summary', run: result.run, restored: result.restored.length, skipped: result.skipped.length },
        `cache verify: restore of ${result.run}: ${result.restored.length} restored, ${result.skipped.length} skipped`
      );
    }

    // --empty-trash is the ONE action that deletes body files: it empties the
    // quarantine --fix filled on earlier runs. Explicit, separate, and first,
    // so this run's own moves (if --fix is also set) survive it.
    if (flags.emptyTrash) {
      const emptied = await emptyTrash(flags.root);
      logger.info({ evt: 'fsck-empty-trash', ...emptied }, `cache verify: emptied ${emptied.path} (${emptied.files} file(s), ${emptied.bytes} bytes)`);
    }

    // --root|-r is canonical (cli.js). --fix moves orphan cap/ files to the
    // trash/ quarantine and deletes stale tmp/. Corruption and a short closure
    // are never touched. Silent-loop progress (§6): the re-hash sweep speaks
    // every --progress-every.
    const report = await fsck(flags.root, { fix: Boolean(flags.fix), logger, progressEvery });

    if (flags.json) out(JSON.stringify(report, null, 2));
    else printReport(report, { quiet: Boolean(flags.quiet), CATEGORIES, totalFindings, unresolvedFindings }, out);

    const unresolved = unresolvedFindings(report);
    if (unresolved > 0) {
      // Nonzero ON PURPOSE: a store with unresolved findings (corruption, an
      // advisory, a foreign root entry, OR a short requisite closure) is a
      // domain failure. exitCode is honored by the root bail handler (cli.js).
      const error = new Error(`waybackify cache verify: ${unresolved} unresolved finding(s) in ${report.root}`);
      error.exitCode = EXIT.DOMAIN;
      throw error;
    }
  };
}
