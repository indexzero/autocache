/**
 * Pack smoke — pack every workspace package and prove the manifest's
 * entry-point claims (exports / main / module / bin) name files that are
 * actually IN the tarball npm would publish.
 *
 * This is the pre-publish guard for the exports↔dist class of break: tshy
 * points waybackify-serve's exports at dist/, publish.yml ships whatever
 * `pnpm pack` assembles, and nothing else checks the two agree. A missing
 * `files` entry, a gitignore that leaks into packing, or an exports subpath
 * added without a matching source file all land here instead of on npm.
 *
 * Run AFTER a build (`presmoke:pack` handles it) — pack has no build hook.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = readdirSync(join(repoRoot, 'src'))
  .map((name) => join(repoRoot, 'src', name))
  .filter((dir) => existsSync(join(dir, 'package.json')));

/** Every string leaf under an exports value — conditions nest arbitrarily. */
function entryClaims(manifest) {
  const claims = new Set();
  const walk = (value) => {
    if (typeof value === 'string') claims.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  walk(manifest.bin);
  if (manifest.main) claims.add(manifest.main);
  if (manifest.module) claims.add(manifest.module);
  return [...claims].map((claim) => claim.replace(/^\.\//, ''));
}

const stage = mkdtempSync(join(tmpdir(), 'pack-smoke-'));
let failures = 0;

try {
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    execFileSync('pnpm', ['pack', '--pack-destination', stage], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit']
    });
    const tarball = join(
      stage,
      `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
    );
    const shipped = new Set(
      execFileSync('tar', ['-tzf', tarball]).toString().split('\n').filter(Boolean)
    );
    const missing = entryClaims(manifest).filter((claim) => !shipped.has(`package/${claim}`));
    if (missing.length > 0) {
      failures += missing.length;
      console.error(`${manifest.name}: tarball is missing declared entry points:`);
      for (const claim of missing) console.error(`  ${claim}`);
    } else {
      console.log(`${manifest.name}: ${shipped.size} files, all entry-point claims present`);
    }
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`pack smoke: ${failures} missing entry point(s)`);
  process.exit(1);
}
console.log('pack smoke: every package publishes what its manifest claims');
