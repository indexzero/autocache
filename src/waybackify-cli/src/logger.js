// The ONE place pino is constructed (design §3). Libraries never import this;
// they accept a duck-typed `{ trace, debug, info, warn, error, fatal }` sink
// (each `(mergeObj?, msg?) => void`) and default to a no-op. The CLI builds a
// real pino here, TTY-detects, and owns the stderr-not-stdout enforcement and
// the event→line rendering (§4).
//
// Construction is `pino.multistream` (in-process), NOT `pino.transport`
// (worker threads): a short-lived CLI must not inherit a worker's async
// flush-before-exit lifecycle. The file sink is a SYNC destination
// (`sync: true`) — at our volume (thousands of lines over minutes of network
// I/O) the cost is trivial and it needs zero exit choreography: every write is
// on disk before the call returns, so a `^C` or a normal exit loses nothing
// and there is no SIGINT/`pino.final` matrix to get wrong (design §7).
//
// The human stream is stderr, ALWAYS (design §7 / the stdout-is-data hazard):
// `bucket push` pipes its s5cmd batch on stdout and `check`/`--json` emit
// machine JSON there. pino defaults to fd 1 — overridden on every stream here.

import pino from 'pino';
import pretty from 'pino-pretty';

/* -------------------------------------------------------------------------- *
 * §4 request/response trace rendering (the load-bearing surface)
 *
 * Every field except the URL is static-padded to a constant width, and the URL
 * always trails, because a streaming logger cannot buffer to size columns
 * (`ls -l` / `git log` convention). The widths below reproduce the §4 mock
 * BYTE-FOR-BYTE — see logger.test.js, which pins the exact padded lines.
 * -------------------------------------------------------------------------- */

/** Two-digit zero-pad for the clock fields (module-scope: `hhmmss` runs per line). */
const pad2 = n => String(n).padStart(2, '0');

