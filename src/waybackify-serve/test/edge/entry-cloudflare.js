/**
 * Edge-bundle smoke entry — Cloudflare Workers. Bundled by esbuild in
 * test/edge/smoke.mjs with wrangler's resolution posture (worker conditions,
 * browser platform, ESM): the package self-reference resolves through the
 * exports map into the BUILT dist, so this proves the published
 * `./cloudflare` graph bundles for a Worker — no stray `node:` imports or
 * runtime-absent modules. The zero-config call is the documented convention
 * entry (`WAYBACK_CAPTURES` binding names).
 */
import { createCloudflareHandler } from '@autocache/waybackify-serve/cloudflare';

export default createCloudflareHandler();
