// `waybackify check` handler — thin wiring over the library, per the CLI's
// hard thin-wrapper rule: the load-bearing verdict engine (CDX statuscode
// lookup + soft-404 replay heuristics) is spv/waybackify/audit.js; this file
// translates the parsed argv payload into an auditCapture() call, prints the
// library's verdict object to stdout VERBATIM (one JSON line, no reshaping),
// logs nothing else to stdout, and maps the verdict to an exit code.
//
// Exit-code contract (also in --help / README):
//   0  good        — verified: real content behind the replay
//   1  wayback404   — confidently junk (archived AS an error, or a soft-404 body)
//   3  suspect      — uncertain; nonzero ON PURPOSE (conservative composition —
//                     `manifest | xargs check` must not silently pass junk)
// (2 stays the parse-time usage error owned by src/cli.js.)
//
// The library is imported by workspace-relative path (both packages are
// private and in-repo) and lazily, inside the factory, so merely loading the
// CLI surface (src/cli.js, --help, the other commands) never pays for impit.

import { EXIT } from '../cli.js';

/**
 * Build the check handler. Dependency-injectable for tests; the bin wires the
 * default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.auditCapture] - the library entry point
 * @returns {Function} paparam runner: ({ args, logger, out }) => Promise<void>
 *   — `out` (stdout result) and `logger` (stderr diagnostics) are run()-wired.
 */
export function checkHandler(deps = {}) {
  return async ({ args, logger, out = console.log }) => {
    const auditCapture = deps.auditCapture ?? (await import('@charlie.dev/waybackify/audit.js')).auditCapture;

    // The library's verdict object, printed VERBATIM — one JSON line on
    // stdout, jq/xargs-friendly. Do NOT reshape: `check | jq -r .verdict`
    // is the composability contract.
    const verdict = await auditCapture(args.waybackUrl, { logger });
    out(JSON.stringify(verdict));

    if (verdict.verdict === 'good') return; // exit 0

    // Non-good verdicts exit nonzero. Thrown runner errors route through the
    // root bail handler, which honors the exit code carried on the error
    // (src/cli.js). wayback404 → 1 (a bad verdict IS a domain failure);
    // suspect → 3, distinct and nonzero on purpose.
    const error = new Error(`waybackify check: ${verdict.verdict} — ${verdict.reason}`);
    error.exitCode = verdict.verdict === 'wayback404' ? EXIT.DOMAIN : EXIT.SUSPECT;
    throw error;
  };
}
