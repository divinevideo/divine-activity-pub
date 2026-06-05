// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: LocalKeycastClient — a self-contained KeycastClient that mints + stores
// ABOUTME: per-actor RSA keys IN D1 and signs locally. DEV/STAGING ONLY (holds keys).
//
// ⚠️ SECURITY: this implementation persists PRIVATE keys (PKCS8) in the gateway's
// own D1. That is acceptable for local dev / staging smoke tests so the gateway
// can run end-to-end WITHOUT keycast. In PRODUCTION the gateway must NOT hold
// private keys — set SIGNER_MODE=keycast so signing happens in keycast and the
// private key never leaves it. See SETUP.md §"switch to keycast".

import { base64FromBytes, bytesFromBase64 } from './http-signature.mjs';

/**
 * Build a LocalKeycastClient. Implements the SAME interface as the real
 * KeycastClient (`getPublicKeyPem`, `sign`) so it is drop-in injectable.
 *
 * Keys are generated on first use per actor and persisted in D1 table
 * `local_keys`, so they are STABLE across stateless Worker invocations.
 *
 * @param {object} opts
 * @param {D1Database} opts.db the gateway D1 binding (env.AP_DB)
 * @returns {{ getPublicKeyPem(actor:string):Promise<string>, sign(actor:string, signingString:string):Promise<string> }}
 */
export function createLocalKeycastClient({ db }) {
  if (!db) throw new Error('LocalKeycastClient requires a D1 binding (db)');

  /**
   * Return the stored key row for an actor, generating + persisting one on first
   * use. Concurrent first-use is resolved via INSERT OR IGNORE + re-read so two
   * racing invocations converge on a single stored keypair.
   */
  async function ensureKey(actor) {
    const existing = await db
      .prepare('SELECT public_pem, private_pkcs8 FROM local_keys WHERE actor = ?')
      .bind(actor)
      .first();
    if (existing) return existing;

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
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const publicPem = derToPem(spki, 'PUBLIC KEY');
    const privatePkcs8B64 = base64FromBytes(pkcs8);

    await db
      .prepare(
        `INSERT INTO local_keys (actor, public_pem, private_pkcs8, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(actor) DO NOTHING`,
      )
      .bind(actor, publicPem, privatePkcs8B64, Date.now())
      .run();

    // Re-read so a racing inserter's row (if it won) is the one we use.
    return db
      .prepare('SELECT public_pem, private_pkcs8 FROM local_keys WHERE actor = ?')
      .bind(actor)
      .first();
  }

  return {
    async getPublicKeyPem(actor) {
      const row = await ensureKey(actor);
      return row.public_pem;
    },

    async sign(actor, signingString) {
      const row = await ensureKey(actor);
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        bytesFromBase64(row.private_pkcs8),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        privateKey,
        new TextEncoder().encode(signingString),
      );
      return base64FromBytes(new Uint8Array(sig));
    },
  };
}

function derToPem(der, label) {
  const b64 = base64FromBytes(der);
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
