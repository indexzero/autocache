/**
 * FsStore contract tests — the cache-root consumer semantics, clause by
 * clause (spv/waybackify-cli/docs/SERVE.md):
 *
 * - the sidecar is the entry: orphan cap/ files are ABSENT, bodiless
 *   statuses are COMPLETE;
 * - head() never opens the body file (pinned by deleting the body out from
 *   under a bodied entry — head must not notice);
 * - rot is loud: corrupt/mismatched sidecars throw, they do not miss;
 * - the reader is sidecar-key-order independent;
 * - path derivation goes through the shared key module (pinned against the
 *   committed fixture root, whose example.com entry sits at the digest both
 *   packages' suites pin).
 *
 * Synthetic roots are built per test in tmpdirs with hand-written layout
 * files — deliberately, so each on-disk shape under test (orphan, bodiless,
 * rot) is explicit in the test that asserts it. The committed fixture
 * (test/fixtures/cache-root) is real `waybackify cache` output; the
 * end-to-end serving path over it lives in render/wayback's chicago.test.ts.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FsStore } from '../src/fsstore.ts';
import { captureHash } from '@charlie.dev/waybackify/key.js';
import type { Capture } from '../src/store.ts';
import { runStoreConformance, type Seed } from './store-conformance.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));

const KEY = '20140403040000/http://example.com/';
/** The cross-package tripwire digest of KEY (also pinned in key.test.ts). */
const KEY_HASH = '77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await fsp.mkdtemp(`${os.tmpdir()}/wayback-fsstore-`);
  roots.push(root);
  return root;
}

/** Write layout files for one entry — sidecar and/or body, independently. */
async function writeEntry(
  root: string,
  key: string,
  parts: { sidecar?: Record<string, unknown> | string; body?: string }
): Promise<{ metaPath: string; bodyPath: string }> {
  const hash = await captureHash(key);
  const aa = hash.slice(0, 2);
  const metaPath = `${root}/meta/${aa}/${hash}.json`;
  const bodyPath = `${root}/cap/${aa}/${hash}`;
  if (parts.sidecar !== undefined) {
    await fsp.mkdir(`${root}/meta/${aa}`, { recursive: true });
    const raw = typeof parts.sidecar === 'string' ? parts.sidecar : JSON.stringify(parts.sidecar);
    await fsp.writeFile(metaPath, raw);
  }
  if (parts.body !== undefined) {
    await fsp.mkdir(`${root}/cap/${aa}`, { recursive: true });
    await fsp.writeFile(bodyPath, parts.body);
  }
  return { metaPath, bodyPath };
}

/** A complete v1 bodied sidecar for KEY (canonical field set, CACHE.md). */
function bodiedSidecar(body: string): Record<string, unknown> {
  return {
    contentHash: 'sha256-unverified',
    contentLength: body.length,
    contentType: 'text/html; charset=utf-8',
    fetchedAt: '2026-07-12T00:00:00.000Z',
    flag: null,
    key: KEY,
    requisites: [],
    status: 'body',
    v: 1
  };
}

async function bodyText(capture: Capture): Promise<string> {
  return new Response(capture.body as ReadableStream<Uint8Array>).text();
}

/**
 * The population seam for the shared store-conformance suite: realize each
 * seed as the `waybackify cache` writer would on disk — a canonical v1 sidecar
 * (bodied entries carry a real SRI contentHash + byte contentLength; an orphan
 * is cap/ bytes with NO sidecar). This is the FsStore's one seam impl; the
 * cross-store parity assertions live in store-conformance.ts.
 */
function sidecarFor(seed: Extract<Seed, { kind: 'entry' }>): Record<string, unknown> {
  // `interstitial` (#363) is a v2 sidecar carrying its signature; every other
  // status is written as a legacy v1 sidecar, which also exercises that a v1
  // root still reads under the v2 reader.
  const isInterstitial = seed.status === 'interstitial';
  const base: Record<string, unknown> = {
    contentType: seed.contentType,
    fetchedAt: '2026-07-13T00:00:00.000Z',
    flag: null,
    key: seed.key,
    requisites: [],
    status: seed.status,
    v: isInterstitial ? 2 : 1,
    ...(isInterstitial ? { signature: 'wrapper-stub' } : {})
  };
  if (seed.status !== 'body') return base;
  const bytes = new TextEncoder().encode(seed.body ?? '');
  return { ...base, contentHash: `sha256-${createHash('sha256').update(bytes).digest('base64')}`, contentLength: bytes.length };
}

