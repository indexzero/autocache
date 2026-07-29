/**
 * SigV4 signer (src/sigv4.ts) pinned against PUBLISHED AWS test vectors — the
 * canonicalization and the HMAC chain are exactly right, or these fail offline.
 *
 * Two official worked examples, two different well-known credential sets:
 *
 *  1. aws-sig-v4-test-suite `get-vanilla` — the generic (service !== 's3')
 *     case: no payload-hash header, host + x-amz-date only.
 *     https://github.com/aws/aws-sdk-js-v3 (aws-crt aws-sig-v4-test-suite)
 *  2. S3 "GET Object" from the AWS docs signing-a-request worked example —
 *     the S3 case: signed x-amz-content-sha256, a Range header, single-encoded
 *     path. Its canonical-request SHA-256 is the docs' published
 *     `7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972`, and
 *     the signature is cross-verified against the battle-tested `aws4fetch`
 *     reference signer (which produces the identical value when it signs the
 *     Range header — it excludes Range by default) — an independent oracle.
 *     https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-auth-using-authorization-header.html
 *
 * Both fix the signing instant via the injectable `date`, so the signature is
 * deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest } from '../src/sigv4.ts';

describe('signRequest — AWS SigV4 published vectors', () => {
  it('aws-sig-v4-test-suite get-vanilla', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      // The generic vector hashes the empty payload (no x-amz-content-sha256
      // header for service !== 's3'); pass its hash explicitly.
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      date: new Date('2015-08-30T12:36:00Z')
    });

    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
    assert.equal(headers['x-amz-date'], '20150830T123600Z');
    assert.equal(headers.host, 'example.amazonaws.com');
    assert.equal('x-amz-content-sha256' in headers, false); // not S3 → not signed
  });

  it('AWS docs S3 "GET Object" worked example', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      headers: { Range: 'bytes=0-9' },
      // The docs example transfers the payload's empty-string hash (not
      // UNSIGNED-PAYLOAD) as x-amz-content-sha256.
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      date: new Date('2013-05-24T00:00:00Z')
    });

    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=67fe34c8530db585abddc51067328adfedb6e42487d2566dc7d927d6e2722900'
    );
    assert.equal(headers['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('UNSIGNED-PAYLOAD is the default S3 payload hash (a bodiless read)', async () => {
    const headers = await signRequest({
      method: 'HEAD',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
    });
    assert.equal(headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  });

  it('a session token is signed in as x-amz-security-token', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN/123+=' }
    });
    assert.equal(headers['x-amz-security-token'], 'TOKEN/123+=');
    assert.ok(headers.authorization.includes('x-amz-security-token'));
  });
});
