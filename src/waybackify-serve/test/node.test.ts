/**
 * Node CLI entry (src/node.ts) — the two serving modes (mutually exclusive
 * except under --index, where the bucket serves and --root is the catalog):
 *
 *   - main() ARG VALIDATION: both/neither mode, --bucket without --endpoint,
 *     and --bucket with the AWS credentials absent from the environment all
 *     fail fast with a clear message and a non-zero exit code — no server is
 *     ever booted on a bad invocation (the validation branches return before
 *     serveCacheRoot/serveBucket).
 *   - serveBucket() BOOT: a real @hono/node-server listener over an S3Store
 *     pointed at a STUBBED S3 endpoint — a tiny local http server that answers
 *     the store's path-style object requests from the committed cache-root
 *     fixture PROJECTED to S3 shape (native Content-Type + x-amz-meta-status;
 *     bodiless statuses are zero-byte objects; the orphan cap/ file, having no
 *     sidecar, is absent, exactly as no native-metadata store can express it).
 *     Offline and deterministic — no network, no minio, no real S3.
 *
 * The --root leg's real-listener boot lives in render/wayback's chicago.test.ts
 * (serveCacheRoot over the same fixture); this file owns the --bucket leg and
 * main()'s dispatch.
 */

import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { main, serveBucket } from '../src/node.ts';
import { projectFixtureToBucket, startS3Stub } from './s3-fixture.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/cache-root', import.meta.url));
const BUCKET = 'wayback-captures';
/** Any non-empty pair — the stub verifies no signature; signing just needs values. */
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

describe('main — mode dispatch & validation', () => {
  let errors: string[];
  /** Saved so a stubbed env var is restored (node:test has no vi.stubEnv). */
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    errors = [];
    mock.method(console, 'error', (msg: unknown) => void errors.push(String(msg)));
    savedEnv = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY
    };
  });
  afterEach(() => {
    mock.restoreAll();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // main() sets the process exit code on failure; clear it so a validation
    // test never poisons the runner's own exit.
    process.exitCode = undefined;
  });

  it('rejects both --root and --bucket WITHOUT --index (still mutually exclusive)', async () => {
    // Only `--index` licenses the combination (bucket serves, root catalogs);
    // without it the modes stay exclusive, exactly as before.
    await main(['--root', '/some/root', '--bucket', BUCKET, '--endpoint', 'http://e']);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /mutually exclusive/);
  });

  it('rejects neither mode', async () => {
    await main([]);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /one of --root or --bucket is required/);
  });

  it('rejects --bucket --index without --root (the /_index catalog must come from a local cache-root)', async () => {
    // A bucket cannot enumerate itself, so bucket-mode /_index NEEDS the
    // local catalog; without --root the flag could only silently do nothing —
    // fail loud with the pointer to what is missing instead.
    await main(['--bucket', BUCKET, '--endpoint', 'http://e', '--index']);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /--index in bucket mode needs --root/);
  });

  it('rejects --bucket without --endpoint', async () => {
    await main(['--bucket', BUCKET]);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /--bucket requires --endpoint/);
  });

  it('fails fast when --bucket mode has no AWS credentials in the env', async () => {
    // Empty string is falsy — models both "unset" and "cleared".
    process.env.AWS_ACCESS_KEY_ID = '';
    process.env.AWS_SECRET_ACCESS_KEY = '';
    await main(['--bucket', BUCKET, '--endpoint', 'http://e']);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
  });

  it('reports an invalid --port', async () => {
    await main(['--root', '/some/root', '--port', 'nope']);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /invalid --port/);
  });

  it('rejects a present-but-blank --split-scheme (never a silent https drop)', async () => {
    // resolveSplit runs before any store is opened, so this fails fast with no
    // server booted. A DEFINED but empty scheme is a mistake, not the default.
    await main(['--root', '/some/root', '--chrome-host', 'a.example', '--content-host', 'b.example', '--split-scheme', '']);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join('\n'), /--split-scheme must be non-empty/);
  });

  it('--help prints the usage banner to stdout and exits 0 (a request, not a bad invocation)', async () => {
    const logs: string[] = [];
    mock.method(console, 'log', (msg: unknown) => void logs.push(String(msg)));
    await main(['--help']);
    assert.equal(process.exitCode, undefined); // never set the failing code
    assert.equal(errors.length, 0); // no error banner
    assert.match(logs.join('\n'), /usage: waybackify-serve/);
  });
});

