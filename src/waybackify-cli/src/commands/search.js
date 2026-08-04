// `waybackify search` handler — thin wiring over the library's multi-row CDX
// face, per the CLI's hard thin-wrapper rule: the query itself (retry/backoff,
// params, row decoding) is spv/waybackify's WaybackMachine#getSnapshots; this
// file translates the parsed argv payload into that call and emits one JSONL
// row per capture on stdout.
//
// Face choice (getSnapshot vs getSnapshots vs getCapture — see index.js):
// getSnapshots is the ONLY multi-row face, and it already returns
// {timestamp, statuscode, mimetype, waybackUrl, …} per capture — exactly the
// four fields the JSONL contract wants. getSnapshot collapses the history to
// the single near-anchored best pick (the date-anchoring cleverness search
// deliberately does NOT do — that lives in the project-side drivers);
// getCapture is an exact single-timestamp lookup.
//
// Semantics (decided upstream, not extended here): --near forwards verbatim
// into the query options; --limit caps the emitted rows; default is CDX's own
// ordering. No other query features.
//
// The library is imported lazily and by workspace-relative path (mirrors
// commands/cache-add.js) so merely loading the CLI surface never constructs a
// client.

/**
 * Build the search handler. Dependency-injectable for tests; the bin wires
 * the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.getSnapshots] - (url, opts) => Promise<capture[]>,
 *   the library's multi-row CDX face (WaybackMachine#getSnapshots). A rejected
 *   promise (network/CDX failure) propagates out and is turned into a domain
 *   exit (1) by the root bail handler.
 * @returns {Function} paparam runner: ({ args, flags, logger, out }) =>
 *   Promise<void>. `out` (stdout line sink, one JSONL row per capture) and
 *   `logger` are run()-wired into the payload.
 */
export function searchHandler(deps = {}) {
  return async ({ args, flags, logger, out = console.log }) => {
    let { getSnapshots } = deps;
    if (!getSnapshots) {
      const { WaybackMachine } = await import('@charlie.dev/waybackify');
      // baseUrl only shapes the emitted waybackUrl (the CDX host itself is
      // fixed inside the library); pin it to the canonical replay origin so
      // every row is a URL `waybackify check` can consume directly.
      const wayback = new WaybackMachine({ baseUrl: 'https://web.archive.org', logger });
      getSnapshots = (url, opts) => wayback.getSnapshots(url, opts);
    }

    // paparam hands flags through as strings; a missing --limit is undefined,
    // and Array#slice(0, undefined) keeps the whole list.
    const limit = flags.limit === undefined ? undefined : Number(flags.limit);

    // --near forwards verbatim into the query options; a rejection here
    // (network/CDX failure) propagates → domain exit 1 with the message on
    // stderr. Zero captures is NOT a failure: the loop emits nothing and the
    // runner returns → exit 0 with empty stdout (absence is an answer).
    const captures = await getSnapshots(args.originalUrl, { near: flags.near, limit });

    for (const c of captures.slice(0, limit)) {
      out(
        JSON.stringify({
          timestamp: c.timestamp,
          statuscode: c.statuscode,
          mimetype: c.mimetype,
          waybackUrl: c.waybackUrl
        })
      );
    }
  };
}
