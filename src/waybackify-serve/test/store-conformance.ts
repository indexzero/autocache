/**
 * Store conformance — the shared contract every `Store` (src/store.ts) must
 * honor, asserted identically against each backend (#285).
 *
 * The milestone requires wayback.charlie.dev to answer BYTE-FOR-DECISION
 * identically whether it reads local disk, a Cloudflare R2 bucket, or Fastly
 * Object Storage. Cross-store divergence is the entire risk surface, so it gets
 * ONE suite, not per-store spot checks: same fixture in, same head()/get() out.
 * Runs today against MemoryStore (native-metadata model) and FsStore (POSIX
 * sidecar model); the S3Store/R2Store issues (#286/#287) plug in the same way.
 *
 * ── ADDING A STORE ─────────────────────────────────────────────────────────
 * One import, one `describe`, one population-seam impl:
 *
 *   import { runStoreConformance } from './store-conformance.ts';
 *   runStoreConformance({
 *     name: 'MyStore',
 *     async populate(seeds) { ...return a Store realizing `seeds`... }
 *   });
 *
 * ── THE POPULATION SEAM (`populate`) ───────────────────────────────────────
 * Given the suite's seeds, return a FRESH store realizing each in the store's
 * NATIVE terms — never by calling the store's own read path. The seam is the
 * one place a store's write/upload model is spelled, so the rig can't drift
 * from the real writer:
 *
 *   - kind 'entry' (status body|empty|redirect|error): a committed capture.
 *     Native-metadata stores (Memory, and later S3/R2) carry content-type +
 *     status ON the object, a bodiless status being a zero-byte object; the
 *     FsStore writes a `cap/<aa>/<hash>` body (bodied only) plus its canonical
 *     `meta/<aa>/<hash>.json` sidecar. `contentType` is stored VERBATIM
 *     (including `''`) — normalization is a read mask, never a write.
 *   - kind 'orphan': a TORN write — body bytes with NO completion token. The
 *     FsStore writes `cap/` and no sidecar; native-metadata stores cannot
 *     express a torn write (the emitter only ever writes a complete object),
 *     so they realize it as absent. Both MUST answer null: an incomplete write
 *     is never served, on any backend.
 *
 * ── OPTIONAL: `breakBody` ──────────────────────────────────────────────────
 * The strong form of "head() never reads bodies": populate one bodied entry,
 * then make its BODY unreadable while leaving metadata intact, and return the
 * store + key. Only stores that keep body and metadata in SEPARATE objects
 * (FsStore: cap/ vs meta/) can express this; native-metadata stores fuse them
 * and omit the hook — the suite keeps the structural check (head() returns no
 * body) for them and adds the disk-level proof for the ones that can.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Capture, CaptureMeta, CaptureStatus, Store } from '../src/store.ts';

/** A capture the population seam realizes in a store's native terms. */
export type Seed =
  | { kind: 'entry'; key: string; status: CaptureStatus; contentType: string; body?: string }
  | { kind: 'orphan'; key: string; body: string };

export interface ConformanceStore {
  /** Store name — the describe label. */
  name: string;
  /** THE POPULATION SEAM: a fresh store realizing `seeds`. */
  populate(seeds: Seed[]): Promise<Store>;
  /** OPTIONAL strong "head() never reads bodies" — see the header. */
  breakBody?(seed: { key: string; contentType: string; body: string }): Promise<{ store: Store; key: string }>;
  /** OPTIONAL: release anything populate/breakBody allocated (tmpdirs, ...). */
  cleanup?(): Promise<void>;
}

/** The bodyless statuses — a bodied entry is the only one with cap/ bytes.
 *  `interstitial` (#363) joins them: a refused wayback fluff page, metadata-only
 *  on every backend. */
const BODILESS: readonly CaptureStatus[] = ['empty', 'redirect', 'error', 'interstitial'];

/** Byte length of a body string exactly as the stores measure it (UTF-8). */
function byteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

/** Read any Capture body shape (stream | string | bytes) to text. */
async function readBody(body: Capture['body']): Promise<string> {
  return new Response(body).text();
}

/** The head()/get() metadata the READ contract requires for one entry seed. */
function expectedMeta(seed: Extract<Seed, { kind: 'entry' }>): CaptureMeta {
  const contentType = seed.contentType || 'application/octet-stream';
  if (seed.status !== 'body') return { contentType, status: seed.status };
  return { contentType, status: seed.status, size: byteLength(seed.body ?? '') };
}

/**
 * Assert the full contract for one store. Call once per backend from that
 * store's own test file (which keeps its store-specific tests alongside).
 */
