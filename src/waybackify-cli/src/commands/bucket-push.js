// `waybackify bucket push` handler — thin wiring over the library, per the
// CLI's hard thin-wrapper rule: the load-bearing emitter (walk meta/, derive
// object keys, shell-quote, carry status/content-type as native metadata) is
// spv/waybackify/bucket-batch.js; this file translates the parsed argv payload
// into an emitBucketBatch() call, streams the batch to stdout (ready to pipe
// into `s5cmd run`) and the summary to stderr. A bad root/sidecar throws →
// domain-failure exit (1). A sidecar whose body file is missing is skipped by
// the emitter and reported in the summary. The handler then exits 1 as well,
// after the rest of the batch and the summary are out: a partial push is not
// a success, and the operator refetches the skipped entries.
//
// The library is imported by workspace-relative specifier (both packages are
// private and in-repo) and lazily, inside the runner, so merely loading the
// CLI surface never pays for the import.
//
// Full population runbook (both targets, creds, verification): docs/SYNC.md.

/**
 * Build the `bucket push` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.emitBucketBatch] - the library entry point
 * @returns {Function} paparam runner: ({ flags, logger, out }) => Promise<void>
 *   `out` (run()-wired stdout sink) carries the batch; `logger` (run()-wired
 *   stderr channel) carries progress + summary.
 */
export function bucketPushHandler(deps = {}) {
  return async ({ flags, logger, progressEvery, out = console.log }) => {
    const emitBucketBatch = deps.emitBucketBatch ?? (await import('@autocache/waybackify/bucket-batch.js')).emitBucketBatch;

    const { lines, summary } = await emitBucketBatch(flags.root, {
      bucket: flags.bucket,
      emptyFile: flags.emptyFile ?? null,
      // Silent-loop progress (§6) → the logger (stderr). NEVER stdout: stdout is
      // the s5cmd batch, and a progress line piped into `s5cmd run` is a command.
      logger,
      progressEvery
    });

    // The batch goes to stdout, one cp line per object, ready to pipe into
    // `s5cmd run`. --dry-run diverts it to the logger (stderr) so an accidental
    // `| s5cmd run` is a no-op.
    if (flags.dryRun) {
      for (const line of lines) logger.info({ evt: 'bucket-summary', dryRun: true }, line);
    } else {
      for (const line of lines) out(line);
    }

    // Summary ALWAYS on stderr (the logger) — it must never contaminate the
    // piped batch on stdout.
    logger.info(
      {
        evt: 'bucket-summary',
        total: summary.total,
        bodied: summary.bodied,
        bodiless: summary.bodiless,
        missingBodies: summary.missingBodies ?? 0,
        dryRun: Boolean(flags.dryRun)
      },
      `bucket push: ${summary.total} objects (${summary.bodied} bodied, ${summary.bodiless} bodiless)` +
        `${summary.missingBodies ? `, ${summary.missingBodies} skipped for a missing body (refetch them)` : ''}` +
        `${flags.dryRun ? ' — dry-run, nothing written to stdout' : ''}`
    );

    // A partial push is not a success. The batch and the summary are already
    // out, so the thrown error routes through run()'s bail handler → exit 1.
    if (summary.missingBodies) {
      throw new Error(`bucket push incomplete: ${summary.missingBodies} sidecar(s) name a missing body — refetch them and rerun`);
    }
  };
}
