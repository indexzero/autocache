// Silent-loop progress helpers (design §6). A long walk (remaster, fsck, bucket
// push over a 12k-entry corpus) runs dark without an emission hook; these own
// the two rules every such loop repeats — the "0 = off / non-positive → off"
// throttle coercion, and the modulo-throttled aggregate emit — so changing the
// throttle semantics is ONE edit, not four. The `evt` string and human message
// are the only per-loop variables, passed in.
//
// Shared WITHIN this package (an intra-package import is not "a dependency").

/**
 * Coerce a raw `progressEvery` option to a throttle interval: a positive number
 * or 0 (off). Non-positive, NaN, and undefined all mean off.
 * @param {unknown} value
 * @returns {number}
 */
export function coerceEvery(value) {
  const n = Number(value);
  return n > 0 ? n : 0;
}

/**
 * Emit a throttled `<x>-progress` aggregate: at every `every`-th tick (0 =
 * never) log an info record `{ evt, done, ...extra }` with the given human
 * message. Centralizes the modulo-throttle rule the loops all repeat.
 * @param {{ info: Function }} logger
 * @param {number} every - throttle interval (from coerceEvery); 0 = silent
 * @param {number} done - running count
 * @param {string} evt - progress event name (e.g. 'fsck-progress')
 * @param {string} message - the human line for the TTY/summary
 * @param {Object} [extra] - extra structured fields (e.g. { total })
 */
export function emitProgress(logger, every, done, evt, message, extra = {}) {
  if (every && done % every === 0) {
    logger.info({ evt, done, ...extra }, message);
  }
}
