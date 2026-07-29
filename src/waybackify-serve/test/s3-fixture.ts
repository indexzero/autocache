/**
 * Shared test rig: project the committed cache-root fixture into the bucket
 * layout the S3Store / parity check read, and stand up a tiny offline
 * path-style S3 endpoint over it. Extracted so node.test.ts (serving) and
 * parity.test.ts (the four-layer gate) drive ONE projection + ONE stub, never
 * two subtly-diverging copies.
 *
 * The projection is the batch-emitter's model made concrete: for every meta
 * sidecar the bucket carries BOTH objects the sync uploads —
 *
 *   cap/<aa>/<hash>          native Content-Type + x-amz-meta-status; a `body`
 *                            entry carries its capture bytes, every bodiless
 *                            status is a zero-byte object (status metadata only).
 *   meta/<aa>/<hash>.json    the sidecar JSON verbatim (DAG durability for GC).
 *
 * The orphan cap/ file has NO sidecar, so it is never projected — matching the
 * native-metadata store, where a torn write cannot exist.
 *
 * The stub answers object HEAD/GET and paginated ListObjectsV2 (list-type=2,
 * continuation tokens). Offline and deterministic — no network, no minio, no S3.
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

/** A recorded bucket object: response headers + exact bytes (empty = bodiless). */
export interface S3Object {
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Project a cache-root into `objectKey → S3Object`, both prefixes. `bucketPrefix`
 * (default none) is prepended to every object key so prefix-scoped buckets can
 * be exercised.
 */
export async function projectFixtureToBucket(root: string, bucketPrefix = ''): Promise<Map<string, S3Object>> {
  const objects = new Map<string, S3Object>();
  const prefix = bucketPrefix ? `${bucketPrefix.replace(/^\/+|\/+$/g, '')}/` : '';
  const metaDir = `${root}/meta`;
  for (const aa of await fsp.readdir(metaDir)) {
    for (const file of await fsp.readdir(`${metaDir}/${aa}`)) {
      const hash = file.replace(/\.json$/, '');
      const rawSidecar = await fsp.readFile(`${metaDir}/${aa}/${file}`);
      const meta = JSON.parse(rawSidecar.toString('utf8'));

      // cap/<aa>/<hash> — the SERVING object.
      const body = meta.status === 'body' ? await fsp.readFile(`${root}/cap/${aa}/${hash}`) : Buffer.alloc(0);
      const capHeaders: Record<string, string> = {
        'x-amz-meta-status': meta.status,
        'Content-Length': String(body.length)
      };
      // Content-Type is uploaded verbatim; '' is simply absent on the wire and
      // the store normalizes an absent header to application/octet-stream.
      if (meta.contentType) capHeaders['Content-Type'] = meta.contentType;
      objects.set(`${prefix}cap/${aa}/${hash}`, { headers: capHeaders, body });

      // meta/<aa>/<hash>.json — the sidecar object (listed by Layer 1, never served).
      objects.set(`${prefix}meta/${aa}/${file}`, {
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(rawSidecar.length) },
        body: rawSidecar
      });
    }
  }
  return objects;
}

export interface S3Stub {
  url: string;
  close: () => Promise<void>;
}

/**
 * A path-style S3 endpoint over recorded objects. Object HEAD/GET answer the
 * recorded headers/bytes (unknown key → 404, the store's one miss); a
 * `?list-type=2` request answers ListObjectsV2 XML, paginated at `pageSize`
 * (default 1000, S3's own cap) so the continuation-token loop is exercisable.
 */
export function startS3Stub(objects: Map<string, S3Object>, bucket: string, pageSize = 1000): Promise<S3Stub> {
  const bucketPath = `/${bucket}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://stub');
    if (url.pathname === bucketPath && url.searchParams.get('list-type') === '2') {
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end(listXml(objects, url, pageSize));
      return;
    }

    const bucketPrefix = `${bucketPath}/`;
    if (!url.pathname.startsWith(bucketPrefix)) {
      res.writeHead(400).end();
      return;
    }
    const object = objects.get(decodeURIComponent(url.pathname.slice(bucketPrefix.length)));
    if (object === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, object.headers);
    // HEAD carries no body (Node also strips it); GET streams the bytes.
    res.end(req.method === 'HEAD' ? undefined : object.body);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(done => server.close(() => done()))
      });
    });
  });
}

/** Render one ListObjectsV2 page: keys under `prefix`, sliced by continuation. */
function listXml(objects: Map<string, S3Object>, url: URL, pageSize: number): string {
  const prefix = url.searchParams.get('prefix') ?? '';
  const start = Number(url.searchParams.get('continuation-token') ?? '0');
  const all = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
  const page = all.slice(start, start + pageSize);
  const truncated = start + pageSize < all.length;

  const contents = page.map(key => `<Contents><Key>${escapeXml(key)}</Key><Size>${objects.get(key)!.body.length}</Size></Contents>`).join('');
  const next = truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ListBucketResult>' +
    `<KeyCount>${page.length}</KeyCount>` +
    `<IsTruncated>${truncated}</IsTruncated>` +
    next +
    contents +
    '</ListBucketResult>'
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
