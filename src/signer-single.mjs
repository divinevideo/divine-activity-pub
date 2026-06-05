// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: SingleKeySigner — ONE RSA keypair shared by ALL actors (SIGNER_MODE=single).
// ABOUTME: Same interface as the other signers. MVP-only: blast radius = every user.

import { base64FromBytes, bytesFromBase64 } from './http-signature.mjs';

// Env contract (read this carefully before provisioning):
//
//   SINGLE_SIGNING_KEY_PKCS8  (SECRET, `wrangler secret put`)
//     The RSA PRIVATE key in PKCS8 DER, **base64-encoded** (the base64 body
//     ONLY — no `-----BEGIN PRIVATE KEY-----` header/footer, no newlines).
//     This is exactly `base64(DER)` — the same form signer-local.mjs persists.
//     Generate (node):
//       node -e 'const c=require("crypto");const{privateKey,publicKey}=c.generateKeyPairSync("rsa",{modulusLength:2048});console.log("PKCS8_B64="+privateKey.export({type:"pkcs8",format:"der"}).toString("base64"));console.log(publicKey.export({type:"spki",format:"pem"}))'
//     Or (openssl): generate a PKCS8 PEM, then strip header/footer/newlines:
//       openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out key.pem
//       openssl pkcs8 -topk8 -nocrypt -in key.pem -outform DER | base64 | tr -d '\n'
//
//   SINGLE_SIGNING_PUBLIC_PEM  (VAR or secret)
//     The matching RSA PUBLIC key in SPKI **PEM text**, i.e. the full
//     `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----` block. This
//     string is published verbatim as every actor's `publicKey.publicKeyPem`.
//       openssl pkey -in key.pem -pubout   # prints the SPKI PEM

/**
 * Build a SingleKeySigner. Implements the SAME interface as the other signers
 * (`getPublicKeyPem(actor)`, `sign(actor, signingString)`) but uses ONE keypair
 * for every actor: each actor doc publishes the same `publicKeyPem` under its
 * own `#main-key` / `owner`, which is valid and verifies fine.
 *
 * ⚠️ MVP ONLY. A single shared key means one compromised key impersonates EVERY
 * user (blast radius = all actors). Migrate to SIGNER_MODE=keycast for prod.
 *
 * Fails closed: if either env value is missing/blank, every call throws.
 *
 * @param {object} opts
 * @param {string} opts.privatePkcs8B64 base64(PKCS8 DER) private key (SINGLE_SIGNING_KEY_PKCS8)
 * @param {string} opts.publicPem SPKI PEM text (SINGLE_SIGNING_PUBLIC_PEM)
 * @returns {{ getPublicKeyPem(actor:string):Promise<string>, sign(actor:string, signingString:string):Promise<string> }}
 */
export function createSingleKeySigner({ privatePkcs8B64, publicPem }) {
  if (!privatePkcs8B64 || !privatePkcs8B64.trim()) {
    throw new Error('SIGNER_MODE=single requires SINGLE_SIGNING_KEY_PKCS8 (base64 PKCS8 private key)');
  }
  if (!publicPem || !publicPem.includes('BEGIN PUBLIC KEY')) {
    throw new Error('SIGNER_MODE=single requires SINGLE_SIGNING_PUBLIC_PEM (SPKI public key PEM text)');
  }

  // Import the private key once and reuse the promise across all actors/signs.
  let privateKeyPromise = null;
  function getPrivateKey() {
    if (!privateKeyPromise) {
      privateKeyPromise = crypto.subtle.importKey(
        'pkcs8',
        bytesFromBase64(privatePkcs8B64.trim()),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    }
    return privateKeyPromise;
  }

  return {
    // The SAME public PEM for every actor — by design.
    async getPublicKeyPem(_actor) {
      return publicPem;
    },

    async sign(_actor, signingString) {
      const privateKey = await getPrivateKey();
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        privateKey,
        new TextEncoder().encode(signingString),
      );
      return base64FromBytes(new Uint8Array(sig));
    },
  };
}
