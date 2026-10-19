/**
 * The verify checkpoint of `waybackify bucket verify`. The parity engine
 * (./parity.ts) keeps its progress in a {@link VerifyCheckpoint} value. This
 * module stores that value as one JSON file per bucket target:
 *
 *   <root>/.verify/<host>-<bucket>[-<prefix>].<hash12>.json
 *
 * The readable part of the name helps an operator. The hash is over the exact
 * normalized target, so two targets never share a file. The naked tier and an
 * `orig/` tier of one bucket therefore keep separate checkpoints.
 *
 * The directory sits beside the `.crawl/` and `.refetch/` state of the sibling
 * commands. The bucket projection walks `meta/` only, so it never uploads the
 * checkpoint. `cache verify` (fsck) accepts `.verify/` as sanctioned state.
 *
 * The module also holds the run progress model that the engine uses:
 *
 *   - {@link startProgress} seeds a run from a `resume` checkpoint. The
 *     checkpoint is void, with a warning, when the {@link rootSignature} or the
 *     target differs. A different Layer 4 sample size voids only Layer 4.
 *   - {@link snapshotProgress} turns the live progress into a checkpoint.
 *   - {@link checkpointWriter} serializes the snapshots to the caller sink.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Entry, LayerReport, ParityLogger, ParityOptions } from './parity.ts';

/** The root-relative directory that holds the checkpoint files. */
export const VERIFY_DIR = '.verify';

/** The bucket target that a checkpoint belongs to, in normalized form. */
export interface CheckpointTarget {
  /** The endpoint with no trailing slash. */
  endpoint: string;
  bucket: string;
  /** The bucket key prefix with no leading or trailing slash. `''` is no prefix. */
  prefix: string;
}

/**
 * The persisted progress of one verification. The engine emits it and the
 * caller stores it. A later run that receives it as `resume` skips the work
 * that it records, but only while `signature` and `target` still match.
 */
export interface VerifyCheckpoint {
  /** The `rootSignature` of the root entry set that the progress is for. */
  signature: string;
  target: CheckpointTarget;
  /** The Layer 4 sample size of the recorded Layer 4 verdict. */
  sample: number;
  /** The layers that passed, as their reports. */
  passed: LayerReport[];
  /** Layer 3 progress, as `cap/` object keys. */
  bodies: {
    /** The bodies whose sha256 matched the sidecar. */
    verified: string[];
    /** The bodies that needed one or more re-fetches. */
    healed: string[];
  };
}

/**
 * The signature of a root entry set: sha256 over every field that a layer
 * compares, in the sorted order of {@link enumerateRoot}. A change to any
 * sidecar, an added entry, or a removed entry changes it.
 */
export function rootSignature(entries: Entry[]): string {
  const hash = createHash('sha256');
  for (const e of entries) {
    hash.update(`${JSON.stringify([e.key, e.status, e.contentType, e.contentHash ?? null, e.contentLength ?? null])}\n`);
  }
  return `sha256-${hash.digest('hex')}`;
}

/**
 * The one normal form of a bucket key prefix: no leading or trailing slash,
 * and `undefined` when nothing is left. The engine applies it once, before
 * every bucket read, and the checkpoint identity applies the same function.
 * Two prefixes that fold to one value therefore address the same keys, and
 * two prefixes that address different keys never share a checkpoint.
 */
export function normalizePrefix(prefix: string | undefined): string | undefined {
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed || undefined;
}

/** Normalize a target, so that equal targets compare equal. */
export function checkpointTarget(target: { endpoint: string; bucket: string; prefix?: string }): CheckpointTarget {
  return {
    endpoint: target.endpoint.replace(/\/+$/, ''),
    bucket: target.bucket,
    prefix: normalizePrefix(target.prefix) ?? ''
  };
}

/** The checkpoint file of one bucket target under one root. */
export function checkpointPath(root: string, target: { endpoint: string; bucket: string; prefix?: string }): string {
  const normal = checkpointTarget(target);
  let host: string;
  try {
    host = new URL(normal.endpoint).host;
  } catch {
    host = normal.endpoint;
  }
  const readable = [host, normal.bucket, normal.prefix].filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]+/g, '_');
  const digest = createHash('sha256').update(JSON.stringify([normal.endpoint, normal.bucket, normal.prefix])).digest('hex').slice(0, 12);
  return path.join(root, VERIFY_DIR, `${readable}.${digest}.json`);
}

/**
 * Read a checkpoint. An absent file gives `undefined`. A file that does not
 * have the checkpoint shape is an error that names the file, because a resume
 * from damaged progress can give a false PASS.
 */
export async function readCheckpoint(file: string): Promise<VerifyCheckpoint | undefined> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!isCheckpoint(value)) {
    throw new Error(`${file} is not a verify checkpoint. Delete it, or run without --resume`);
  }
  return value;
}

