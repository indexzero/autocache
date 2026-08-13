/**
 * Edge-bundle smoke entry — Fastly Compute. Bundled by js-compute-runtime in
 * test/edge/smoke.mjs: the package self-reference resolves through the
 * exports map into the BUILT dist, so this proves the published `./fastly`
 * surface survives the real Compute bundler (the same one `fastly compute
 * build` invokes), not just tsc. The coordinates are deploy-shaped
 * placeholders — nothing here is ever served.
 */
import { createFastlyHandler } from '@autocache/waybackify-serve/fastly';

createFastlyHandler({
  endpoint: 'https://us-east-1.object.fastlystorage.app',
  bucket: 'edge-smoke',
  region: 'us-east-1',
  backend: 'object-storage',
  secretStore: 'edge-smoke-secrets'
});
