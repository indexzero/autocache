// waybackify CLI surface.
//
// This module pins the ENTIRE command/option contract — names, args, flags,
// help text, exit codes — with ZERO implementation. The command handlers
// (manifest, rewrite, ledger, check, search, audit, plus the three tier
// groups: `cache` add · fill · crawl · verify, `remaster` build · verify, and
// `bucket` push · verify) are injected by the bin; a missing handler throws Not
// implemented (exit 70) as a defensive path. Implementations never touch argv
// parsing.
//
// §G noun-per-tier surface: each store tier is a GROUP command with a
// {produce, verify} pair — cache {add/fill, crawl, verify}, remaster {build, verify},
// bucket {push, verify}. `cache`/`remaster`/`bucket` are GROUP commands
// (paparam nests: a command() may take child command()s as args, and
// `cmd.help('remaster','verify')` yields the nested help). A group carries no
// runner of its own — every operation is a verb under it, so `waybackify
// remaster` with no verb prints the group's help (run() mirrors bare
// `waybackify`).
//
// SURFACE v2 (#386): `manifest` means GENERATION (source + universe [+ seen]
// → wayback.json), `rewrite` means APPLICATION (source + manifest → the
// published form), `ledger` means the COLLECTION (discovery / --flatten /
// --against worklists). The v1 per-file markdown-extraction `manifest`
// command and its `--ledger` flag are deleted — their meanings were exactly
// inverted from the settled vocabulary (a wayback.json IS a manifest; the
// ledger is the collection); this surface is the deliberate, snapshot-pinned
// break that kills the confusion.
//
// Thin-CLI rule (hard constraint): this package is argv parsing
// (paparam), output formatting, and exit codes. All plumbing lands in
// spv/waybackify (the library). This module imports NOTHING from it yet.
//
// ---------------------------------------------------------------------------
// paparam (v1.10.1) — source-driven notes
// ---------------------------------------------------------------------------
// Everything below is verified against the official README
// (https://github.com/holepunchto/paparam#readme, read at paparam@1.10.1)
// and, where the README is silent, against the shipped source
// (node_modules/paparam/index.js @1.10.1). Load-bearing facts:
//
//  1. STRICT BY DEFAULT. Commands reject unknown flags (bail reason
//     UNKNOWN_FLAG) and unexpected positionals (UNKNOWN_ARG) unless
//     `sloppy()` is applied — README: "### sloppy(opts) — Configures the
//     command to be non-strict when parsing unknown flags or arguments"
//     (https://github.com/holepunchto/paparam#sloppyopts); source:
//     `_strictFlags = true` / `_strictArgs = true` defaults (index.js:107-108),
//     UNKNOWN_FLAG bail at index.js:499, UNKNOWN_ARG at index.js:568.
//  2. THE DEFAULT BAIL THROWS. Without a `bail(fn)` modifier, a usage error
//     throws a Bail error instead of returning null (index.js:593-599 —
//     `_bail` walks the parent chain, then throws). A root-level `bail(fn)`
//     covers subcommand bails too, because `_bail` delegates upward
//     (index.js:594-595). README documents `bail(fn)` ("Set the bail handler
//     to fn", https://github.com/holepunchto/paparam#bailfn) and the
//     `cmd.bailed` shape `{ bail: { reason, flag, arg, err }, error?, output? }`
//     (https://github.com/holepunchto/paparam#cmdbailed-object--null).
//  3. HELP RETURNS NULL. `parse()` auto-handles -h/--help: it prints
//     `cmd.help()` via console.log and returns null (README:
//     https://github.com/holepunchto/paparam#cmdparseargv--processargvslice2-opts,
//     "Automatically handles '--help' or '-h' flags"; source index.js:246-249).
//     So a null parse result is EITHER help-shown (success) or a usage bail —
//     run() disambiguates via the bail handler having fired.
//  4. MISSING_ARG IS ROOT-ONLY. parse() enforces required args against
//     `this._definedArgs` — the command parse() was CALLED on, not the
//     subcommand that matched (index.js:236-243, `this` vs `c`). The README
//     does not document this. Consequence: each subcommand enforces its own
//     required positional via `validate()` (README:
//     https://github.com/holepunchto/paparam#validatevalidator-description);
//     validator bails carry err.code === 'ERR_INVALID' (index.js:873-875).
//  5. `--no-<name>` INVERSION. The parser treats a `--no-` prefix as an
//     inverse write to flag `<name>` (index.js:63-66), and a flag DEFINED as
//     `--no-requisites` registers under the name `requisites` with default
//     value `true` (parseFlag, index.js:793-799: `value = inverse`). So
//     `flags.requisites` is true by default and false when --no-requisites
//     is passed — exactly the cache command's requisites-by-default
//     semantics. UNVERIFIED
//     in the README (undocumented behavior); verified against the 1.10.1
//     source and pinned by test/cli.test.js so an upgrade that changes it
//     fails loudly.
//  6. RUNNERS ARE ASYNC BY DEFAULT. parse() sets `cmd.running` to a promise
//     (README: https://github.com/holepunchto/paparam#cmdrunning-promise--null);
//     a throwing runner is caught and routed through the SAME bail path with
//     `bail.err` set (index.js:900-914). paparam never calls process.exit —
//     exit codes are entirely this module's job.
//
// ---------------------------------------------------------------------------
// Exit-code convention (documented in README.md)
// ---------------------------------------------------------------------------
//   0   success (and --help)
//   1   domain failure (bad verdict, not found, fetch failure)
//   2   usage error (unknown flag/arg, missing required arg/flag)
//   3   check only: suspect verdict (nonzero on purpose, distinct from 1)
//   70  a command handler is missing from the bin wiring — DEFENSIVE ONLY
//       now that every handler is wired; should never be observable.
//       70 is BSD sysexits EX_SOFTWARE ("internal software error") — see
//       https://man.freebsd.org/cgi/man.cgi?query=sysexits (EX_SOFTWARE 70).

