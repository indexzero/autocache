// @autocache/waybackify-site — the whole-site source.
//
// A source is anything that tells the cache pipeline which captures to
// fetch. The first source was a markdown file (manifest.js#generate: its
// links → a wayback.json manifest). This package is the second: a SITE — a
// set of CDX queries inside a date window — enumerated into a capture list
// (ledger.js: `captures.jsonl`) holding every distinct version of every URL.
// From there the ordinary pipeline takes over: `cache fill`, `cache
// remediate`, `cache verify`, `cache status`.
//
// Dependency direction: this package imports the waybackify library; the
// library knows capture lists and nothing about sites.
export { readSiteConfig, validateSiteConfig } from './config.js';
export { enumerate, selectVersions } from './enumerate.js';
export { exportTree, planPath } from './export.js';
