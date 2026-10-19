// `waybackify bucket verify` handler — thin wiring over the parity engine, per
// the CLI's hard thin-wrapper rule: the load-bearing four-layer verifier (count
// parity, metadata sweep, body verification, serving parity) is
// waybackify-verify; this file translates the parsed argv payload into a
// runParityCheck() call, installs the retrying global dispatcher at the process
// edge (waybackify-verify/retry — so ~22k signed reads self-heal a transient
// flap), reads AWS creds from the environment, and maps the verdict to an exit
// code. Ports the run + error logic of the retired bucket-parity fsck bin
// (§G `bucket verify`).
//
// Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (plus an
// optional AWS_SESSION_TOKEN) in the environment, never flags — an operator's
// secret belongs in the environment, not the process table.
//
// The engine + dispatcher are imported by workspace specifier and lazily inside
// the runner, so merely loading the CLI surface never pays for undici or the
// serving stack. A test injects `deps.parity` (and skips the dispatcher) to
// exercise the wiring offline.
//
// The run is resumable. Without --layer, the handler stores the
// checkpoint of the engine at <root>/.verify/<target>.json
// (waybackify-verify/verify-checkpoint) as the run works. A passing run removes
// it. A later --resume run hands it back to the engine, which then skips the
// layers that passed and the Layer 3 bodies that verified. A default run
// removes an old checkpoint before its first bucket read. An explicit --layer
// run reads and writes no checkpoint.
//
// Full population runbook (creds, verification): docs/SYNC.md.

import { EXIT } from '../cli.js';

/** Parse `--layer 1,3,4` into a number list; reject anything outside 1–4. */
function parseLayers(raw, fail) {
  if (raw === undefined) return undefined;
  const layers = raw.split(',').map(part => Number(part.trim()));
  if (layers.some(n => !Number.isInteger(n) || n < 1 || n > 4)) fail(`invalid --layer: ${raw} (expected 1–4)`);
  return layers;
}

/** Parse a positive-integer flag; reject a non-integer / <1 value. */
function parseCount(raw, flag, fail) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`invalid ${flag}: ${raw}`);
  return value;
}

/**
 * Build the `bucket verify` handler. Dependency-injectable for tests; the bin
 * wires the default.
 *
 * @param {Object} [deps]
 * @param {Object}   [deps.parity] - the waybackify-verify parity module (injected → no library load, no dispatcher)
 * @param {Function} [deps.setGlobalDispatcher] - undici sink (injected → no global install)
 * @param {Function} [deps.createRetryAgent] - waybackify-verify/retry factory
 * @param {Object}   [deps.env] - environment for AWS creds (default process.env)
 * @returns {Function} paparam runner: ({ flags }) => Promise<void>
 */
