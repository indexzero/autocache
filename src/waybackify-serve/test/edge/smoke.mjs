/**
 * Edge-bundle smoke — prove the two edge adapters BUNDLE from the built dist,
 * the layer tsc cannot vouch for. The washe deploy break that motivated this
 * (charlie.dev #539) passed typecheck and failed only inside the deploy
 * bundler; this runs both bundlers at CI time instead of deploy time:
 *
 *   Fastly      js-compute-runtime (the exact bundler `fastly compute build`
 *               invokes) over entry-fastly.js → main.wasm. Wizer executes the
 *               entry's top level, so the handler registration itself runs.
 *   Cloudflare  esbuild over entry-cloudflare.js with wrangler's resolution
 *               posture (workerd/worker/browser conditions, browser platform,
 *               ESM) → worker bundle.
 *
 * Both entries import the package by name, so resolution goes through the
 * published exports map into dist/ — `presmoke:edge` (tshy) materializes it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const out = mkdtempSync(join(tmpdir(), 'edge-smoke-'));

try {
  execFileSync(
    'pnpm',
    ['exec', 'js-compute-runtime', join(here, 'entry-fastly.js'), join(out, 'main.wasm')],
    { cwd: packageRoot, stdio: 'inherit' }
  );

  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(here, 'entry-cloudflare.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    outfile: join(out, 'worker.js'),
    logLevel: 'warning'
  });

  console.log('edge smoke: fastly wasm + cloudflare worker bundle from dist — OK');
} finally {
  rmSync(out, { recursive: true, force: true });
}
