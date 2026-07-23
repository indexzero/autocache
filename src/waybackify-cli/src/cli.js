// waybackify CLI surface.
//
// This module pins the ENTIRE command/option contract — names, args, flags,
// help text, exit codes — with ZERO implementation. All four command
// handlers (cache, check, search, manifest) are injected by the bin; a
// missing handler throws Not implemented (exit 70) as a defensive path.
// Implementations never touch argv parsing.
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
//       now that all four handlers are wired; should never be observable.
//       70 is BSD sysexits EX_SOFTWARE ("internal software error") — see
//       https://man.freebsd.org/cgi/man.cgi?query=sysexits (EX_SOFTWARE 70).

import { arg, bail, command, description, flag, footer, sloppy, summary, validate } from 'paparam';

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

  const manifest = command(
    'manifest',
    summary('Per-file enumeration of wayback refs'),
    description(
      'Per-file enumeration of wayback refs. Inline links only by default;\n' +
        '--ledger folds in the sibling wayback.json entries. Corpus scope is\n' +
        'deliberately NOT built in — that is\n' +
        '`find words -name index.md | xargs waybackify manifest`.\n' +
        '\n' +
        'Output: JSONL, {post, source: inline|ledger, timestamp, originalUrl,\n' +
        'waybackUrl}.'
    ),
    // paparam derives the parsed-arg name from the FIRST [a-zA-Z0-9-]+ run in
    // the spec (snakeToCamel, index.js:772-778 @1.10.1), so `<file.md>` lands
    // on args.file — the `.md` is help-text only.
    arg('<file.md>', 'markdown file to enumerate'),
    // Loose ARGS (but still-strict FLAGS) so an `xargs` batch works verbatim:
    // `find words -name index.md | xargs waybackify manifest` hands ONE
    // invocation many files, which strict args would reject (UNKNOWN_ARG —
    // note 1). sloppy({ args: true }) collects every positional into the
    // runner's `positionals`; sloppy({ flags: false }) keeps flags strict, so
    // an unknown flag still exits 2 AND --ledger still parses in any position
    // (unlike a `rest`, which would greedily swallow a trailing flag). The
    // required <file.md> is still enforced by the validate() below.
    sloppy({ flags: false, args: true }),
    flag('--ledger', 'also fold in the sibling wayback.json ledger entries'),
    validate(({ args }) => Boolean(args.file), 'missing required argument: <file.md>'),
    handlers.manifest ?? notImplemented('manifest')
  );

  const cache = command(
    'cache',
    summary('Fetch the capture into a local bucket image'),
    description(
      'Fetch the capture into a local bucket image at <root> — the\n' +
        "wayback.charlie.dev mirror's population path. Syncing that dir to\n" +
        'R2 / Fastly KV (rclone/wrangler/fastly tooling) IS deployment.\n' +
        '\n' +
        'Output: files written under the shared key scheme; summary line on\n' +
        'stdout.'
    ),
    arg('<wayback-url>', 'full web.archive.org/web/<timestamp>/<original> replay URL'),
    flag('--output|-o <root>', 'cache root directory (the local bucket image) — required'),
    // Defined as `--no-requisites` so paparam registers flag `requisites`
    // defaulting to TRUE (requisites-by-default) — source-driven note 5.
    flag(
      '--no-requisites',
      'store only the named capture; skip its im_/cs_/js_/oe_ page requisites'
    ),
    validate(({ args }) => Boolean(args.waybackUrl), 'missing required argument: <wayback-url>'),
    validate(({ flags }) => Boolean(flags.output), 'missing required flag: --output|-o <root>'),
    handlers.cache ?? notImplemented('cache')
  );

  const root = command(
    'waybackify',
    summary('check / search / manifest / cache over the spv/waybackify library'),
    description(
      'Human-operable, xargs-composable front door over spv/waybackify:\n' +
        'hand-check a capture, re-pick a better one, enumerate a file\'s wayback\n' +
        'refs, or populate the wayback.charlie.dev mirror.\n' +
        '\n' +
        'Exit codes: 0 success · 1 domain failure (bad verdict / not found) ·\n' +
        '2 usage error · 3 suspect verdict (check only).'
    ),
    footer('part of the wayback.charlie.dev mirror tooling'),
    check,
    search,
    manifest,
    cache
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
 * @param {Function} [options.error] - stderr line sink (default console.error)
 * @returns {Promise<number>} exit code per the convention above
 */
export async function run(argv, { handlers = {}, error = console.error } = {}) {
  let exitCode = null;

  const root = createCLI({
    handlers,
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

  const parsed = root.parse(argv);

  if (parsed === null) {
    // Either a usage bail (onBail fired, exitCode set) or --help was shown
    // (paparam printed help and returned null — source-driven note 3).
    return exitCode ?? EXIT.OK;
  }

  // Bare `waybackify` (no subcommand): paparam matches the root command and
  // runs its noop runner. Treat as usage: print help, exit 2.
  if (parsed === root) {
    error(root.help().trimEnd());
    return EXIT.USAGE;
  }

  // Async runner: await completion; a throw routed through bail set exitCode
  // (source-driven note 6).
  if (parsed.running) await parsed.running;

  return exitCode ?? EXIT.OK;
}