export function bucketVerifyHandler(deps = {}) {
  return async ({ flags, logger, progressEvery, out = console.log }) => {
    const { env = process.env } = deps;

    /** A usage error (exit 2) the root bail handler honors via .exitCode. */
    const fail = message => {
      const e = new Error(`waybackify bucket verify: ${message}`);
      e.exitCode = EXIT.USAGE;
      throw e;
    };

    const layers = parseLayers(flags.layer, fail);
    const sample = parseCount(flags.sample, '--sample', fail);
    const currentConcurrency = parseCount(flags.concurrency, '--concurrency', fail);
    const resume = Boolean(flags.resume);
    if (resume && layers) fail('--resume cannot be combined with --layer (an explicit --layer runs exactly those layers, with no checkpoint)');

    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      fail('needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment');
    }
    const sessionToken = env.AWS_SESSION_TOKEN;
    const credentials = sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };

    // Load the engine (injected or lazy).
    const parity = deps.parity ?? (await import('@autocache/waybackify-verify'));
    const { runParityCheck, formatReport, formatLayerVerdict, diagnoseFailure, DEFAULT_CONCURRENCY } = parity;
    const concurrency = currentConcurrency ?? DEFAULT_CONCURRENCY;

    // Install a retrying global dispatcher ONCE, at the process edge — every
    // `fetch` this audit makes self-heals a resolver hiccup / 503 with no
    // fetch-injection plumbing. GET/HEAD only, so retrying is always safe.
    // Skipped when the engine is injected (offline wiring test).
    if (!deps.parity) {
      const setGlobalDispatcher = deps.setGlobalDispatcher ?? (await import('undici')).setGlobalDispatcher;
      const createRetryAgent = deps.createRetryAgent ?? (await import('@autocache/waybackify-verify/retry')).createRetryAgent;
      setGlobalDispatcher(createRetryAgent());
    }

    // The checkpoint of a run over all layers. An explicit --layer run has none.
    let checkpointFile;
    let checkpoints;
    let prior;
    if (!layers) {
      checkpoints = deps.checkpoint ?? (await import('@autocache/waybackify-verify/verify-checkpoint'));
      checkpointFile = checkpoints.checkpointPath(flags.root, { endpoint: flags.endpoint, bucket: flags.bucket, prefix: flags.prefix });
      if (resume) {
        try {
          prior = await checkpoints.readCheckpoint(checkpointFile);
        } catch (err) {
          fail(err.message);
        }
        if (prior) logger.info({ evt: 'verify-checkpoint-read', path: checkpointFile }, `resuming from ${checkpointFile}`);
        else logger.warn({ evt: 'verify-checkpoint-absent', path: checkpointFile }, `no checkpoint at ${checkpointFile}: every layer runs in full`);
      } else {
        // A default run establishes its own progress. Remove an old checkpoint
        // before the first bucket read. If this run stops early, a later
        // --resume then cannot trust verdicts that this run did not establish.
        await checkpoints.removeCheckpoint(checkpointFile);
      }
    }

    // A failed run keeps its checkpoint. Name the file and the remedy.
    const logKept = () =>
      logger.info({ evt: 'verify-checkpoint-kept', path: checkpointFile }, `progress kept at ${checkpointFile}: re-run with --resume to continue`);

    let report;
    try {
      report = await runParityCheck({
        root: flags.root,
        endpoint: flags.endpoint,
        bucket: flags.bucket,
        region: flags.region ?? 'auto',
        prefix: flags.prefix,
        credentials,
        layers,
        sample,
        concurrency,
        // Throttled sweep progress + each mismatch fold onto the logger (§2);
        // its human stream is stderr, so progress still lands there. stdout
        // stays the report only. --progress-every governs parity's Layer 2/3
        // throttle too (§6), overriding its built-in default of 500 (0 = off).
        logger,
        progressEvery,
        resume: prior,
        onCheckpoint: checkpointFile ? checkpoint => checkpoints.writeCheckpoint(checkpointFile, checkpoint) : undefined
      });
    } catch (err) {
      // Layers that finished before the run gave out carry real verdicts —
      // print them first, so "nothing failed verification, the network died at
      // layer N" is legible before the one-line diagnosis.
      const completed = Array.isArray(err?.completedLayers) ? err.completedLayers : [];
      for (const layer of completed) logger.info({ evt: 'layer-verdict', layer: layer?.layer }, formatLayerVerdict(layer));
      if (checkpointFile) logKept();
      // Then ONE diagnostic line as the thrown message; run() prints it to stderr.
      const diagnosed = new Error(`waybackify bucket verify: ${diagnoseFailure(err, concurrency)}`);
      diagnosed.exitCode = EXIT.DOMAIN;
      throw diagnosed;
    }

    const rendered = flags.json ? JSON.stringify(report, null, 2) : formatReport(report);
    out(rendered);
    if (flags.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(flags.out, `${rendered}\n`);
    }

    // A passing run leaves nothing to resume.
    if (checkpointFile && report.pass) await checkpoints.removeCheckpoint(checkpointFile);

    if (!report.pass) {
      if (checkpointFile) logKept();
      // A bucket that diverges from the root is a domain failure (exit 1).
      const e = new Error(`waybackify bucket verify: ${flags.bucket} is not a faithful projection of ${flags.root}`);
      e.exitCode = EXIT.DOMAIN;
      throw e;
    }
  };
}