/** Write a checkpoint atomically: a temporary file, then a rename over the target. */
export async function writeCheckpoint(file: string, checkpoint: VerifyCheckpoint): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(checkpoint)}\n`);
  await fsp.rename(temporary, file);
}

/** Remove a checkpoint. An absent file is not an error. */
export async function removeCheckpoint(file: string): Promise<void> {
  await fsp.rm(file, { force: true });
}

/** Layer 3 progress that a checkpoint carries from run to run. */
export interface BodyProgress {
  /** `cap/` keys whose body already verified. Layer 3 does not read them again. */
  verified: Set<string>;
  /** `cap/` keys whose body needed one or more re-fetches. */
  healed: Set<string>;
  /** Called after each body that verifies in this run. */
  onVerified?: () => void;
}

/** The live progress of one run. A {@link VerifyCheckpoint} is its snapshot. */
export interface RunProgress {
  signature: string;
  target: CheckpointTarget;
  sample: number;
  passed: Map<number, LayerReport>;
  verified: Set<string>;
  healed: Set<string>;
}

/**
 * Start the progress of a run. A valid `resume` checkpoint seeds it. A
 * checkpoint for another root entry set or another target is void: the run
 * warns and starts empty. A checkpoint with another sample size keeps every
 * recorded verdict except Layer 4.
 */
export function startProgress(options: ParityOptions, entries: Entry[], sample: number, logger: ParityLogger): RunProgress {
  const fresh: RunProgress = {
    signature: rootSignature(entries),
    target: checkpointTarget(options),
    sample,
    passed: new Map(),
    verified: new Set(),
    healed: new Set()
  };
  const prior = options.resume;
  if (!prior) return fresh;

  const sameTarget = prior.target.endpoint === fresh.target.endpoint && prior.target.bucket === fresh.target.bucket && prior.target.prefix === fresh.target.prefix;
  const reason = prior.signature !== fresh.signature ? 'the root entry set changed' : sameTarget ? undefined : 'it is for a different bucket target';
  if (reason) {
    logger.warn({ evt: 'parity-checkpoint-void', reason }, `verify checkpoint ignored: ${reason}. Every requested layer runs in full`);
    return fresh;
  }

  const passed = new Map(prior.passed.map(report => [report.layer, report]));
  if (prior.sample !== fresh.sample) passed.delete(4);
  logger.info(
    { evt: 'parity-checkpoint-resume', passed: [...passed.keys()], verified: prior.bodies.verified.length },
    `resuming from a verify checkpoint: ${passed.size} layer(s) passed, ${prior.bodies.verified.length} bodies verified`
  );
  return { ...fresh, passed, verified: new Set(prior.bodies.verified), healed: new Set(prior.bodies.healed) };
}

export function snapshotProgress(progress: RunProgress): VerifyCheckpoint {
  return {
    signature: progress.signature,
    target: progress.target,
    sample: progress.sample,
    passed: [...progress.passed.values()].sort((a, b) => a.layer - b.layer),
    bodies: { verified: [...progress.verified], healed: [...progress.healed] }
  };
}

/**
 * Serialize the checkpoint sink. Each `save` takes its snapshot at once and
 * queues the call. A failed call is logged one time. It never changes the
 * verdict, because the last stored snapshot is still true progress.
 */
export function checkpointWriter(sink: ParityOptions['onCheckpoint'], snapshot: () => VerifyCheckpoint, logger: ParityLogger) {
  let chain: Promise<void> = Promise.resolve();
  let reported = false;
  let closed = false;
  return {
    save(): void {
      if (!sink || closed) return;
      const value = snapshot();
      chain = chain
        .then(() => sink(value))
        .catch((error: unknown) => {
          if (reported) return;
          reported = true;
          const detail = error instanceof Error ? error.message : String(error);
          logger.error({ evt: 'parity-checkpoint-write', error: detail }, `verify checkpoint not stored: ${detail}`);
        });
    },
    /** Wait for every queued call, and refuse later saves. The run calls it when it settles. */
    flush(): Promise<void> {
      closed = true;
      return chain;
    }
  };
}

/** A positive integer, or the fallback. */
export function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function isCheckpoint(value: unknown): value is VerifyCheckpoint {
  const v = value as Partial<VerifyCheckpoint> | null;
  const strings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string');
  return (
    typeof v === 'object' && v !== null &&
    typeof v.signature === 'string' &&
    typeof v.sample === 'number' &&
    typeof v.target === 'object' && v.target !== null &&
    typeof v.target.endpoint === 'string' && typeof v.target.bucket === 'string' && typeof v.target.prefix === 'string' &&
    Array.isArray(v.passed) && v.passed.every(report => typeof report?.layer === 'number' && report.pass === true) &&
    typeof v.bodies === 'object' && v.bodies !== null && strings(v.bodies.verified) && strings(v.bodies.healed)
  );
}
