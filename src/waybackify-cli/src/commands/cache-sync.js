// `waybackify cache sync` handler — thin wiring over the library, per the
// CLI's hard thin-wrapper rule: the load-bearing emitter (walk meta/, derive
// object keys, shell-quote, carry status/content-type as native metadata) is
// spv/waybackify/bucket-batch.js; this file translates the parsed argv payload
// into an emitBucketBatch() call, streams the batch to stdout (ready to pipe
// into `s5cmd run`) and the summary to stderr. A bad root/sidecar throws →
// domain-failure exit (1).
//
// The library is imported by workspace-relative specifier (both packages are
// private and in-repo) and lazily, inside the runner, so merely loading the
// CLI surface never pays for the import.
//
// Full population runbook (both targets, creds, verification): docs/SYNC.md.

/**
 * Build the `cache sync` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.emitBucketBatch] - the library entry point
 * @param {Function} [deps.log] - stdout line sink (the batch)
 * @param {Function} [deps.error] - stderr line sink (the summary; batch under --dry-run)
 * @returns {Function} paparam runner: ({ flags }) => Promise<void>
 */
export function cacheSyncHandler(deps = {}) {
  return async ({ flags }) => {
    const { log = console.log, error = console.error } = deps;
    const emitBucketBatch = deps.emitBucketBatch ?? (await import('@charlie.dev/waybackify/bucket-batch.js')).emitBucketBatch;

    const { lines, summary } = await emitBucketBatch(flags.root, {
      bucket: flags.bucket,
      emptyFile: flags.emptyFile ?? null
    });

    // The batch goes to stdout, one cp line per object, ready to pipe into
    // `s5cmd run`. --dry-run diverts it to stderr so an accidental
    // `| s5cmd run` is a no-op.
    const batchSink = flags.dryRun ? error : log;
    for (const line of lines) batchSink(line);

    // Summary ALWAYS on stderr — it must never contaminate the piped batch.
    error(
      `cache sync: ${summary.total} objects (${summary.bodied} bodied, ${summary.bodiless} bodiless)` +
        `${flags.dryRun ? ' — dry-run, nothing written to stdout' : ''}`
    );
  };
}