/** Local wall-clock `HH:MM:SS` from an epoch-ms `time` (what operators watch). */
export function hhmmss(time) {
  const d = time === undefined || time === null ? new Date() : new Date(time);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Human byte size: `14.2KB`, `3.1KB`, `0B`; `—` when bodiless (no number). */
export function humanBytes(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

/** Human duration: `412ms`, `1.4s`; `—` when there is no timing. */
export function humanMs(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** MIME → short display token (module-scope: a constant, and `normalizeType` runs per line). */
const MIME_TYPE_TOKENS = Object.freeze({
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/x-javascript': 'js',
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'application/json': 'json',
  'text/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/plain': 'txt'
});

/**
 * Short normalized content token, padded 5 in the line (`html`/`css`/`js`/
 * `gif`/`png`/`json`/`xml`/`txt`/`—`) — NOT the full MIME (that is unbounded
 * and lives only in the JSONL `contentType`). `—` for a bodiless/unknown reply.
 */
export function normalizeType(contentType) {
  if (!contentType || typeof contentType !== 'string') return '—';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return MIME_TYPE_TOKENS[mime] ?? '—';
}

/** Identity color set — used when no colorette `colors` is available (piped, tests). */
const NO_COLORS = null;

/** Pick the `<`-marker color by response status (severity carried by color, §4). */
function statusColor(log, colors) {
  if (!colors) return s => s;
  // ERR — a transport throw or a final give-up (no numeric status): red.
  if (log.error || log.outcome === 'failed' || typeof log.status !== 'number') {
    return colors.red;
  }
  // 2xx/3xx → green; 4xx terminal, 429 mid-retry, 5xx mid-retry → amber.
  return log.status >= 200 && log.status < 400 ? colors.green : colors.yellow;
}

/**
 * Render ONE request/response record to the §4 human line (WITHOUT the outer
 * reset — {@link traceMessageFormat} adds that). Pure and colors-injectable so
 * logger.test.js can assert the exact padded columns with `colors === null`.
 *
 * request:  `HH:MM:SS  > GET<pad>                    <url>`
 * response: `HH:MM:SS  < <status:3>  <bytes:>7>  <type:5> <ms:>6>  <url>  [note]`
 */
export function formatTrace(log, colors = NO_COLORS) {
  const time = hhmmss(log.time);
  if (log.evt === 'request') {
    const method = log.method ?? 'GET';
    // `> GET` … url aligned to the same column the response url lands on (30).
    const head = `> ${method}`.padEnd(30);
    return `${time}  ${head}${log.url}`;
  }
  // response (default)
  const isErr = log.error || log.status === null || log.status === undefined;
  const status = isErr ? 'ERR' : String(log.status);
  const bytes = humanBytes(log.bytes);
  const type = normalizeType(log.contentType);
  const ms = humanMs(log.ms);
  const paint = statusColor(log, colors);
  const marker = paint('<');
  // Byte-for-byte the §4 mock: `< ` + status(3) + 2sp + bytes(>7) + 2sp +
  //   type(5<) + 1sp + ms(>6) + 2sp + url [+ 2sp + note].
  let line =
    `${time}  ${marker} ` +
    `${status.padEnd(3)}  ` +
    `${bytes.padStart(7)}  ` +
    `${type.padEnd(5)} ` +
    `${ms.padStart(6)}  ` +
    `${log.url}`;
  if (log.note) line += `  ${log.note}`;
  return line;
}

/**
 * pino-pretty `messageFormat` — routes request/response records through
 * {@link formatTrace}, and everything else to `HH:MM:SS  <msg>` (color by
 * level: warn amber, error/fatal red), so the firehose and the summaries share
 * one shape. The leading `\x1b[0m` defeats pino-pretty's cyan message-wrap so
 * ONLY our `<` marker (or a warn/error line) carries color.
 *
 * We terminate the line with `\n` OURSELVES. pino-pretty 13 uses a FUNCTION
 * messageFormat's return value verbatim as the whole rendered line and does NOT
 * append its own EOL (only the string/default form does) — so without this every
 * record concatenates onto the previous one on a TTY (`worklist…plan…cached…`).
 */
export function traceMessageFormat(log, messageKey, levelLabel, extra) {
  const colors = extra?.colors ?? NO_COLORS;
  const reset = colors ? '\x1b[0m' : '';
  if (log.evt === 'request' || log.evt === 'response') {
    return reset + formatTrace(log, colors) + '\n';
  }
  const time = hhmmss(log.time);
  const msg = log[messageKey] ?? '';
  let paint = s => s;
  if (colors) {
    if (log.level >= 50) paint = colors.red;
    else if (log.level >= 40) paint = colors.yellow;
  }
  return reset + `${time}  ${paint(msg)}` + '\n';
}

/**
 * Build the CLI's pino logger (design §3). `level` governs the HUMAN (stderr)
 * stream; the file stream, when present, always captures `trace` so the record
 * on disk holds more than the screen showed. `level: 'silent'` yields a logger
 * that emits nothing (satisfies the interface — `--silent`).
 *
 * @param {Object} [opts]
 * @param {string} [opts.logFile] - raw-NDJSON file sink (opt-in; `--log-file`)
 * @param {string} [opts.level] - human-stream level (default LOG_LEVEL ?? info)
 * @returns {import('pino').Logger}
 */
export function makeLogger({ logFile, level = process.env.LOG_LEVEL ?? 'info' } = {}) {
  if (level === 'silent') {
    return pino({ level: 'silent', base: undefined });
  }

  const streams = [];

  // Human stream → ALWAYS stderr (fd 2). Pretty (colored, §4) on a TTY; raw
  // NDJSON when piped/redirected (gate on process.stderr.isTTY, design §7).
  const humanStream = process.stderr.isTTY
    ? pretty({
        colorize: true,
        destination: 2,
        singleLine: true,
        hideObject: true,
        // Blank pino-pretty's own time+level tokens so `line` stays empty and
        // the message becomes the WHOLE line — no `[time]` brackets, no `:`
        // separator, no INFO/WARN label. We render the timestamp ourselves in
        // messageFormat (color carries severity, §4).
        customPrettifiers: { time: () => '', level: () => '' },
        messageFormat: traceMessageFormat
      })
    : process.stderr;
  streams.push({ level, stream: humanStream });

  // Record stream → raw NDJSON at `trace`, captures EVERYTHING regardless of
  // the terminal level. A SYNC destination — every line is on disk before the
  // write returns, so there is no exit-flush choreography (design §7).
  if (logFile) {
    const fileDest = pino.destination({ dest: logFile, mkdir: true, sync: true });
    streams.push({ level: 'trace', stream: fileDest });
  }

  // Root level = trace (the finest any stream wants) so records are NOT filtered
  // before the multistream fans them out; each stream applies its own level
  // (gotcha #1). `base: undefined` drops pid/hostname.
  return pino({ level: 'trace', base: undefined }, pino.multistream(streams));
}

/**
 * Pull the ORTHOGONAL logging knobs out of argv before paparam sees them (it is
 * strict and would reject unknown flags). None of these are used by any command
 * — they govern the diagnostic logger only, not command semantics (design §5):
 *
 *   -v / -vv (stackable)  → debug / trace
 *   -q                    → collapse the firehose, warn+ only
 *   --silent              → nothing
 *   --log-file <path>     → opt-in raw-NDJSON file sink
 *   --progress-every <n>  → silent-loop aggregate-progress throttle (§6)
 *
 * `--json` is deliberately NOT here — it governs stdout only and leaves the
 * logger running (design §5). LOG_LEVEL / WAYBACKIFY_PROGRESS_EVERY (env) are
 * the persistent defaults. This lives BESIDE makeLogger (not in cli.js) so the
 * whole flag/env→logger mapping has one home — see {@link configureLogging}.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env] - defaults to process.env
 * @returns {{ level: string|undefined, logFile: string|undefined, progressEvery: number, argv: string[] }}
 */
export function parseLoggingFlags(argv, env = process.env) {
  const out = [];
  let vCount = 0;
  let quiet = false;
  let silent = false;
  let logFile;
  let progressEveryFlag;
  let i = 0;
  // Consume the NEXT token as a flag value, but only if it exists and isn't
  // itself a flag (so a dangling/mis-ordered value flag never eats a real one).
  const takeValue = () => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) return undefined;
    i += 1;
    return next;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--silent') silent = true;
    else if (a === '-q') quiet = true;
    else if (/^-v+$/.test(a)) vCount += a.length - 1; // -v, -vv, -vvv…
    // Space-form value flags: only consume the next token when it is an actual
    // value (not another flag), so `--log-file --silent` doesn't swallow
    // `--silent` as a filename. A dangling value flag is simply ignored.
    else if (a === '--log-file') logFile = takeValue();
    else if (a.startsWith('--log-file=')) logFile = a.slice('--log-file='.length);
    else if (a === '--progress-every') progressEveryFlag = takeValue();
    else if (a.startsWith('--progress-every=')) progressEveryFlag = a.slice('--progress-every='.length);
    else out.push(a);
  }
  // Precedence: --silent > -q > -vv > -v > LOG_LEVEL/info (the last left to
  // makeLogger by returning `undefined`).
  const level = silent ? 'silent' : quiet ? 'warn' : vCount >= 2 ? 'trace' : vCount === 1 ? 'debug' : undefined;
  // Progress throttle: flag > env > default 500. Non-positive/NaN → 0 (off).
  const raw = progressEveryFlag ?? env.WAYBACKIFY_PROGRESS_EVERY ?? '500';
  const n = Number(raw);
  const progressEvery = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return { level, logFile, progressEvery, argv: out };
}

/**
 * The single entry the CLI calls to turn raw argv + env into a ready logger:
 * parse the knobs, apply the --silent > -q > -vv > -v > LOG_LEVEL precedence,
 * build the pino. logger.js owns the WHOLE flag/env→logger mapping, so run()
 * makes one call and no logging decision straddles the cli.js/logger.js
 * boundary. Returns the logger, the progress throttle, and argv with the
 * logging flags stripped (what paparam parses). An injected `logger` (tests)
 * short-circuits construction.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string|undefined>, logger?: object }} [opts]
 * @returns {{ logger: object, progressEvery: number, argv: string[] }}
 */
export function configureLogging(argv, { env = process.env, logger } = {}) {
  const { level, logFile, progressEvery, argv: commandArgv } = parseLoggingFlags(argv, env);
  return { logger: logger ?? makeLogger({ level, logFile }), progressEvery, argv: commandArgv };
}

/**
 * The no-op logger the libraries default to (they NEVER construct pino). Every
 * method is a no-op; it satisfies the injected-logger shape so a library call
 * site is unconditional (`logger.warn(obj, msg)`), never a `?.`.
 */
export const NOOP_LOGGER = Object.freeze({
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return NOOP_LOGGER;
  }
});
