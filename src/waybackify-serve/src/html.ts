/**
 * Wayback chrome strip — consolidated onto the shared waybackify package.
 *
 * The serve-time strip and the remastered tier's build-time strip were byte-
 * for-byte-equivalent copies of one another (the old render/wayback/src/html.ts
 * and spv/waybackify/strip.js). They are now ONE implementation: this module
 * re-exports the strip the waybackify package already owns, so there is a single
 * definition of "the chrome archive.org injects" for every consumer — this
 * serving core, remaster.js, and rewrite.js (which re-exports it too).
 */
export { stripWaybackChrome } from '@charlie.dev/waybackify/strip.js';