import { arg, bail, command, description, flag, footer, rest, summary, validate } from 'paparam';
import { configureLogging } from './logger.js';

// Logging-flag parsing + logger construction live together in ./logger.js
// (parseLoggingFlags → configureLogging) so the whole flag/env→logger mapping
// has one home; run() below makes a single configureLogging() call.

export const EXIT = {
  OK: 0,
  DOMAIN: 1,
  USAGE: 2,
  // `check`'s suspect verdict: nonzero ON PURPOSE (conservative composition),
  // yet distinct from DOMAIN so a pipeline can tell "confidently junk" from
  // "a human should look". A handler requests a specific code by throwing an
  // error carrying `.exitCode` (honored in run()'s bail handler below).
  SUSPECT: 3,
  NOT_IMPLEMENTED: 70
};

/** Thrown when a command handler is missing from the injected set (defensive). */
export class NotImplementedError extends Error {
  code = 'ERR_NOT_IMPLEMENTED';
  constructor(commandName) {
    super(`waybackify ${commandName}: not implemented (handler pending)`);
    this.name = 'NotImplementedError';
  }
}

const notImplemented = name => () => {
  throw new NotImplementedError(name);
};

/**
 * Build the full waybackify command tree.
 *
 * Command descriptions are part of the pinned CLI contract — do not reword
 * casually; the help snapshots exist to catch drift.
 *
 * @param {Object} [options]
 * @param {Object} [options.handlers] - Per-command runners, injected by the
 *   per-command implementations (and by tests). Each receives paparam's runner
 *   payload `{ args, flags, positionals, rest, indices, argv, command }`.
 *   Missing handlers throw NotImplementedError (exit 70).
 * @param {Function} [options.onBail] - Observer for every bail (usage errors
 *   AND runner throws — see note 2 above). Receives paparam's bail object
 *   `{ command, reason, flag, arg, err }`. Returns the bail output string.
 * @returns {import('paparam').Command} root command
 */