runStoreConformance({
  name: 'FsStore',
  async populate(seeds) {
    const root = await makeRoot();
    for (const seed of seeds) {
      if (seed.kind === 'orphan') {
        await writeEntry(root, seed.key, { body: seed.body }); // cap/ only — no completion token
      } else {
        await writeEntry(root, seed.key, {
          sidecar: sidecarFor(seed),
          ...(seed.status === 'body' ? { body: seed.body ?? '' } : {})
        });
      }
    }
    return new FsStore(root);
  },
  async breakBody({ key, contentType, body }) {
    // cap/ and meta/ are separate files here, so a bodied entry can lose its
    // body while its sidecar stays intact — the disk-level "head() never opens
    // cap/" proof.
    const root = await makeRoot();
    const { bodyPath } = await writeEntry(root, key, { sidecar: sidecarFor({ kind: 'entry', key, status: 'body', contentType, body }), body });
    await fsp.unlink(bodyPath);
    return { store: new FsStore(root), key };
  }
});

describe('FsStore', () => {
  describe('bodied entries', () => {
    it('head() answers metadata from the sidecar alone', async () => {
      const root = await makeRoot();
      await writeEntry(root, KEY, { sidecar: bodiedSidecar('<html>x</html>'), body: '<html>x</html>' });

      const meta = await new FsStore(root).head(KEY);
      assert.deepEqual(meta, { contentType: 'text/html; charset=utf-8', size: 14, status: 'body' });
    });

    it('get() streams the exact stored bytes', async () => {
      const root = await makeRoot();
      await writeEntry(root, KEY, { sidecar: bodiedSidecar('<html>bytes</html>'), body: '<html>bytes</html>' });

      const capture = await new FsStore(root).get(KEY);
      assert.notEqual(capture, null);
      assert.equal('body' in capture!, true);
      assert.equal(await bodyText(capture as Capture), '<html>bytes</html>');
    });

    it('head() NEVER opens the body file — deleting it changes nothing for head()', async () => {
      // The strongest observable form of the SERVE.md rule "head() is one
      // sidecar read": with the cap/ file GONE, any implementation that so
      // much as stat()s the body would answer differently. head() must not
      // notice.
      const root = await makeRoot();
      const { bodyPath } = await writeEntry(root, KEY, {
        sidecar: bodiedSidecar('<html>x</html>'),
        body: '<html>x</html>'
      });
      await fsp.unlink(bodyPath);

      const meta = await new FsStore(root).head(KEY);
      assert.deepEqual(meta, { contentType: 'text/html; charset=utf-8', size: 14, status: 'body' });
    });

    it('get() on a bodied entry whose body file is missing fails LOUDLY (rot, not a miss)', async () => {
      const root = await makeRoot();
      const { bodyPath } = await writeEntry(root, KEY, {
        sidecar: bodiedSidecar('<html>x</html>'),
        body: '<html>x</html>'
      });
      await fsp.unlink(bodyPath);

      // Sidecar present + status "body" + cap/ absent is a torn store —
      // the opposite parity of both legitimate states. It must surface as
      // an error the app turns into a 500, never as null/miss.
      const capture = await new FsStore(root).get(KEY);
      await assert.rejects(bodyText(capture as Capture));
    });
  });

  describe('sidecar-presence semantics', () => {
    it('answers null for a never-cached key', async () => {
      const root = await makeRoot();
      assert.equal(await new FsStore(root).head(KEY), null);
      assert.equal(await new FsStore(root).get(KEY), null);
    });

    it('an orphan cap/ file without its sidecar is ABSENT (never served)', async () => {
      // The write-protocol crash window: body renamed, sidecar never
      // published. Ingest garbage — invisible to consumers.
      const root = await makeRoot();
      await writeEntry(root, KEY, { body: '<html>orphan bytes</html>' });

      const store = new FsStore(root);
      assert.equal(await store.head(KEY), null);
      assert.equal(await store.get(KEY), null);
    });
  });

  describe('status discriminators — bodiless entries are complete, never phantom-bodied', () => {
    for (const status of ['empty', 'redirect', 'error'] as const) {
      it(`${status}: metadata with NO body from head() and get()`, async () => {
        const root = await makeRoot();
        await writeEntry(root, KEY, {
          sidecar: {
            contentType: 'text/html',
            fetchedAt: '2026-07-12T00:00:00.000Z',
            flag: 'im_',
            key: KEY,
            requisites: [],
            status,
            v: 1
          }
          // No body part: bodiless entries own no cap/ file by contract.
        });

        const store = new FsStore(root);
        const viaHead = await store.head(KEY);
        const viaGet = await store.get(KEY);
        assert.deepEqual(viaHead, { contentType: 'text/html', status });
        assert.deepEqual(viaGet, viaHead);
        assert.equal('body' in viaGet!, false);
      });
    }
  });

  describe('rot is loud', () => {
    it('throws on unparseable sidecar JSON (an existing sidecar is never a miss)', async () => {
      const root = await makeRoot();
      await writeEntry(root, KEY, { sidecar: '{"v":1,"key":' });
      await assert.rejects(new FsStore(root).head(KEY));
    });

    it('throws on an unsupported sidecar version', async () => {
      const root = await makeRoot();
      await writeEntry(root, KEY, { sidecar: { ...bodiedSidecar('x'), v: 99 } });
      await assert.rejects(new FsStore(root).head(KEY), /version/);
    });

    it('reads a v2 sidecar (the interstitial schema) — a supported version', async () => {
      const root = await makeRoot();
      await writeEntry(root, KEY, { sidecar: { ...bodiedSidecar('x'), v: 2 }, body: 'x' });
      assert.equal((await new FsStore(root).head(KEY))?.status, 'body');
    });

    it('throws when the sidecar at a hash path claims a different key', async () => {
      const root = await makeRoot();
      await writeEntry(root, KEY, {
        sidecar: { ...bodiedSidecar('x'), key: '20140403040000/http://evil.example/' }
      });
      await assert.rejects(new FsStore(root).head(KEY), /different key/);
    });
  });

  it('does not depend on sidecar key order', async () => {
    // The writer emits canonical (sorted-key) JSON, but the READER must not
    // require it — the schema is the contract, not the byte layout.
    const root = await makeRoot();
    const sorted = bodiedSidecar('<html>x</html>');
    const reversed = Object.fromEntries(Object.entries(sorted).reverse());
    await writeEntry(root, KEY, { sidecar: reversed, body: '<html>x</html>' });

    const meta = await new FsStore(root).head(KEY);
    assert.deepEqual(meta, { contentType: 'text/html; charset=utf-8', size: 14, status: 'body' });
  });

  it('derives paths through the shared key module — pinned against the committed fixture', async () => {
    // The fixture's example.com entry sits at the digest both packages pin
    // as the cross-package tripwire; reading it proves this consumer derives
    // the same on-disk names the `waybackify cache` writer produced.
    assert.equal(await captureHash(KEY), KEY_HASH);

    const meta = await new FsStore(FIXTURE_ROOT).head(KEY);
    assert.notEqual(meta, null);
    assert.equal(meta?.status, 'body');
    assert.match(meta?.contentType ?? '', /^text\/html/);
  });

  describe('committed synthetic fixture entries — bodiless statuses + orphan, on disk', () => {
    // The four `status:"body"` fixture entries are real `waybackify cache`
    // output; these four are hand-authored (README-marked) so the FsStore has
    // committed, reviewable instances of every bodiless status — and, since
    // the corpus has ZERO redirects, the ONLY on-disk redirect coverage there
    // is. Read straight off the committed root, not a tmpdir.
    const store = new FsStore(FIXTURE_ROOT);

    it('empty: complete, bodiless, empty content-type NORMALIZED on read', async () => {
      const meta = await store.head('20140403040000/http://example.com/empty');
      assert.deepEqual(meta, { contentType: 'application/octet-stream', status: 'empty' });
      assert.deepEqual(await store.get('20140403040000/http://example.com/empty'), meta);
    });

    it('redirect: the only on-disk redirect — bodiless, content-type verbatim', async () => {
      const meta = await store.head('20140403040000/http://example.com/redirect');
      assert.deepEqual(meta, { contentType: 'text/html; charset=utf-8', status: 'redirect' });
    });

    it('error: complete, bodiless, empty content-type NORMALIZED on read', async () => {
      const meta = await store.head('20140403040000/http://example.com/missing.gif');
      assert.deepEqual(meta, { contentType: 'application/octet-stream', status: 'error' });
    });

    it('orphan: a committed cap/ file with no sidecar is ABSENT', async () => {
      assert.equal(await store.head('20140403040000/http://example.com/orphan'), null);
      assert.equal(await store.get('20140403040000/http://example.com/orphan'), null);
    });
  });
});
