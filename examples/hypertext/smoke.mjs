// The standalone go/no-go.
//
// Proves the four packages work for an npm consumer with no workspace in
// sight: pack every src/* package into a tarball, install the tarballs into
// a scratch consumer with plain npm, and run the full example pipeline
// through the installed bins. This is the pre-publish rehearsal of exactly
// what `npm install @autocache/waybackify-cli` will do after the first
// release — workspace links, pnpm hoisting, and the repo's node_modules
// never enter the picture.
//
// Usage: node smoke.mjs [--fill-max N] [--keep]
//   --fill-max N  bound `cache fill` to N captures (default: full closure)
//   --keep        leave the scratch dir behind for inspection
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const args = process.argv.slice(2);
const fillMax = args.includes('--fill-max') ? args[args.indexOf('--fill-max') + 1] : '';
const keep = args.includes('--keep');

const stage = mkdtempSync(join(tmpdir(), 'autocache-smoke-'));
const tarballDir = join(stage, 'tarballs');
const consumer = join(stage, 'consumer');
mkdirSync(tarballDir);
mkdirSync(consumer);
console.log(`smoke: staging in ${stage}`);

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });

try {
  console.log('==> pack the workspace (pnpm rewrites workspace:* to versions)');
  const tarballs = {};
  for (const name of readdirSync(join(repoRoot, 'src'))) {
    const pkgDir = join(repoRoot, 'src', name);
    run('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: pkgDir, stdio: 'ignore' });
    const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    tarballs[`@autocache/${name}`] = `file:${join(tarballDir, `autocache-${name}-${version}.tgz`)}`;
  }

  console.log('==> assemble the scratch consumer');
  // seen.json rides along when present: the committed union answers every
  // already-resolved url, so a rerun's manifest phase makes zero CDX calls.
  for (const entry of ['content', 'universe.json', 'pipeline.sh', 'probe-path.mjs', 'seen.json']) {
    if (existsSync(join(here, entry))) cpSync(join(here, entry), join(consumer, entry), { recursive: true });
  }
  // Direct deps mirror the example's package.json; overrides pin every
  // transitive @autocache/* to its tarball so npm never asks the registry
  // for the not-yet-published names.
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'autocache-smoke-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@autocache/waybackify-cli': tarballs['@autocache/waybackify-cli'],
          '@autocache/waybackify-serve': tarballs['@autocache/waybackify-serve']
        },
        overrides: {
          '@autocache/waybackify': tarballs['@autocache/waybackify'],
          '@autocache/waybackify-crawl': tarballs['@autocache/waybackify-crawl']
        }
      },
      null,
      2
    )
  );

  console.log('==> npm install (standalone: tarballs only, no workspace)');
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer });

  console.log('==> run the pipeline through the installed bins');
  run('bash', ['./pipeline.sh'], {
    cwd: consumer,
    env: { ...process.env, ...(fillMax ? { FILL_MAX: String(fillMax) } : {}) }
  });

  console.log('\nsmoke: GO — tarball install and full pipeline succeeded');
} catch (error) {
  console.error(`\nsmoke: NO-GO — ${error.message}`);
  process.exitCode = 1;
} finally {
  if (keep) console.log(`smoke: kept ${stage}`);
  else rmSync(stage, { recursive: true, force: true });
}