export function createCLI({ handlers = {}, onBail } = {}) {
  const check = command(
    'check',
    summary('Full wayback-404 verdict for the exact capture'),
    description(
      'Full wayback-404 verdict for the exact capture: CDX statuscode +\n' +
        'soft-404 content heuristics on the replay body — the corpus audit\n' +
        'primitive.\n' +
        '\n' +
        'Output: JSON verdict on stdout\n' +
        '({verdict: good|wayback404|suspect, statuscode, reason, snippet});\n' +
        'exit 0 = verified good, nonzero = bad/suspect.'
    ),
    arg('<wayback-url>', 'full web.archive.org/web/<timestamp>/<original> replay URL'),
    // Required-arg enforcement is per-subcommand via validate() — see
    // source-driven note 4 (MISSING_ARG is root-only in paparam 1.10.1).
    validate(({ args }) => Boolean(args.waybackUrl), 'missing required argument: <wayback-url>'),
    handlers.check ?? notImplemented('check')
  );

  const search = command(
    'search',
    summary('CDX capture query — re-pick a better capture'),
    description(
      "CDX capture query (the library's getSnapshot/getSnapshots face) — for\n" +
        're-picking a better capture when check flags one bad. No\n' +
        'date-anchoring cleverness: --near passes through, default is\n' +
        "CDX's own ordering.\n" +
        '\n' +
        'Output: JSONL, {timestamp, statuscode, mimetype, waybackUrl} per\n' +
        'capture.'
    ),
    arg('<original-url>', 'the archived-site URL to query captures of'),
    flag('--near <ts>', 'preferred timestamp (YYYYMMDD[HHMMSS]); passed through to CDX'),
    flag('--limit <n>', 'maximum captures to emit'),
    validate(({ args }) => Boolean(args.originalUrl), 'missing required argument: <original-url>'),
    handlers.search ?? notImplemented('search')
  );

  // paparam derives the parsed-arg name from the FIRST [a-zA-Z0-9-]+ run in
  // the spec (snakeToCamel, index.js:772-778 @1.10.1), so `<source.md>` lands
  // on args.source — the `.md` is help-text only.
  const manifest = command(
    'manifest',
    summary('Generate the manifest for one markdown source'),
    description(
      'Generate the manifest (wayback.json) for one markdown source: extract\n' +
        'its live links, bake the Universe subset (compile-time policy), copy\n' +
        'verdicts from the seen union file, and resolve only never-seen urls\n' +
        'against the archive. Idempotent: a rerun with the same seen file\n' +
        'makes zero network calls and writes byte-identical output.\n' +
        '\n' +
        'Output: canonical manifest at -o; the seen file (read-write)\n' +
        'extended with this run\'s verdicts; one JSON stats line on stdout.\n' +
        'Unresolved urls defer — exit 1, rerun to resume.'
    ),
    arg('<source.md>', 'markdown source file (pristine, live-link form)'),
    flag('--universe|-u <file>', 'Universe file (rewrites + excludes policy) — required'),
    flag('--seen|-s <file>', 'Manifest-shaped resolution union, read-write (bootstrap: ledger --flatten)'),
    flag('--output|-o <file>', 'manifest destination (wayback.json) — required'),
    flag('--offline', 'fail on urls the universe and seen file cannot answer (zero network)'),
    flag('--near <ts>', 'preferred capture timestamp (YYYYMMDD[HHMMSS]) — resolve never-seen urls to the archive capture closest to it'),
    validate(({ args }) => Boolean(args.source), 'missing required argument: <source.md>'),
    validate(({ flags }) => Boolean(flags.universe), 'missing required flag: --universe|-u <file>'),
    validate(({ flags }) => Boolean(flags.output), 'missing required flag: --output|-o <file>'),
    // paparam does not type flags — --near arrives as a string. The library's
    // window()/getSnapshot slice it as YYYYMMDD[HHMMSS] and pad to 14, so a
    // non-timestamp value would silently become NaN; reject it here (usage
    // error, exit 2) rather than let it corrupt the capture pick.
    validate(
      ({ flags }) => flags.near === undefined || /^(\d{8}|\d{14})$/.test(flags.near),
      '--near must be a YYYYMMDD or YYYYMMDDHHMMSS timestamp (8 or 14 digits)'
    ),
    handlers.manifest ?? notImplemented('manifest')
  );

  const rewrite = command(
    'rewrite',
    summary('Apply a manifest to a markdown source'),
    description(
      'Apply a manifest to a markdown source: rewrite each live link per\n' +
        'the manifest, precedence exclude → rewrites → entries → untouched +\n' +
        'warn. Fenced code and link text are never touched; already-archived\n' +
        'links pass through. A resolved archive link is pointed at the chrome\n' +
        'host (default wayback.example.com, --chrome-host to override), never\n' +
        'top-level at live web.archive.org.\n' +
        '\n' +
        'Output: the published form written to -o. A url the manifest holds\n' +
        'no verdict for warns on stderr and exits 1 — surfaced, never\n' +
        'guessed at.'
    ),
    arg('<source.md>', 'markdown source file (pristine, live-link form)'),
    flag('--manifest|-m <file>', 'manifest to apply (wayback.json) — required'),
    flag('--output|-o <file>', 'destination for the rewritten markdown — required'),
    flag('--chrome-host <host>', 'chrome FQDN archived links point at (default wayback.example.com)'),
    validate(({ args }) => Boolean(args.source), 'missing required argument: <source.md>'),
    validate(({ flags }) => Boolean(flags.manifest), 'missing required flag: --manifest|-m <file>'),
    validate(({ flags }) => Boolean(flags.output), 'missing required flag: --output|-o <file>'),
    handlers.rewrite ?? notImplemented('rewrite')
  );

  const ledger = command(
    'ledger',
    summary('Survey the manifests under a tree'),
    description(
      'Survey the ledger — every wayback.json manifest under <dir>, file\n' +
        'paths as identity. Default: one JSONL row per manifest with section\n' +
        'counts. --flatten: union the ledger into ONE canonical manifest on\n' +
        'stdout (the seen-file bootstrap for manifest). --against: join the\n' +
        'ledger against a cache root, one JSONL row per referenced capture,\n' +
        'classified unfetched | cached | interstitial | error.'
    ),
    arg('<dir>', 'root to discover wayback.json manifests under'),
    flag('--flatten', 'print the union manifest (canonical JSON) instead of rows'),
    flag('--root|-r <root>', 'classify referenced captures against this cache root'),
    flag('--against <root>', 'deprecated alias of --root|-r'),
    validate(({ args }) => Boolean(args.dir), 'missing required argument: <dir>'),
    validate(
      ({ flags }) => !(flags.flatten && (flags.root || flags.against)),
      '--flatten and --root are mutually exclusive'
    ),
    handlers.ledger ?? notImplemented('ledger')
  );

  // ---- cache: the cache-store command group --------------------------------
  // add · fill · verify. Each subcommand enforces its own required args/flags
  // via validate() (MISSING_ARG is root-only — note 4).

  const cacheAdd = command(
    'add',
    summary('Fetch one capture into a local bucket image'),
    description(
      'Fetch one capture into a local bucket image at <root> — the\n' +
        "wayback mirror's population path. Syncing that dir to\n" +
        'R2 / Fastly KV (rclone/wrangler/fastly tooling) IS deployment.\n' +
        '\n' +
        'Output: files written under the shared key scheme; summary line on\n' +
        'stdout.'
    ),
    arg('<wayback-url>', 'full web.archive.org/web/<timestamp>/<original> replay URL'),
    flag('--root|-r <root>', 'cache root directory (the local bucket image) — required'),
    flag('--output|-o <root>', 'deprecated alias of --root|-r'),
    // Defined as `--no-requisites` so paparam registers flag `requisites`
    // defaulting to TRUE (requisites-by-default) — source-driven note 5.
    flag(
      '--no-requisites',
      'store only the named capture; skip its im_/cs_/js_/oe_ page requisites'
    ),
    validate(({ args }) => Boolean(args.waybackUrl), 'missing required argument: <wayback-url>'),
    validate(({ flags }) => Boolean(flags.root || flags.output), 'missing required flag: --root|-r <root>'),
    handlers.cacheAdd ?? notImplemented('cache add')
  );

  const cacheFill = command(
    'fill',
    summary('Fetch every capture a ledger references into a cache root'),
    description(
      'Drive a cache root to a COMPLETE asset closure of every capture the\n' +
        'ledger under <dir> references — each referenced page AND its\n' +
        'requisites (im_/cs_/js_/oe_). The bulk, resumable form of `cache add` —\n' +
        'the whole-corpus population path (wrap it in a thin repo shim).\n' +
        '\n' +
        'A durable worklist (never-fetched + not-yet-closed captures) is\n' +
        'enumerated ONCE and reused across runs, so pacing and resume\n' +
        'accumulate. Transient archive.org trouble DEFERS a capture (retried\n' +
        'next run); a run of connection failures ABORTS (archive.org down);\n' +
        'a 404 is recorded gone and never retried. Killable + resumable — the\n' +
        'cache root is the done-truth; re-run to finish.\n' +
        '\n' +
        'Output: progress on stderr; one JSON summary line on stdout. Exit 0\n' +
        'normal (deferrals expected — re-run to converge), 1 on abort\n' +
        '(archive.org unreachable — the mirror is incomplete, re-run).'
    ),
    arg('<dir>', 'root to discover wayback.json manifests under'),
    flag('--root|-r <root>', 'cache root to populate + measure closure against — required'),
    flag('--delay-ms <n>', 'pacing between captures — a page + its requisites fetch together, browser-style (default 1500)'),
    flag('--abort-after <n>', 'consecutive connection failures before aborting (default 5)'),
    flag('--max <n>', 'cap captures fetched this run, then exit (default: no cap)'),
    flag('--refresh', 'rebuild the worklist from a fresh enumerate (default: reuse)'),
    flag('--dry-run', 'build/show the worklist; fetch nothing'),
    validate(({ args }) => Boolean(args.dir), 'missing required argument: <dir>'),
    validate(({ flags }) => Boolean(flags.root), 'missing required flag: --root|-r <root>'),
    // paparam does not type flags — they arrive as strings. Reject a non-numeric
    // or negative pacing/abort/cap here (usage error, exit 2) rather than let a
    // typo like `--delay-ms 1,500` become NaN and silently disable pacing.
    validate(
      ({ flags }) =>
        ['delayMs', 'abortAfter', 'max'].every(k => {
          if (flags[k] === undefined) return true;
          const n = Number(flags[k]);
          return Number.isFinite(n) && n >= 0;
        }),
      '--delay-ms, --abort-after, and --max must be non-negative numbers'
    ),
    handlers.cacheFill ?? notImplemented('cache fill')
  );

  const cacheCrawl = command(
    'crawl',
    summary('Crawl documents to a dynamic-completeness fixpoint'),
    description(
      'Drive the `remaster verify` DYNAMIC probe to a fixpoint over documents in\n' +
        'a cache root: render each through a strict server with non-local origins\n' +
        'abort-routed, record the browser-discovered dynamic[] requisites it still\n' +
        'reaches for, fetch them, and re-render — until a render makes zero\n' +
        'unexpected web.archive.org requests (or --max-iterations is hit). The\n' +
        'completeness pass behind the standalone tier.\n' +
        '\n' +
        'Pass replay URLs as trailing positionals (give FLAGS FIRST; a flag after\n' +
        'a URL is rejected, never swallowed) and/or --ledger <dir> to crawl every\n' +
        'HTML document under it. Needs agent-browser only when there is uncached\n' +
        'work to probe (the verified fast-path is free); --static-only skips the\n' +
        'browser entirely (LOUD: completeness is NOT verified).\n' +
        '\n' +
        'Output: a JSON run summary on stdout, progress on stderr. Exit 0 = every\n' +
        'doc verified (or nothing to do), 1 = any flaky/unconverged/errored.'
    ),
    arg('[wayback-url]', 'a web.archive.org/web/<ts>/<orig> replay URL to crawl (repeatable — put all flags first)'),
    rest('[wayback-url...]', 'additional replay URLs (every trailing positional)'),
    flag('--root|-r <root>', 'cache root to crawl (already holds the docs) — required'),
    flag('--output|-o <root>', 'deprecated alias of --root|-r'),
    flag('--ledger <dir>', 'corpus batch: also crawl every HTML document under <dir>'),
    flag('--max-iterations <n>', 'reference-depth cap per doc (default 4)'),
    flag('--force', 're-probe docs already stamped verified'),
    flag('--static-only', 'skip the browser probe; close ALREADY-recorded dynamic[] only (LOUD: completeness NOT verified)'),
    flag('--dry-run', 'enumerate the recorded frontier (requisites ∪ dynamic) and report what a run would fetch; touch nothing'),
    flag('--allow-escapes <file>', 'allowed-escapes policy override (default: the committed policy)'),
    flag('--max <n>', 'archive.org request cap for this run (default: unlimited)'),
    flag('--delay-ms <n>', 'pacing between captures that hit archive.org (default 1500; already-complete docs are not paced)'),
    flag('--timeout <n>', 'per-request archive.org timeout in ms (default 20000; a dead host hangs this long before failing)'),
    flag('--har', 'write per-doc request logs to <root>/.crawl/har/'),
    flag('--browser-cmd <cmd>', 'the agent-browser executable (default: agent-browser)'),
    validate(({ flags }) => Boolean(flags.root || flags.output), 'missing required flag: --root|-r <root>'),
    // paparam does not type flags — they arrive as strings. Reject a non-integer,
    // negative, or Infinity-shaped value here (usage error, exit 2). Number('Infinity')
    // is finite-LOOKING, so isSafeInteger (not a bare NaN check) is what keeps
    // `--max Infinity` from removing the only termination bound.
    validate(
      ({ flags }) =>
        ['maxIterations', 'delayMs', 'max'].every(k => {
          if (flags[k] === undefined) return true;
          const n = Number(flags[k]);
          return Number.isSafeInteger(n) && n >= 0;
        }),
      '--max-iterations, --delay-ms, and --max must be non-negative integers'
    ),
    handlers.cacheCrawl ?? notImplemented('cache crawl')
  );

  const cacheVerify = command(
    'verify',
    summary('Verify a cache root against its own sidecars'),
    description(
      'Verify a populated cache root against its own sidecars: re-hash every\n' +
        'body, re-derive every path, and flag the shapes a crash, a bit-flip,\n' +
        'or a short fetch leaves behind — including a page whose requisite\n' +
        'closure is incomplete (a referenced im_/cs_/js_/oe_ capture with no\n' +
        'sidecar in this store). Report-only by default.\n' +
        '\n' +
        'Output: a per-category report on stdout (--json for the raw report).\n' +
        'Exit 0 when the store is clean (or made clean by --fix), 1 when any\n' +
        'discrepancy remains.'
    ),
    flag('--root|-r <root>', 'cache root to verify (contains cap/ meta/ tmp/) — required'),
    flag('--fix', 'reap orphan cap/ files + stale tmp/ scratch (opt-in); never touches corruption or a short closure'),
    flag('--json', 'emit the raw report as JSON (for tooling/checkpoints)'),
    flag('--quiet', 'suppress the per-category "ok" lines'),
    validate(({ flags }) => Boolean(flags.root), 'missing required flag: --root|-r <root>'),
    handlers.cacheVerify ?? notImplemented('cache verify')
  );

  const cache = command(
    'cache',
    summary('Cache-store ops: add · fill · crawl · verify'),
    description(
      'The cache-store command group — populate, complete, and verify the\n' +
        'hermetic wayback cache image (the archive of record):\n' +
        '\n' +
        '  add       fetch ONE capture (+ its requisites) into a cache root\n' +
        '  fill      drive a whole ledger to full asset closure (bulk, resumable)\n' +
        '  crawl     drive documents to a dynamic-completeness fixpoint (browser)\n' +
        '  verify    check a cache root against its own sidecars (fsck)\n' +
        '\n' +
        'The remastered standalone tier lives under `remaster` and the bucket\n' +
        'projection under `bucket`.\n' +
        '\n' +
        'Run `waybackify cache <verb> --help` for a verb\'s full surface.'
    ),
    // Footer BEFORE the subcommands: paparam's _addCommand copies the parent's
    // footer onto a child only if the child has none YET, and root's footer
    // never re-propagates down to the group's children. Set it here so each
    // `cache <verb> --help` prints the same footer the flat verbs do — and so
    // the live output matches root.help('cache', verb).
    footer('part of the wayback mirror tooling'),
    cacheAdd,
    cacheFill,
    cacheCrawl,
    cacheVerify
  );

  // ---- remaster: the standalone-tier command group -------------------------
  // build · verify. `build` produces a standalone remastered root; `verify`
  // proves it stands alone (delegating to spv/waybackify-crawl).

  const remasterBuild = command(
    'build',
    summary('Remaster a hermetic cache root into a standalone root'),
    description(
      'Remaster a hermetic cache root into a standalone remastered root —\n' +
        'chrome stripped, wayback references localized to /web/<ts><flag>/<orig>,\n' +
        'sidecars carried over, a content-addressed build record written at the\n' +
        'root. Deterministic: the same hermetic tree yields a byte-identical\n' +
        'remastered tree.\n' +
        '\n' +
        'Output: a summary line on stdout (--json for the run record). The\n' +
        'remastered root drops straight under a waybackify-serve --root.'
    ),
    arg('<hermetic-root>', 'sealed cache root to read (contains cap/ meta/)'),
    arg('<remastered-root>', 'output root to write (created; supply a fresh dir)'),
    flag('--json', 'emit the run summary as JSON'),
    validate(({ args }) => Boolean(args.hermeticRoot), 'missing required argument: <hermetic-root>'),
    validate(({ args }) => Boolean(args.remasteredRoot), 'missing required argument: <remastered-root>'),
    handlers.remasterBuild ?? notImplemented('remaster build')
  );

  const remasterVerify = command(
    'verify',
    summary('Prove a remastered tree stands alone (no archive.org)'),
    description(
      'Validate a remastered root, read-only, in two tiers. STATIC (always):\n' +
        'scan every text body for web.archive.org / archive.org / absolute\n' +
        'wayback-shaped escapes (zero allowlist), and check determinism — every\n' +
        'body hashes to its build-record outputHash, and (given --hermetic) a\n' +
        'fresh rebuild reproduces the committed build record byte-for-byte.\n' +
        'DYNAMIC (--tier dynamic, requires agent-browser): render documents\n' +
        'through a strict server with non-local origins abort-routed — a\n' +
        'document passes iff it made zero non-local requests, raised zero CSP\n' +
        'violations, and every local ref resolves in the corpus.\n' +
        '\n' +
        'Output: a per-tier report on stdout (--json for the raw report). Exit\n' +
        '0 clean, 1 on any finding.'
    ),
    flag('--root|-r <root>', 'the remastered tree to validate (cap/ + meta/ + remaster.build.json) — required'),
    flag('--hermetic <root>', 'the sealed source, for the determinism rebuild (else reproducibility is skipped)'),
    flag('--tier <list>', 'comma list of {static,dynamic}; default static'),
    flag('--sample <n>', 'dynamic tier: render only the first N HTML documents'),
    flag('--no-determinism', 'skip the rebuild half of the static determinism check'),
    flag('--json', 'emit the raw report as JSON'),
    flag('--out <path>', 'also write the report to this file'),
    validate(({ flags }) => Boolean(flags.root), 'missing required flag: --root|-r <root>'),
    handlers.remasterVerify ?? notImplemented('remaster verify')
  );

  const remaster = command(
    'remaster',
    summary('Standalone-tier ops: build · verify'),
    description(
      'The remastered standalone tier — the served form that carries NONE of\n' +
        'archive.org and needs nothing off-host to render:\n' +
        '\n' +
        '  build     remaster a hermetic cache root into a standalone tree\n' +
        '  verify    prove a remastered tree stands alone (static + dynamic)\n' +
        '\n' +
        'Run `waybackify remaster <verb> --help` for a verb\'s full surface.'
    ),
    footer('part of the wayback mirror tooling'),
    remasterBuild,
    remasterVerify
  );

  // ---- bucket: the object-store projection command group -------------------
  // push · verify. `push` emits the population batch; `verify` proves a remote
  // bucket is a byte-for-byte projection of a cache root (over waybackify-serve).

  const bucketPush = command(
    'push',
    summary('Emit the bucket-population batch for a cache root'),
    description(
      'Walk a cache root and emit one `s5cmd run` cp line per entry — the\n' +
        'cap/ half of projecting the store onto an R2 / Fastly bucket, ready\n' +
        'to pipe: `waybackify bucket push … | s5cmd --endpoint-url <ep> run`.\n' +
        'Never mutates anything, never talks to the network.\n' +
        '\n' +
        'Output: the batch lines on stdout, a summary on stderr. --dry-run\n' +
        'writes the batch to stderr instead, so an accidental `| s5cmd run`\n' +
        'is a no-op.'
    ),
    flag('--root|-r <root>', 'cache root (the archive of record) — required'),
    flag('--bucket <name>', "target bucket ('name' or 's3://name[/prefix]') — required"),
    flag('--empty-file <path>', 'zero-byte scratch file for bodiless entries (create it OUTSIDE the root)'),
    flag('--dry-run', 'write the batch to stderr; emit NOTHING to stdout'),
    validate(({ flags }) => Boolean(flags.root), 'missing required flag: --root|-r <root>'),
    validate(({ flags }) => Boolean(flags.bucket), 'missing required flag: --bucket <name>'),
    handlers.bucketPush ?? notImplemented('bucket push')
  );

  const bucketVerify = command(
    'verify',
    summary('Verify a bucket is a byte-for-byte projection of a root'),
    description(
      'Prove a remote S3-compatible bucket serves identical content to a local\n' +
        'cache root, in up to four layers: count parity per prefix, a full\n' +
        'metadata sweep (HEAD every cap/), full body verification (GET + rehash\n' +
        'every status:body), and serving parity sampled through the serve\n' +
        'router. Reads through the same store the server serves from.\n' +
        '\n' +
        'Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the\n' +
        'environment, never flags. Output: a per-layer report on stdout (--json\n' +
        'for the raw report). Exit 0 all layers pass, 1 on any mismatch.'
    ),
    flag('--root|-r <root>', 'local cache root — the archive of record — required'),
    flag('--bucket <name>', 'target bucket name — required'),
    flag('--endpoint <url>', 'S3-compatible base endpoint (e.g. https://<acct>.r2.cloudflarestorage.com) — required'),
    flag('--region <r>', 'signing region (default auto — right for R2)'),
    flag('--prefix <p>', 'key prefix within the bucket'),
    flag('--sample <n>', 'Layer 4 sample size per status class (default 3)'),
    flag('--layer <list>', 'comma list of layers 1–4 to run (default all)'),
    flag('--concurrency <n>', 'in-flight HEAD/GET cap for Layers 2–3 (default 16)'),
    flag('--json', 'emit the raw report as JSON'),
    flag('--out <path>', 'also write the report to this file'),
    validate(({ flags }) => Boolean(flags.root), 'missing required flag: --root|-r <root>'),
    validate(({ flags }) => Boolean(flags.bucket), 'missing required flag: --bucket <name>'),
    validate(({ flags }) => Boolean(flags.endpoint), 'missing required flag: --endpoint <url>'),
    handlers.bucketVerify ?? notImplemented('bucket verify')
  );

  const bucket = command(
    'bucket',
    summary('Bucket-projection ops: push · verify'),
    description(
      'The object-store projection tier — project the cache root onto a remote\n' +
        'R2 / Fastly bucket and prove the projection is faithful:\n' +
        '\n' +
        '  push      emit the bucket-population batch (cap/ objects) for a root\n' +
        '  verify    prove a bucket is a byte-for-byte projection of a root\n' +
        '\n' +
        'Run `waybackify bucket <verb> --help` for a verb\'s full surface.'
    ),
    footer('part of the wayback mirror tooling'),
    bucketPush,
    bucketVerify
  );

  const audit = command(
    'audit',
    summary('Checkpointed wayback-404 audit of a ledger'),
    description(
      'Audit every capture the ledger under <dir> references — a checkpointed,\n' +
        'resumable wayback-404 sweep. Captures are discovered via generic ledger\n' +
        'discovery (the same corpus-agnostic frontier `cache fill` uses), then\n' +
        'each UNIQUE capture is run through the verdict engine and its result\n' +
        'appended to a JSONL checkpoint. Re-running skips checkpointed captures,\n' +
        'so an interrupted run (archive.org throttling, ^C) resumes.\n' +
        '\n' +
        'Slow, network-heavy, human-supervised: it refuses to run under CI.\n' +
        'Output: progress on stderr, a verdict summary on stdout.'
    ),
    arg('<dir>', 'root to discover wayback.json manifests under'),
    flag('--checkpoint <file>', 'JSONL checkpoint file (resume/skip) — default <dir>/.audit/checkpoint.jsonl'),
    flag('--limit <n>', 'audit only the FIRST n unique captures, sorted by capture key'),
    flag('--delay-ms <n>', 'pause between captures (default 500)'),
    flag('--timeout <n>', 'per-request timeout in ms (default 60000)'),
    flag('--report <file>', 'also write the summary as JSON'),
    validate(({ args }) => Boolean(args.dir), 'missing required argument: <dir>'),
    validate(
      ({ flags }) =>
        ['limit', 'delayMs', 'timeout'].every(k => {
          if (flags[k] === undefined) return true;
          const n = Number(flags[k]);
          return Number.isFinite(n) && n >= 0;
        }),
      '--limit, --delay-ms, and --timeout must be non-negative numbers'
    ),
    handlers.audit ?? notImplemented('audit')
  );

  const root = command(
    'waybackify',
    summary('manifest / rewrite / ledger / check / search / audit + the cache · remaster · bucket store groups over the spv/waybackify library'),
    description(
      'Human-operable, xargs-composable front door over spv/waybackify:\n' +
        'generate a manifest for a source file, rewrite it to its published\n' +
        'form, survey the ledger of manifests under a tree, hand-check a\n' +
        'capture, re-pick a better one, run a checkpointed corpus audit, and —\n' +
        'under the `cache` / `remaster` / `bucket` groups — populate, verify,\n' +
        'remaster, and project the wayback mirror image.\n' +
        '\n' +
        'Exit codes: 0 success · 1 domain failure (bad verdict / not found) ·\n' +
        '2 usage error · 3 suspect verdict (check only).'
    ),
    footer('part of the wayback mirror tooling'),
    manifest,
    rewrite,
    ledger,
    check,
    search,
    audit,
    cache,
    remaster,
    bucket
  );

  // One bail handler at the root covers every subcommand (source-driven
  // note 2: _bail delegates up the parent chain). Installing it also switches
  // paparam from throw-on-bail to record-on-bail, which is what lets run()
  // turn usage errors into exit 2 instead of a stack trace.
  if (onBail) root.add(bail(onBail));

  return root;
}

