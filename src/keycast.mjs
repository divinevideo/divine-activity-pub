// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: KeycastClient interface + a real HTTP impl and an in-memory fake.
// ABOUTME: keycast custodies per-actor RSA keys; the gateway never sees private keys.

import { base64FromBytes, bytesFromBase64 } from './http-signature.mjs';

/**
 * @typedef {Object} KeycastClient
 * @property {(actor:string)=>Promise<string>} getPublicKeyPem
 *   Returns the RSA public key PEM for an actor (for publicKey.publicKeyPem).
 * @property {(actor:string, signingString:string)=>Promise<string>} sign
 *   Returns a base64 RSA-SHA256 signature over signingString.
 */

/**
 * Real keycast client (Workstream B contract):
 *  - GET  {base}/api/ap/keys/{actor}        -> { publicKeyPem }
 *  - POST {base}/api/ap/sign {actor, signing_string} -> { signature }  (base64)
 * Private key never leaves keycast.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} [opts.token] bearer token
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {KeycastClient}
 */
export function createKeycastClient({ baseUrl, token, fetchImpl = fetch }) {
  if (!baseUrl) {
    // Fail closed: a missing keycast must not silently produce unsigned output.
    return {
      async getPublicKeyPem() { throw new Error('keycast not configured (KEYCAST_BASE_URL empty)'); },
      async sign() { throw new Error('keycast not configured (KEYCAST_BASE_URL empty)'); },
    };
  }
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  return {
    async getPublicKeyPem(actor) {
      const res = await fetchImpl(`${baseUrl}/api/ap/keys/${encodeURIComponent(actor)}`, {
        headers: { Accept: 'application/json', ...authHeaders },
      });
      if (!res.ok) throw new Error(`keycast keys ${res.status} for ${actor}`);
      const body = await res.json();
      const pem = body.publicKeyPem || body.public_key_pem || body.pem;
      if (!pem) throw new Error(`keycast returned no PEM for ${actor}`);
      return pem;
    },

    async sign(actor, signingString) {
      const res = await fetchImpl(`${baseUrl}/api/ap/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ actor, signing_string: signingString }),
      });
      if (!res.ok) throw new Error(`keycast sign ${res.status} for ${actor}`);
      const body = await res.json();
      const sig = body.signature || body.sig;
      if (!sig) throw new Error(`keycast returned no signature for ${actor}`);
      return sig;
    },
  };
}

/**
 * In-memory fake keycast for tests. Generates a real RSA-2048 keypair per actor
 * via WebCrypto and signs locally, so tests run without the keycast service.
 * @returns {KeycastClient & { getPrivateKey(actor):Promise<CryptoKey> }}
 */
export function createFakeKeycastClient() {
  const keys = new Map(); // actor -> { publicKey, privateKey, pem }

  async function ensure(actor) {
    if (keys.has(actor)) return keys.get(actor);
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const pem = derToPem(new Uint8Array(spki), 'PUBLIC KEY');
    const entry = { publicKey: pair.publicKey, privateKey: pair.privateKey, pem };
    keys.set(actor, entry);
    return entry;
  }

  return {
    async getPublicKeyPem(actor) {
      return (await ensure(actor)).pem;
    },
    async sign(actor, signingString) {
      const { privateKey } = await ensure(actor);
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        privateKey,
        new TextEncoder().encode(signingString),
      );
      return base64FromBytes(new Uint8Array(sig));
    },
    async getPrivateKey(actor) {
      return (await ensure(actor)).privateKey;
    },
  };
}

function derToPem(der, label) {
  const b64 = base64FromBytes(der);
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// Re-export so tests can build base64 bodies without importing two modules.
export { base64FromBytes, bytesFromBase64 };
