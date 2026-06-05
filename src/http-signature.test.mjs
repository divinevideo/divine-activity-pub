// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: HTTP Signature tests — pinned known-good vector, tamper rejection,
// ABOUTME: signing-string construction, digest, and full sign->verify round-trip.

import { describe, it, expect } from 'vitest';
import {
  buildSigningString,
  parseSignatureHeader,
  computeDigest,
  verifySignature,
  buildSignedRequest,
} from './http-signature.mjs';
import { createFakeKeycastClient } from './keycast.mjs';

// --- Pinned known-good vector (generated offline with node:crypto, NOT by this
// code) so verify is tested against bytes the implementation didn't produce. ---
// Signed over a header set WITHOUT `digest` so verify needs no body — isolates
// pure RSA signature verification against bytes this code did not produce.
const PINNED = {
  publicKey:
    '-----BEGIN PUBLIC KEY-----\n' +
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtaKzvLBYUy7DhcFvypO0\n' +
    'X+1NFQPYT9SvL9DvZUmUhduCk8nzDlJObadBzz9/4eufhV6pZ2uhv5DFB4IDY2Gw\n' +
    'LmLZ+sFUh0wPBwgIkFMUZGjCDrN6IdcVPtb7HdDIHuo0ofajZddGIwoAwAWw9Jv8\n' +
    'HQeVY62D8jceThhadQPRtKJgpoz5zfag06r/is0nye39QoimxcmhKAAaeZX+j3Ee\n' +
    'PyjeqON0u8P5Z7sBuId12jaAHe7nGXK6Tboc7guoKyBlyZKNefL2LQHlibzwRzNz\n' +
    'qMRAPeFbSd8XwoaZfZ3iSGVTX5TJzbmLX1cRq3yy5B8s7lCoDsfzZ0fO2REuGfxu\n' +
    'LwIDAQAB\n' +
    '-----END PUBLIC KEY-----\n',
  signingString:
    '(request-target): post /ap/users/alice/inbox\n' +
    'host: divine.video\n' +
    'date: Tue, 30 May 2026 00:00:00 GMT',
  signature:
    'QP0UmWwVrAJtOzcEW0jVevep0zv0feOytZmj0xJcBSY1O9K6UL+y49Fk+Mg+GLn507VKk6aSEzAI9dL1o9BVi44lkbf8amvzK8YMScznlmCVrlo3X7oQccI/OVTjZAGy4DL9pDrT86P0oSDZ769Qh/yEjyEGupPPwTTFnPusYFzXQoPcljYQicbtCXzATH5JPM8TsDBAuoYK+EOQrEMG7uwSCZy90w8g1e2Pki+kKPlbpZNqRtzvxs0PN3KNRAH9t+5o5CNApzFjl6CYhCs9x5iqFqxL2TJYcJnNWtXzPa3DBnc74gK3Q5CmAfW6c0/7zvaG47g19Dur4PnxEiSSwQ==',
};

describe('buildSigningString', () => {
  it('reconstructs the draft-cavage string incl (request-target)', () => {
    const s = buildSigningString({
      headerNames: ['(request-target)', 'host', 'date'],
      method: 'POST',
      path: '/ap/users/alice/inbox',
      headers: {
        host: 'divine.video',
        date: 'Tue, 30 May 2026 00:00:00 GMT',
      },
    });
    expect(s).toBe(PINNED.signingString);
  });

  it('throws on a missing referenced header', () => {
    expect(() => buildSigningString({
      headerNames: ['(request-target)', 'host'],
      method: 'GET', path: '/x', headers: {},
    })).toThrow(/missing header/);
  });
});

describe('parseSignatureHeader', () => {
  it('parses keyId, algorithm, headers, signature', () => {
    const parsed = parseSignatureHeader(
      'keyId="https://x/actor#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="AAAA"',
    );
    expect(parsed.keyId).toBe('https://x/actor#main-key');
    expect(parsed.algorithm).toBe('rsa-sha256');
    expect(parsed.headers).toEqual(['(request-target)', 'host', 'date']);
    expect(parsed.signature).toBe('AAAA');
  });
});

