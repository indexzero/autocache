#!/usr/bin/env node
// waybackify bin. Argv parsing + exit codes live in src/cli.js; every command
// is wired to a real handler — the flat verbs (manifest, rewrite, ledger,
// check, search), the flat `audit`, the `site` source group (enumerate, export),
// and the three store tier groups: `cache` (add, fill, remediate, crawl, verify,
// status), `remaster` (build, verify), and `bucket` (push, verify).
// The exit-70 scaffold era is over. process.exitCode (not process.exit) so
// stdout/stderr flush naturally before the process ends.
import { run } from '../src/cli.js';
import { auditHandler } from '../src/commands/audit.js';
import { bucketPushHandler } from '../src/commands/bucket-push.js';
import { bucketVerifyHandler } from '../src/commands/bucket-verify.js';
import { cacheAddHandler } from '../src/commands/cache-add.js';
import { cacheCrawlHandler } from '../src/commands/cache-crawl.js';
import { cacheFillHandler } from '../src/commands/cache-fill.js';
import { cacheRemediateHandler } from '../src/commands/cache-remediate.js';
import { cacheStatusHandler } from '../src/commands/cache-status.js';
import { cacheVerifyHandler } from '../src/commands/cache-verify.js';
import { checkHandler } from '../src/commands/check.js';
import { ledgerHandler } from '../src/commands/ledger.js';
import { manifestHandler } from '../src/commands/manifest.js';
import { remasterBuildHandler } from '../src/commands/remaster-build.js';
import { remasterVerifyHandler } from '../src/commands/remaster-verify.js';
import { rewriteHandler } from '../src/commands/rewrite.js';
import { searchHandler } from '../src/commands/search.js';
import { siteEnumerateHandler } from '../src/commands/site-enumerate.js';
import { siteExportHandler } from '../src/commands/site-export.js';

process.exitCode = await run(process.argv.slice(2), {
  handlers: {
    manifest: manifestHandler(),
    rewrite: rewriteHandler(),
    ledger: ledgerHandler(),
    check: checkHandler(),
    search: searchHandler(),
    audit: auditHandler(),
    cacheAdd: cacheAddHandler(),
    cacheFill: cacheFillHandler(),
    cacheRemediate: cacheRemediateHandler(),
    cacheStatus: cacheStatusHandler(),
    cacheCrawl: cacheCrawlHandler(),
    cacheVerify: cacheVerifyHandler(),
    siteEnumerate: siteEnumerateHandler(),
    siteExport: siteExportHandler(),
    remasterBuild: remasterBuildHandler(),
    remasterVerify: remasterVerifyHandler(),
    bucketPush: bucketPushHandler(),
    bucketVerify: bucketVerifyHandler()
  }
});