/**
 * Parse argv, dispatch, and map the outcome to an exit code.
 *
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @param {Object} [options]
 * @param {Object} [options.handlers] - see createCLI
 * @param {Function} [options.error] - run()'s OWN stderr sink for usage/bail
 *   messages (default console.error) — distinct from handler output.
 * @param {Object} [options.logger] - injected logger (tests); default: built
 *   from the argv logging flags (`-v`/`-vv`/`-q`/`--silent`/`--log-file`) +
 *   LOG_LEVEL.
 * @param {Function} [options.out] - injected STDOUT result sink (tests); default
 *   writes the line to fd 1. run() owns both output seams — `out` (the result,
 *   stdout) and `logger` (diagnostics, stderr) — and threads them into every
 *   handler's runner payload, so a handler never touches a global fd itself.
 * @returns {Promise<number>} exit code per the convention above
 */
export async function run(argv, {
  handlers = {},
  error = console.error,
  logger,
  out = line => process.stdout.write(line + '\n')
} = {}) {
  let exitCode = null;

  // Extract the logging knobs, build the logger, and hand paparam the REST of
  // argv (it is strict — an unknown `-v` would bail exit 2). configureLogging
  // owns the whole flag/env→logger mapping; an injected logger short-circuits.
  const { logger: diag, progressEvery, argv: commandArgv } = configureLogging(argv, { logger });

  // Fold run()'s output seams into every handler's runner payload: `out` (the
  // result → stdout) and `logger` (diagnostics → stderr / --log-file), plus the
  // progress throttle. paparam supplies args/flags; run() adds these — so ONE
  // injector owns where a command's output goes, and the handler just calls
  // out()/logger.* with no global-fd knowledge.
  const wiredHandlers = {};
  for (const [name, handler] of Object.entries(handlers)) {
    wiredHandlers[name] = payload => handler({ ...payload, logger: diag, out, progressEvery });
  }

  const root = createCLI({
    handlers: wiredHandlers,
    onBail(bailed) {
      // Classification (source-driven notes 2/4/6):
      //   bail.err with code ERR_NOT_IMPLEMENTED  → scaffold handler   → 70
      //   bail.err with code ERR_INVALID          → validate() failure → 2
      //   bail.err (anything else)                → runner threw       → 1
      //   no bail.err (UNKNOWN_FLAG/INVALID_FLAG/
      //                UNKNOWN_ARG/MISSING_ARG)   → parse-time usage   → 2
      const err = bailed.err;
      if (err?.code === 'ERR_NOT_IMPLEMENTED') {
        exitCode = EXIT.NOT_IMPLEMENTED;
        error(err.message);
        return err.message;
      }
      // A handler may request an explicit exit code (e.g. `check` maps its
      // suspect verdict to 3) by throwing an error carrying `.exitCode`.
      if (typeof err?.exitCode === 'number') {
        exitCode = err.exitCode;
        error(err.message);
        return err.message;
      }
      if (err && err.code !== 'ERR_INVALID') {
        exitCode = EXIT.DOMAIN;
        error(err.message ?? String(err));
        return err.message ?? String(err);
      }
      exitCode = EXIT.USAGE;
      const detail = bailed.flag
        ? `${bailed.reason}: ${bailed.flag.name}`
        : bailed.arg
          ? `${bailed.reason}: ${bailed.arg.value}`
          : err?.message ?? bailed.reason;
      const cmd = bailed.command;
      error(`waybackify: ${detail}`);
      error(cmd.usage().trimEnd());
      return detail;
    }
  });

  const parsed = root.parse(commandArgv);

  if (parsed === null) {
    // Either a usage bail (onBail fired, exitCode set) or --help was shown
    // (paparam printed help and returned null — source-driven note 3).
    return exitCode ?? EXIT.OK;
  }

  // A GROUP command matched with no subcommand — bare `waybackify` OR bare
  // `waybackify cache`. paparam runs the group's noop runner and returns the
  // group command itself (a leaf owns no subcommands, so `_definedCommands`
  // is the reliable discriminator). Treat as usage: print THAT group's own
  // help, exit 2.
  if (parsed._definedCommands.size > 0) {
    error(parsed.help().trimEnd());
    return EXIT.USAGE;
  }

  // Async runner: await completion; a throw routed through bail set exitCode
  // (source-driven note 6).
  if (parsed.running) await parsed.running;

  return exitCode ?? EXIT.OK;
}