describe('main — /_index wiring (--index, catalog from --root)', () => {
  let errors: string[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    errors = [];
    mock.method(console, 'error', (msg: unknown) => void errors.push(String(msg)));
    savedEnv = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY
    };
    process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
  });
  afterEach(() => {
    mock.restoreAll();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = undefined;
  });

  it('--bucket --root --index: the bucket serves, the root catalogs — /_index links resolve to bucket GETs', async () => {
    // The combined mode: main builds indexKeys from the --root cache-root
    // (loadCorpusKeySet over its meta/ sidecars) and threads them through
    // serveBucket into the app, while every byte-serving request still goes
    // to the S3Store. main resolves with the RunningServer, so the test can
    // exercise the booted process end-to-end and then close it.
    const stub = await startS3Stub(await projectFixtureToBucket(FIXTURE_ROOT), BUCKET);
    const running = await main(['--bucket', BUCKET, '--endpoint', stub.url, '--root', FIXTURE_ROOT, '--index']);
    assert.ok(running, 'main boots (no validation failure) and resolves with the server');
    try {
      assert.equal(process.exitCode, undefined);

      // /_index serves off the ROOT-built catalog: keys from the fixture's
      // meta sidecars, linked same-origin.
      const index = await fetch(`${running.url}/_index`);
      assert.equal(index.status, 200);
      const body = await index.text();
      assert.ok(body.includes('href="/20140403040000/http://example.com/"'), 'a root-cataloged key is listed');
      assert.ok(body.includes('href="/19981202230410/http://www.google.com/"'), 'the whole root catalog is walked, not one entry');

      // Clicking a listed link lands on THIS server → the BUCKET answers it.
      const doc = await fetch(`${running.url}/20140403040000/http://example.com/`);
      assert.equal(doc.status, 200);
      assert.match(await doc.text(), /Example Domain/);
    } finally {
      await new Promise(resolve => running!.server.close(resolve));
      await stub.close();
    }
  });

  it('--root --index alone still serves /_index off the local store (regression guard)', async () => {
    const running = await main(['--root', FIXTURE_ROOT, '--index']);
    assert.ok(running, 'the plain local mode boots exactly as before');
    try {
      assert.equal(process.exitCode, undefined);
      const index = await fetch(`${running.url}/_index`);
      assert.equal(index.status, 200);
      assert.ok((await index.text()).includes('href="/20140403040000/http://example.com/"'));
      const doc = await fetch(`${running.url}/20140403040000/http://example.com/`);
      assert.equal(doc.status, 200);
    } finally {
      await new Promise(resolve => running!.server.close(resolve));
    }
  });
});

describe('serveBucket — remote S3 mode over a stubbed endpoint', () => {
  it('boots a real listener and serves a document, a bodiless entry, and a strict miss→404', async () => {
    const stub = await startS3Stub(await projectFixtureToBucket(FIXTURE_ROOT), BUCKET);
    const { server, url, port } = await serveBucket({ endpoint: stub.url, bucket: BUCKET, region: 'auto', credentials: CREDENTIALS });
    try {
      assert.ok(port > 0); // --port 0 resolved to a real ephemeral one

      // A fixture DOCUMENT: 200, archive chrome stripped, standalone CSP,
      // nothing of ours in the body — identical serve-time posture to the local
      // path, now off a bucket.
      const doc = await fetch(`${url}/20140403040000/http://example.com/`);
      assert.equal(doc.status, 200);
      assert.match(doc.headers.get('content-type') ?? '', /^text\/html/);
      assert.ok((doc.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));
      const html = await doc.text();
      assert.ok(html.includes('Example Domain'));
      assert.ok(!html.includes('wayback-charlie-dev-attribution'));
      assert.ok(!html.includes('WAYBACK TOOLBAR INSERT'));

      // A BODILESS `empty` entry: a real archived 200 with zero bytes — served
      // as exactly that (the zero-byte object is metadata, never surfaced body).
      const empty = await fetch(`${url}/20140403040000/http://example.com/empty`);
      assert.equal(empty.status, 200);
      assert.equal((await empty.arrayBuffer()).byteLength, 0);

      // A MISS (absent object → the store's one 404) answers a local 404,
      // no-store — strict is the default, nothing leaves this server.
      const miss = await fetch(`${url}/20140403040000/http://example.com/not-in-bucket`, { redirect: 'manual' });
      assert.equal(miss.status, 404);
      assert.equal(miss.headers.get('cache-control'), 'no-store');
      assert.equal(miss.headers.get('location'), null);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await stub.close();
    }
  });

  it('threads relaxContentCsp: true through to the app (document CSP gains the archive origins)', async () => {
    const stub = await startS3Stub(await projectFixtureToBucket(FIXTURE_ROOT), BUCKET);
    const { server, url } = await serveBucket({
      endpoint: stub.url,
      bucket: BUCKET,
      region: 'auto',
      credentials: CREDENTIALS,
      relaxContentCsp: true
    });
    try {
      const doc = await fetch(`${url}/20140403040000/http://example.com/`);
      assert.equal(doc.status, 200);
      const csp = doc.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("script-src 'self' 'unsafe-inline' https://web.archive.org https://archive.org"));
      // Values widened, posture untouched: default-src stays 'self' alone.
      assert.ok(csp.includes("default-src 'self';"));
    } finally {
      await new Promise(resolve => server.close(resolve));
      await stub.close();
    }
  });

  it('threads liveFallback: true through to the app (miss restores the 302)', async () => {
    const stub = await startS3Stub(await projectFixtureToBucket(FIXTURE_ROOT), BUCKET);
    const { server, url } = await serveBucket({
      endpoint: stub.url,
      bucket: BUCKET,
      region: 'auto',
      credentials: CREDENTIALS,
      liveFallback: true
    });
    try {
      const miss = await fetch(`${url}/20140403040000/http://example.com/not-in-bucket`, { redirect: 'manual' });
      assert.equal(miss.status, 302);
      assert.equal(miss.headers.get('location'), 'https://web.archive.org/web/20140403040000/http://example.com/not-in-bucket');
      assert.equal(miss.headers.get('cache-control'), 'no-store');
    } finally {
      await new Promise(resolve => server.close(resolve));
      await stub.close();
    }
  });
});
