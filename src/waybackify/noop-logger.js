// The no-op logger the library's modules default to. A LIBRARY never constructs
// pino (design §1) — every entry point accepts a duck-typed sink
// `{ trace, debug, info, warn, error, fatal }` (each `(mergeObj?, msg?) => void`,
// pino's signature) and defaults to this when the caller injects nothing, so a
// call site stays unconditional (`logger.warn(obj, msg)`), never a `?.`.
//
// Shared WITHIN this package (an intra-package import is not "a dependency"). The
// CLI and crawl packages keep their own copies deliberately — the "a little
// copying beats a little dependency" proverb is what keeps this OSS library from
// growing a cross-package coupling for six no-op methods.
export const NOOP_LOGGER = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
