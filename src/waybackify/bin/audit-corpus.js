#!/usr/bin/env node
// Checkpointed wayback-404 corpus audit runner (#248).
//
// Enumerates every wayback capture the corpus references (inline markdown
// links + wayback.json ledgers — see ../enumerate.js), runs the verdict
// engine (../audit.js) over each UNIQUE capture, and appends one JSONL line
// per verdict to a resumable checkpoint file. Re-running skips captures the
// checkpoint already covers, so an interrupted run (archive.org throttling,
// ^C, laptop lid) resumes where it left off. Ends with a summary: counts by
// verdict + a table of every wayback404/suspect with its posts and evidence.
//
// This is a slow, network-heavy, HUMAN-SUPERVISED tool: archive.org takes
// 25–60s per request when it's grumpy. It refuses to run under CI, and the
// checkpoint file is never committed (spv/waybackify/.gitignore).
//
// Placement note (#254): the runner lives in the LIBRARY package because all
// its moving parts do (verdict engine, CDX client, enumerator). The
// future spv/waybackify-cli deliberately does NOT grow a corpus walker
// (`find | xargs waybackify check` is that); this bin is the interim #248
// front door and shrinks to a wrapper when #254 lands.
//
// Usage:
//   node spv/waybackify/bin/audit-corpus.js [options]
//     --root <dir>        repo root (default: three dirs up from this bin)
//     --checkpoint <file> JSONL checkpoint (default: spv/waybackify/.audit/checkpoint.jsonl)
//     --limit <n>         audit only the FIRST n unique captures, sorted by
//                         capture key — deterministic, so a sample run and a
//                         later full run cover a superset
//     --delay <ms>        pause between captures (default 500)
//     --timeout <ms>      per-request timeout (default 60000)
//     --report <file>     also write the summary as JSON
//     --enumerate-only    print enumeration counts and exit (offline)
//     --verbose           log each verdict as it lands

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaybackMachine } from '../index.js';
import { auditCapture } from '../audit.js';
import { enumerateCorpus, summarize as summarizeRefs } from '../enumerate.js';

/**
 * Roll the flat reference list up into the unique captures the verdict engine
 * audits — deduped by flagless `<timestamp>/<original>` (the mirror's capture
 * identity), each carrying the posts that reference it and an occurrence count.
 * enumerateCorpus already threw on any unparseable reference, so there is no
 * separate skip list to surface here.
 */
