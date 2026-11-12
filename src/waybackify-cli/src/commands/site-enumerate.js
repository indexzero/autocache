// `waybackify site enumerate` handler — thin wiring over
// @autocache/waybackify-site, per the CLI's hard thin-wrapper rule: the CDX
// walk, the redirect resolution, the version selection, and every file
// written under the ledger are that package's enumerate(). This file reads
// the config, translates the parsed argv payload into an enumerate() call,
// streams progress to stderr, and prints one JSON summary line on stdout.
//
// Design: docs/SITE.md.

import { NOOP_LOGGER } from '../logger.js';

/**
 * Build the `site enumerate` handler. Dependency-injectable for tests; the
 * bin wires the default.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.readSiteConfig] - (file) => config
 * @param {Function} [deps.enumerate] - the package entry point
 * @returns {Function} paparam runner: ({ args, flags, logger, out }) => Promise<void>
 */
export function siteEnumerateHandler(deps = {}) {
  return async ({ args, flags, logger = NOOP_LOGGER, out = console.log }) => {
    const readSiteConfig = deps.readSiteConfig ?? (await import('@autocache/waybackify-site/config')).readSiteConfig;
    const enumerate = deps.enumerate ?? (await import('@autocache/waybackify-site/enumerate')).enumerate;

    const config = readSiteConfig(args.config);
    const result = await enumerate(config, {
      ledger: flags.ledger,
      // paparam's multiple() yields an array; absent = every site.
      sites: flags.site && flags.site.length > 0 ? flags.site : undefined,
      offline: Boolean(flags.offline),
      // `--no-redirects` registers as `redirects`, default true (cli.js note 5).
      redirects: flags.redirects !== false,
      repickFrom: flags.repickFrom,
      logger,
      onProgress(ev) {
        switch (ev.type) {
          case 'cdx-page':
            logger.info({ evt: 'site-progress', ...ev }, `cdx ${ev.query} page ${ev.page}: ${ev.rows} rows`);
            break;
          case 'site-rows':
            logger.info({ evt: 'site-progress', ...ev }, `${ev.site}: ${ev.rows} CDX rows`);
            break;
          case 'redirects':
            logger.info({ evt: 'site-progress', ...ev }, `${ev.site}: resolved ${ev.resolved} redirect(s)`);
            break;
          case 'redirect-round':
            logger.info({ evt: 'site-progress', ...ev }, `redirect round ${ev.round}: +${ev.rows} rows from redirect targets`);
            break;
          case 'redirect-failed':
            logger.warn({ evt: 'site-progress', ...ev }, `redirect probe failed (left for a rerun): ${ev.key}: ${ev.error}`);
            break;
          case 'target-failed':
            logger.warn({ evt: 'site-progress', ...ev }, `redirect-target query failed (left for a rerun): ${ev.target}: ${ev.error}`);
            break;
          case 'site':
            logger.info({ evt: 'site-progress', ...ev }, `${ev.site}: ${ev.okUrls} URLs · ${ev.versions} versions (max ${ev.maxVersionsPerUrl} of one URL)`);
            break;
        }
      }
    });

    // ONE summary line on stdout (JSON, jq-friendly).
    out(JSON.stringify(result));
  };
}
