// The checkpointed wayback-404 audit engine — extracted from the old
// render/wayback/bin/audit-corpus.js so the `waybackify audit` command is a
// thin front door over it. Generic and decouple-clean: it audits a
// caller-supplied list of captures (each `{ key, waybackUrl, timestamp,
// original }`) and knows NOTHING of the content corpus, post conventions, or
// repo paths — the caller (the command) discovers captures via generic ledger
// discovery.
//
// The loop is resumable: each verdict is appended as one JSONL line to a
// checkpoint file, and a re-run skips any capture the checkpoint already
// covers. An interrupted run (archive.org throttling, ^C) resumes where it
// left off.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Verdicts already in the checkpoint, keyed by capture key. Tolerates a torn
 * final line from an interrupted append (that capture reruns).
 *
 * @param {string} file
 * @returns {Map<string, object>}
 */
export function loadCheckpoint(file) {
  const done = new Map();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return done;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v.key) done.set(v.key, v);
    } catch {
      // torn tail from an interrupted append — that capture reruns
    }
  }
  return done;
}

/**
 * Roll a list of landed verdicts up into counts + the captures needing a human
 * pass (anything not `good`), wayback404 before suspect, key-sorted within.
 *
 * @param {object[]} verdicts
 * @returns {{ counts: { good: number, wayback404: number, suspect: number }, bad: object[] }}
 */
export function summarize(verdicts) {
  const counts = { good: 0, wayback404: 0, suspect: 0 };
  const bad = [];
  for (const v of verdicts) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
    if (v.verdict !== 'good') bad.push(v);
  }
  bad.sort((a, b) => (a.verdict === b.verdict ? (a.key < b.key ? -1 : 1) : a.verdict === 'wayback404' ? -1 : 1));
  return { counts, bad };
}

/**
 * Audit `captures` with a checkpointed, resumable run loop. Network I/O is the
 * injected `auditCapture` + `WaybackMachine` (the waybackify verdict engine);
 * the engine itself only reads/writes the checkpoint file and paces the run.
 *
 * @param {Array<{ key: string, waybackUrl: string, timestamp?: string, original?: string, refCount?: number }>} captures
 * @param {Object} options
 * @param {string}   options.checkpointFile - JSONL checkpoint (resume/skip)
 * @param {Function} options.auditCapture - waybackify#auditCapture
 * @param {Function} options.WaybackMachine - waybackify#WaybackMachine
 * @param {number}   [options.limit] - audit only the first N captures (key order)
 * @param {number}   [options.delayMs] - pause between captures (default 500)
 * @param {number}   [options.timeout] - per-request timeout ms (default 60000)
 * @param {(line: string) => void} [options.onProgress]
 * @returns {Promise<{ summary: ReturnType<typeof summarize>, scope: number, audited: number, total: number, checkpointed: number }>}
 */
export async function runAudit(captures, options) {
  const {
    checkpointFile,
    auditCapture,
    WaybackMachine,
    limit = Infinity,
    delayMs = 500,
    timeout = 60000,
    onProgress = () => {}
  } = options;

  const scope = captures.slice(0, Number.isFinite(limit) ? limit : captures.length);
  const done = loadCheckpoint(checkpointFile);
  const todo = scope.filter(c => !done.has(c.key));

  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  const wayback = new WaybackMachine({ timeout, maxAttempts: 2 });

  let n = 0;
  for (const cap of todo) {
    n++;
    onProgress(`[${n}/${todo.length}] ${cap.waybackUrl}`);
    let verdict;
    try {
      verdict = await auditCapture(cap.waybackUrl, { wayback });
    } catch (error) {
      // Engine-level failure (not a fetch failure — those come back suspect):
      // record it as suspect so the run keeps moving and the capture is flagged.
      verdict = {
        verdict: 'suspect',
        statuscode: null,
        reason: `audit error: ${error?.message ?? error}`,
        evidence: '',
        url: cap.waybackUrl,
        timestamp: cap.timestamp,
        original: cap.original,
        checkedAt: new Date().toISOString()
      };
    }
    const line = { key: cap.key, refCount: cap.refCount ?? 1, ...verdict };
    fs.appendFileSync(checkpointFile, JSON.stringify(line) + '\n');
    done.set(cap.key, line);
    if (delayMs > 0 && n < todo.length) await new Promise(r => setTimeout(r, delayMs));
  }

  const inScope = scope.map(c => done.get(c.key)).filter(Boolean);
  return {
    summary: summarize(inScope),
    scope: scope.length,
    audited: inScope.length,
    total: captures.length,
    checkpointed: scope.length - todo.length
  };
}
