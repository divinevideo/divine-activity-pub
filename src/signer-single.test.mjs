// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: SingleKeySigner tests — one shared key for all actors; sign/verify
// ABOUTME: round-trip against the published public PEM; fail-closed on missing env.

import { describe, it, expect } from 'vitest';
import { createSingleKeySigner } from './signer-single.mjs';
import { verifySignature } from './http-signature.mjs';

// Fixture keypair (generated offline with node:crypto). The private key is the
// PKCS8 DER **base64** the SINGLE_SIGNING_KEY_PKCS8 secret holds; the public is
// the SPKI **PEM text** the SINGLE_SIGNING_PUBLIC_PEM var holds.
const PKCS8_B64 =
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC1rzyqhgMN+BbtSsQp27MzzU1BJoEBQSIwqXj0d0yyKGE8z9qpsFGGB2154snfOSmHelk12/OGh8m96K01PZqkQIWpJsZHeiCoKUiYk/x5Hk7khldgSHYJBKDbdAnD90GER4pYWklQ/1S4B1Uhn69AhWbd5MTe/Po2AWL5KMphRx7n9+3kLpWkka5sviM611g/sXzvVAgl9cuvPmnqwhVu7FtxITnXsSKWySWzQYbxFnCd8thIeUh7sOwAjLuf+t3lPDs06TA7fcVD9QC8Dz/QR2hKFRLfsN8UWJxsHLQO40p7+IfFl9xnFhT+cUIFv+f9fMG4soY/eYdzK30rlWuNAgMBAAECggEAAdPZkA28OSFuOfjqsfPSTGqY2TSC/fZf5lmuyWFI64iVFdCOtGLl+Hzw6WF1H79482yZ3QjIxdHifDaBRbSxEUy3lDNpyLjp0IuVCX8j8oE33DYpL6j671YyWsFOdu58jS438+YE9lLXi10ThLyoPZcLY3B3QZbHw4ofwibaeqkBLCshiGvvTnzFa9D8jyMhl+RRLvzeErr4IHesoiLAK9F/oxEji+9vNsEO0G7mA0dfn9C7Rjf7875MJ1/j6rrk0jINeOCOjuXStqzRuKa8QJSLuu9BMLQJ3gMvBy5YRW71jrS5bR1V5b0TYq0lH/FS1oLIILb101CYGP4foRIF9wKBgQDr5O7kDtCLP/lDC2mTiQESxiE17oy9eVoHuiI/QsmiDcGJ0gBooE4yKoapodDyImbDKm5XEgOplTaUx+UGIf7I8qKCABFHA0qYc6jjtVpSnT/M11nJXV5YY/DpsZeQ659tZ/JUfsHEoYjJ6iVnbEcVztfnX2Tj8o0PTj32m/UyKwKBgQDFK3sKv6IawDY97ci0JmL875A/gZ1hh8DWDqQGyphKIu7En02yPpP4WIaTSIksVGxJT7ktZ61r4yaWwL+1Ljzuaj0TfGQx8ZrIE7+qSPzFODog/VHOXumvG+IPeCEN1Im/3xVz7RmogMY961U7xboKU0uEh03iF5gqErtCfffVJwKBgF+AxyrzyICn/N2k8DB4BkQ4jNeN5dMMH2QDerwL6SA/23xV1i6FwELVLsHcroBpZxtawWNk+rCcpYVkzJdICiQG/74MEvKiJYBFSzotgQzzdxISmdpJf9nfVHj4mnlku54KuHR3ATH/iCbfMheGId11abnVyD31RCDPN4zxJTsTAoGBALOMhN+k4tm5b6u1fa+PxVTQU2uBfO/zz4cejgAhPc1FQmmLKBXJJrZg5yv4QfI8bt/T2a2fXC2DDQD7RZiYIqR52mSEQjm46lqIoWFQVd7C9SxVgsmLZQIxQgsUOgV+JnKzk7WdlF/95Ik+ZL+pr2D3uS1WiXX6RncJ170VOTrBAoGBALpmW6eRxOKAvCWTKz0+dhNgWTuMbZM+d00mfmzMaNWZVu6nbMir3DAUicrO69QGSgvYWuU/ckScA9Ac/H04OxxAHqF6vMmJzNsdeexT4NOy0BdiuAxwhwaRpJIeO6S4B/MCvFEQ94HT8EoFmgQGR1RUJAiZtAZEVVWUeeUE9MEU';