function captureScope(refs) {
  const byKey = new Map();
  for (const ref of refs) {
    const key = `${ref.timestamp}/${ref.originalUrl}`;
    let cap = byKey.get(key);
    if (!cap) {
      cap = {
        key,
        timestamp: ref.timestamp,
        original: ref.originalUrl,
        waybackUrl: ref.waybackUrl,
        posts: new Set(),
        refCount: 0
      };
      byKey.set(key, cap);
    }
    cap.posts.add(ref.post);
    cap.refCount += 1;
  }
  return [...byKey.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(cap => ({ ...cap, posts: [...cap.posts].sort() }));
}

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = path.resolve(PKG, '../..');

function parseArgs(argv) {
  const args = {
    root: DEFAULT_ROOT,
    checkpoint: path.join(PKG, '.audit', 'checkpoint.jsonl'),
    limit: Infinity,
    delay: 500,
    timeout: 60000,
    report: null,
    enumerateOnly: false,
    verbose: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--root') args.root = path.resolve(next());
    else if (a === '--checkpoint') args.checkpoint = path.resolve(next());
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--delay') args.delay = Number(next());
    else if (a === '--timeout') args.timeout = Number(next());
    else if (a === '--report') args.report = path.resolve(next());
    else if (a === '--enumerate-only') args.enumerateOnly = true;
    else if (a === '--verbose') args.verbose = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

/** Verdicts already in the checkpoint, keyed by capture key. Tolerates a torn final line. */
function loadCheckpoint(file) {
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

function summarize(verdicts) {
  const counts = { good: 0, wayback404: 0, suspect: 0 };
  const bad = [];
  for (const v of verdicts) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
    if (v.verdict !== 'good') bad.push(v);
  }
  bad.sort((a, b) => (a.verdict === b.verdict ? (a.key < b.key ? -1 : 1) : a.verdict === 'wayback404' ? -1 : 1));
  return { counts, bad };
}

function printSummary({ counts, bad }, total, audited) {
  console.log('');
  console.log(`— audit summary: ${audited} audited this scope (${total} unique captures in corpus) —`);
  console.log(`  good:       ${counts.good}`);
  console.log(`  wayback404: ${counts.wayback404}`);
  console.log(`  suspect:    ${counts.suspect}`);
  if (bad.length > 0) {
    console.log('');
    console.log('— captures needing a human pass —');
    for (const v of bad) {
      console.log(`  [${v.verdict}] ${v.url}`);
      console.log(`    posts:    ${v.posts.join(', ')}`);
      console.log(`    statuscode: ${v.statuscode ?? '(none)'} | reason: ${v.reason}`);
      if (v.evidence) console.log(`    evidence: ${v.evidence.slice(0, 300)}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (process.env.CI && !args.enumerateOnly) {
    console.error('audit-corpus: refusing to make hundreds of archive.org round-trips under CI.');
    console.error('This is a supervised, checkpointed, local tool (#248). Use --enumerate-only in CI.');
    process.exit(1);
  }

  const refs = enumerateCorpus(path.join(args.root, 'words'));
  const captures = captureScope(refs);
  const counts = summarizeRefs(refs);
  console.log(
    `enumerated ${counts.total} wayback refs (${counts.inline} inline, ${counts.ledger} ledger) — ` +
      `${captures.length} unique captures across ${counts.posts} posts`
  );
  if (args.enumerateOnly) return;

  const scope = captures.slice(0, args.limit === Infinity ? captures.length : args.limit);
  const done = loadCheckpoint(args.checkpoint);
  const todo = scope.filter(c => !done.has(c.key));
  console.log(
    `scope: ${scope.length} captures` +
      (Number.isFinite(args.limit) ? ` (--limit ${args.limit}, first-N by capture key)` : '') +
      ` | checkpointed: ${scope.length - todo.length} | to audit: ${todo.length}`
  );

  fs.mkdirSync(path.dirname(args.checkpoint), { recursive: true });
  const wayback = new WaybackMachine({ timeout: args.timeout, maxAttempts: 2 });

  let n = 0;
  for (const cap of todo) {
    n++;
    if (args.verbose) process.stdout.write(`[${n}/${todo.length}] ${cap.waybackUrl}\n`);
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
    const line = { key: cap.key, posts: cap.posts, refCount: cap.refCount, ...verdict };
    fs.appendFileSync(args.checkpoint, JSON.stringify(line) + '\n');
    done.set(cap.key, line);
    if (args.verbose) {
      console.log(`  -> ${line.verdict} (${line.statuscode ?? 'no cdx'}) ${line.reason}`);
    }
    if (args.delay > 0 && n < todo.length) await new Promise(r => setTimeout(r, args.delay));
  }

  const inScope = scope.map(c => done.get(c.key)).filter(Boolean);
  const summary = summarize(inScope);
  printSummary(summary, captures.length, inScope.length);
  if (args.report) {
    fs.writeFileSync(
      args.report,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          corpus: { refs: counts.total, uniqueCaptures: captures.length, posts: counts.posts },
          scope: scope.length,
          counts: summary.counts,
          bad: summary.bad
        },
        null,
        2
      ) + '\n'
    );
    console.log(`\nreport written: ${args.report}`);
  }
}

main().catch(error => {
  console.error(`audit-corpus: ${error.message}`);
  process.exit(1);
});