export function runStoreConformance(store: ConformanceStore): void {
  describe(`${store.name} — store conformance`, () => {
    afterEach(async () => store.cleanup?.());

    describe('miss — an uncached key is absent', () => {
      it('head() and get() both answer null', async () => {
        const s = await store.populate([]);
        assert.equal(await s.head('20140403040000/http://example.com/never'), null);
        assert.equal(await s.get('20140403040000/http://example.com/never'), null);
      });
    });

    describe('status discriminators — every status answers identically head vs get', () => {
      const KEY = '20140403040000/http://example.com/';

      it('body: head() is metadata + size, get() adds the exact bytes', async () => {
        const seed = { kind: 'entry', key: KEY, status: 'body', contentType: 'text/html; charset=utf-8', body: '<html>x</html>' } as const;
        const s = await store.populate([seed]);

        const meta = await s.head(KEY);
        assert.deepEqual(meta, expectedMeta(seed));
        assert.equal(meta && 'body' in meta, false); // head() never carries a body

        const capture = await s.get(KEY);
        assert.equal(capture && 'body' in capture, true);
        const { body, ...rest } = capture as Capture;
        assert.deepEqual(rest, expectedMeta(seed));
        assert.equal(await readBody(body), seed.body);
      });

      for (const status of BODILESS) {
        it(`${status}: a COMPLETE entry with NO body — head() and get() are equal`, async () => {
          const seed = { kind: 'entry', key: KEY, status, contentType: 'text/html' } as const;
          const s = await store.populate([seed]);

          const meta = await s.head(KEY);
          const capture = await s.get(KEY);
          assert.deepEqual(meta, expectedMeta(seed));
          assert.deepEqual(capture, expectedMeta(seed)); // get() answers meta, not a miss
          assert.equal(capture && 'body' in capture, false); // never a phantom body
        });
      }
    });

    describe('orphan body is absent — a torn write is never served', () => {
      it('body bytes with no completion token read back as a miss (head + get null)', async () => {
        const KEY = '20140403040000/http://example.com/orphan';
        const s = await store.populate([{ kind: 'orphan', key: KEY, body: 'orphan bytes' }]);
        assert.equal(await s.head(KEY), null);
        assert.equal(await s.get(KEY), null);
      });
    });

    describe('content-type fidelity — verbatim, except the normalization rule', () => {
      const KEY = '20140403040000/http://example.com/ct';

      it('a full content-type round-trips VERBATIM (charset and all)', async () => {
        const seed = { kind: 'entry', key: KEY, status: 'body', contentType: 'text/html; charset=iso-8859-1', body: 'x' } as const;
        const s = await store.populate([seed]);
        assert.equal((await s.head(KEY))?.contentType, 'text/html; charset=iso-8859-1');
        assert.equal((await s.get(KEY))?.contentType, 'text/html; charset=iso-8859-1');
      });

      it("an empty content-type NORMALIZES to application/octet-stream on read (sidecar keeps '' — this is a read mask)", async () => {
        const seed = { kind: 'entry', key: KEY, status: 'body', contentType: '', body: 'x' } as const;
        const s = await store.populate([seed]);
        assert.equal((await s.head(KEY))?.contentType, 'application/octet-stream');
        assert.equal((await s.get(KEY))?.contentType, 'application/octet-stream');
      });

      it("the normalization is status-independent — a bodiless '' entry normalizes too", async () => {
        // 21 of the corpus's 25 `''` sidecars are `error` (2026-07-13), so this
        // is the common path, not an edge: the read mask does not care whether
        // there are body bytes.
        const seed = { kind: 'entry', key: KEY, status: 'error', contentType: '' } as const;
        const s = await store.populate([seed]);
        assert.equal((await s.head(KEY))?.contentType, 'application/octet-stream');
        assert.equal((await s.get(KEY))?.contentType, 'application/octet-stream');
      });
    });

    describe('hostile keys — the key contract admits anything a real capture carries', () => {
      // Real corpus keys are POSIX-impossible and can blow a 1KiB object-key
      // cap; every store maps them to a legal identity (FsStore/remote: the
      // sha256 layout; Memory: a map key), so all of these must round-trip.
      const HOSTILE: Array<[string, string]> = [
        ['unicode + fragment + query', '20140403040000/http://例え.example/パス?q=café#フラグ'],
        ['a bare query string', '20140403040000/http://example.com/search?q=a&b=c&empty='],
        ['a 2000+ char original URL', `20140403040000/http://example.com/${'p/'.repeat(1100)}`]
      ];

      for (const [label, key] of HOSTILE) {
        it(`round-trips a key with ${label}`, async () => {
          const seed = { kind: 'entry', key, status: 'body', contentType: 'text/plain', body: 'hostile-ok' } as const;
          const s = await store.populate([seed]);
          assert.deepEqual(await s.head(key), expectedMeta(seed));
          assert.equal(await readBody((await s.get(key) as Capture).body), 'hostile-ok');
          // A DIFFERENT key must still miss — the hash/map keying is total, not
          // lossy (no collision onto the populated entry).
          assert.equal(await s.head(`${key}x`), null);
        });
      }
    });

    describe('head() never reads bodies', () => {
      const KEY = '20140403040000/http://example.com/';

      it('head() of a bodied entry returns metadata with NO body field (structural)', async () => {
        const s = await store.populate([{ kind: 'entry', key: KEY, status: 'body', contentType: 'text/html', body: 'x' }]);
        const meta = await s.head(KEY);
        assert.equal(meta && 'body' in meta, false);
      });

      const strong = store.breakBody ? it : it.skip;
      strong('head() still answers with the BODY unreadable (disk-level proof)', async () => {
        // The strongest observable form: with the body bytes gone but metadata
        // intact, any implementation that so much as stat()s the body would
        // answer differently. head() must not notice.
        const { store: s, key } = await store.breakBody!({ key: KEY, contentType: 'text/html; charset=utf-8', body: '<html>x</html>' });
        assert.deepEqual(await s.head(key), { contentType: 'text/html; charset=utf-8', status: 'body', size: byteLength('<html>x</html>') });
      });
    });
  });
}
