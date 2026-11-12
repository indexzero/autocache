// `waybackify cache status` handler — thin wiring over the library's
// status.js, per the CLI's hard thin-wrapper rule: the join (ledger against
// the root's sidecars, fill's gone ledger, the store's footprint) is the
// library's. This file translates the parsed argv payload into a status()
// call, formats the report on stdout (--json for the raw record), and maps
// "not complete" to a domain-failure exit (1).

import fs from 'node:fs';
import { humanBytes } from '../logger.js';

/** How many needs-attention captures the human report lists before eliding. */
const ATTENTION_SHOWN = 20;

/**
 * Build the `cache status` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.status] - the library entry point
 * @returns {Function} paparam runner: ({ args, flags, out }) => Promise<void>
 */
export function cacheStatusHandler(deps = {}) {
  return async ({ args, flags, out = console.log }) => {
    const status = deps.status ?? (await import('@autocache/waybackify/status.js')).status;

    if (!deps.status && (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory())) {
      // Domain failure via the root bail handler → exit 1 (as `ledger` does).
      throw new Error(`no such directory: ${args.dir}`);
    }

    const report = await status(args.dir, flags.root);

    if (flags.json) {
      out(JSON.stringify(report));
    } else {
      const row = s => `${String(s.cached).padStart(7)} cached · ${s.unfetched} unfetched · ${s.interstitial} interstitial · ${s.error} error`;
      out(`${report.root} ← ${report.ledger}`);
      out(`  ${row(report.states)}  (${report.captures} captures)`);
      const groups = Object.entries(report.groups);
      if (groups.length > 1) {
        const width = Math.max(...groups.map(([name]) => name.length));
        for (const [name, s] of groups) out(`  ${name.padEnd(width)} ${row(s)}`);
      }
      out(`  unfetched: ${report.unfetched.pending} pending · ${report.unfetched.gone} gone`);
      if (report.attention.length > 0) {
        out('  needs attention (no further fill pass will fix these):');
        // The human report shows the first few; --json carries them all.
        for (const a of report.attention.slice(0, ATTENTION_SHOWN)) {
          out(`    ${a.remedy.padEnd(9)} ${a.state}${a.signature ? ` (${a.signature})` : ''}  ${a.key}`);
        }
        if (report.attention.length > ATTENTION_SHOWN) {
          out(`    … ${report.attention.length - ATTENTION_SHOWN} more (--json lists every one)`);
        }
        const by = remedy => report.attention.filter(a => a.remedy === remedy).length;
        out(`  ${by('remediate')} remediate → waybackify cache remediate --root <root> · ${by('repick')} repick → choose another capture`);
      }
      const st = report.store;
      out(`  store: ${st.sidecars} sidecars (${st.documents} ledger captures + ${st.requisites} requisites) · ${humanBytes(st.bytes)} in cap/`);
    }

    if (!report.complete) {
      throw new Error(
        `cache status: ${report.unfetched.pending} capture(s) pending, ${report.attention.length} need attention`
      );
    }
  };
}