describe('computeDigest', () => {
  it('produces a SHA-256= base64 digest', async () => {
    const d = await computeDigest('');
    // SHA-256 of empty string.
    expect(d).toBe('SHA-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });
});

describe('verifySignature — pinned known-good vector', () => {
  const headers = {
    host: 'divine.video',
    date: 'Tue, 30 May 2026 00:00:00 GMT',
    signature:
      `keyId="https://remote/actor#main-key",algorithm="rsa-sha256",` +
      `headers="(request-target) host date",signature="${PINNED.signature}"`,
  };

  it('accepts a valid signature against bytes the code did not produce', async () => {
    const res = await verifySignature({
      method: 'POST',
      path: '/ap/users/alice/inbox',
      headers,
      fetchPublicKeyPem: async () => PINNED.publicKey,
    });
    expect(res.ok).toBe(true);
    expect(res.keyId).toBe('https://remote/actor#main-key');
  });

  it('rejects a tampered signing string (wrong path)', async () => {
    const res = await verifySignature({
      method: 'POST',
      path: '/ap/users/EVE/inbox', // tampered
      headers,
      fetchPublicKeyPem: async () => PINNED.publicKey,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signature invalid');
  });

  it('rejects a flipped signature byte', async () => {
    const bad = { ...headers };
    const flipped = PINNED.signature.slice(0, -4) + (PINNED.signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    bad.signature =
      `keyId="https://remote/actor#main-key",algorithm="rsa-sha256",` +
      `headers="(request-target) host date",signature="${flipped}"`;
    const res = await verifySignature({
      method: 'POST',
      path: '/ap/users/alice/inbox',
      headers: bad,
      fetchPublicKeyPem: async () => PINNED.publicKey,
    });
    expect(res.ok).toBe(false);
  });
});

describe('verifySignature — digest validation', () => {
  it('rejects when the body does not match the signed digest', async () => {
    const res = await verifySignature({
      method: 'POST',
      path: '/ap/users/alice/inbox',
      headers: {
        host: 'divine.video',
        date: 'Tue, 30 May 2026 00:00:00 GMT',
        digest: 'SHA-256=abc123=',
        signature:
          `keyId="k#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${PINNED.signature}"`,
      },
      body: 'a different body than was digested',
      fetchPublicKeyPem: async () => PINNED.publicKey,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('digest mismatch');
  });
});

describe('full sign -> verify round-trip (WebCrypto via fake keycast)', () => {
  it('a signed request verifies; tampering it fails', async () => {
    const keycast = createFakeKeycastClient();
    const actor = 'https://divine.video/ap/users/alice';
    const keyId = `${actor}#main-key`;
    const body = JSON.stringify({ type: 'Create', hello: 'world' });

    const { headers } = await buildSignedRequest({
      method: 'POST',
      url: 'https://remote.example/inbox',
      body,
      keyId,
      // keycast is keyed on the actor URL (must match getPublicKeyPem below).
      sign: (s) => keycast.sign(actor, s),
    });

    // Reconstruct the lowercased header map a server would build.
    const hdrMap = {
      host: headers.Host,
      date: headers.Date,
      digest: headers.Digest,
      'content-type': headers['Content-Type'],
      signature: headers.Signature,
    };

    const good = await verifySignature({
      method: 'POST',
      path: '/inbox',
      headers: hdrMap,
      body,
      fetchPublicKeyPem: () => keycast.getPublicKeyPem(actor),
    });
    expect(good.ok).toBe(true);

    const tampered = await verifySignature({
      method: 'POST',
      path: '/inbox',
      headers: hdrMap,
      body: body + 'x', // body changed -> digest mismatch
      fetchPublicKeyPem: () => keycast.getPublicKeyPem(actor),
    });
    expect(tampered.ok).toBe(false);
  });
});