const PUBLIC_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAta88qoYDDfgW7UrEKduz\n' +
  'M81NQSaBAUEiMKl49HdMsihhPM/aqbBRhgdteeLJ3zkph3pZNdvzhofJveitNT2a\n' +
  'pECFqSbGR3ogqClImJP8eR5O5IZXYEh2CQSg23QJw/dBhEeKWFpJUP9UuAdVIZ+v\n' +
  'QIVm3eTE3vz6NgFi+SjKYUce5/ft5C6VpJGubL4jOtdYP7F871QIJfXLrz5p6sIV\n' +
  'buxbcSE517Eilskls0GG8RZwnfLYSHlIe7DsAIy7n/rd5Tw7NOkwO33FQ/UAvA8/\n' +
  '0EdoShUS37DfFFicbBy0DuNKe/iHxZfcZxYU/nFCBb/n/XzBuLKGP3mHcyt9K5Vr\n' +
  'jQIDAQAB\n' +
  '-----END PUBLIC KEY-----\n';

const ACTOR_A = 'https://divine.video/ap/users/alice';
const ACTOR_B = 'https://divine.video/ap/users/bob';

describe('SingleKeySigner', () => {
  it('returns the SAME public PEM for every actor', async () => {
    const signer = createSingleKeySigner({ privatePkcs8B64: PKCS8_B64, publicPem: PUBLIC_PEM });
    const a = await signer.getPublicKeyPem(ACTOR_A);
    const b = await signer.getPublicKeyPem(ACTOR_B);
    expect(a).toBe(PUBLIC_PEM);
    expect(b).toBe(PUBLIC_PEM);
    expect(a).toBe(b);
  });

  it('signs for any actor and the signature verifies against the shared public PEM', async () => {
    const signer = createSingleKeySigner({ privatePkcs8B64: PKCS8_B64, publicPem: PUBLIC_PEM });
    const signingString = '(request-target): post /inbox\nhost: remote.example';

    for (const actor of [ACTOR_A, ACTOR_B]) {
      const sig = await signer.sign(actor, signingString);
      const result = await verifySignature({
        method: 'POST',
        path: '/inbox',
        headers: {
          host: 'remote.example',
          signature: `keyId="${actor}#main-key",algorithm="rsa-sha256",headers="(request-target) host",signature="${sig}"`,
        },
        fetchPublicKeyPem: async () => PUBLIC_PEM,
      });
      expect(result.ok).toBe(true);
    }
  });

  it('two actors signing the SAME string produce the SAME signature (one key)', async () => {
    const signer = createSingleKeySigner({ privatePkcs8B64: PKCS8_B64, publicPem: PUBLIC_PEM });
    const s = '(request-target): post /inbox\nhost: remote.example';
    const sigA = await signer.sign(ACTOR_A, s);
    const sigB = await signer.sign(ACTOR_B, s);
    expect(sigA).toBe(sigB); // deterministic RSASSA-PKCS1-v1_5 over the same input
  });

  it('fails closed when the private key is missing', () => {
    expect(() => createSingleKeySigner({ privatePkcs8B64: '', publicPem: PUBLIC_PEM }))
      .toThrow(/SINGLE_SIGNING_KEY_PKCS8/);
  });

  it('fails closed when the public PEM is missing or malformed', () => {
    expect(() => createSingleKeySigner({ privatePkcs8B64: PKCS8_B64, publicPem: '' }))
      .toThrow(/SINGLE_SIGNING_PUBLIC_PEM/);
    expect(() => createSingleKeySigner({ privatePkcs8B64: PKCS8_B64, publicPem: 'not a pem' }))
      .toThrow(/SINGLE_SIGNING_PUBLIC_PEM/);
  });
});
