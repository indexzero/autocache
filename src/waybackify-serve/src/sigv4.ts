/**
 * AWS Signature Version 4 signing — WebCrypto only, so it runs unchanged on
 * every target the mirror serves from: Cloudflare Workers, Fastly Compute, and
 * Node ≥ 20 (crypto.subtle is a global on all three —
 * https://nodejs.org/api/globals.html#crypto). ZERO `node:` imports on purpose:
 * this module (and its only consumer, src/s3store.ts) must typecheck under the
 * no-Node-types tsconfig graph (tsconfig.fastly.json) so a stray Node global
 * fails the build here, not on the edge.
 *
 * The one job: sign a read of an S3-compatible object (HEAD/GET) with an
 * UNSIGNED-PAYLOAD body hash — the object bytes are never in the request, so
 * hashing them would be wasted work and, for HEAD, impossible. Implemented
 * clause-by-clause against the AWS reference:
 *
 *   - Canonical request:
 *     https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html#create-canonical-request
 *   - String to sign + signing-key derivation (the HMAC chain):
 *     https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html#derive-signing-key
 *   - UNSIGNED-PAYLOAD for S3:
 *     https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 *
 * The signer is unit-pinned against the published AWS SigV4 test vectors
 * (test/sigv4.test.ts): the aws-sig-v4-test-suite `get-vanilla` case and the
 * S3 "GET Object" worked example from the docs above — both with the canonical
 * example credentials, so any drift in the canonicalization or the HMAC chain
 * fails loudly and offline.
 */

const encoder = new TextEncoder();

/** UNSIGNED-PAYLOAD — the S3 body-hash sentinel for reads (no body to hash). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS temporary-credential token; rides the signed X-Amz-Security-Token. */
  sessionToken?: string;
}

export interface SignRequestInput {
  method: string;
  /** The absolute request URL — its authority becomes the signed Host. */
  url: URL | string;
  region: string;
  /** e.g. `s3`. S3 alone signs the payload-hash header and single-encodes paths. */
  service: string;
  credentials: SigV4Credentials;
  /** Extra headers to sign; Host + X-Amz-Date (+ payload hash for S3) are added. */
  headers?: Record<string, string>;
  /** SHA-256 hex of the body, or UNSIGNED-PAYLOAD (the default — right for GET/HEAD). */
  payloadHash?: string;
  /** Signing instant; defaults to now. Injectable so tests can pin AWS vectors. */
  date?: Date;
}

/**
 * Sign a request. Returns the exact header set that was signed PLUS the
 * Authorization header — the caller sets precisely these on the wire (dropping
 * a signed header, or mutating a signed value, is a 403). Header names are
 * lowercased, which is both the canonical form and case-insensitively correct
 * on the wire.
 */
export async function signRequest(input: SignRequestInput): Promise<Record<string, string>> {
  const url = input.url instanceof URL ? input.url : new URL(input.url);
  const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
  const amzDate = toAmzDate(input.date ?? new Date()); // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8); //             20150830

  // Headers to sign. Host is derived from the URL authority (never a
  // caller-supplied value); X-Amz-Date scopes the signature in time. S3
  // additionally SIGNS the payload-hash header — the generic SigV4 vectors
  // (service !== 's3') carry the hash only in the canonical request's last
  // line, which is exactly how the get-vanilla vector is shaped.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  headers.host = url.host;
  headers['x-amz-date'] = amzDate;
  if (input.service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  // Canonical headers: lowercase name, value trimmed + inner whitespace
  // collapsed, sorted by name. Signed-headers is that name list, `;`-joined.
  const entries = Object.entries(headers)
    .map(([name, value]) => [name, value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url, input.service),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const signingKey = await deriveSigningKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service);
  const signature = hex(await hmac(signingKey, stringToSign));

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

/**
 * CanonicalURI: each path segment URI-encoded (RFC 3986), `/` preserved. S3
 * encodes ONCE and never normalizes the path; every other service encodes
 * twice. The URL parser has already percent-encoded the pathname, so a segment
 * is decoded before re-encoding to avoid double-encoding an already-escaped
 * octet. Our object keys are `cap/<aa>/<hash>` (hex + slashes) so this is
 * effectively identity, but the rule is implemented faithfully for the vectors.
 */
function canonicalUri(url: URL, service: string): string {
  const doubleEncode = service !== 's3';
  const encoded = (url.pathname || '/')
    .split('/')
    .map(segment => encodeSegment(safeDecode(segment), doubleEncode))
    .join('/');
  return encoded || '/';
}

/** CanonicalQueryString: `k=v` pairs, RFC-3986 encoded, sorted. Empty for reads. */
function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([k, v]) => [rfc3986(encodeURIComponent(k)), rfc3986(encodeURIComponent(v))] as const)
    .sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function encodeSegment(segment: string, doubleEncode: boolean): string {
  const once = rfc3986(encodeURIComponent(segment));
  return doubleEncode ? rfc3986(encodeURIComponent(once)) : once;
}

/** encodeURIComponent leaves `!'()*` unescaped; RFC 3986 requires them escaped. */
function rfc3986(value: string): string {
  return value.replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** decodeURIComponent, but tolerant of a malformed segment (return it verbatim). */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The kDate → kRegion → kService → kSigning HMAC chain (AWS derive-signing-key). */
async function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(`AWS4${secret}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function hmac(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

/** ISO-8601 basic format the signature demands: `20150830T123600Z`. */
function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}
