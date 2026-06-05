// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Unit tests for LocalKeycastClient — keys persist in D1, are stable
// ABOUTME: across instances, and sign/verify round-trips against the stored PEM.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLocalKeycastClient } from './signer-local.mjs';
import { initSchema } from './db.mjs';
import { verifySignature } from './http-signature.mjs';

const ACTOR = 'https://divine.video/ap/users/alice';

describe('LocalKeycastClient', () => {
  beforeEach(async () => {
    await initSchema(env.AP_DB);
    await env.AP_DB.prepare('DELETE FROM local_keys').run();
  });

  it('persists a generated key in D1 and reuses it across instances', async () => {
    const signer1 = createLocalKeycastClient({ db: env.AP_DB });
    const pem1 = await signer1.getPublicKeyPem(ACTOR);
    expect(pem1).toContain('-----BEGIN PUBLIC KEY-----');

    // A fresh instance (simulating a new stateless invocation) returns the SAME
    // key — it must read the persisted row, not mint a new one.
    const signer2 = createLocalKeycastClient({ db: env.AP_DB });
    const pem2 = await signer2.getPublicKeyPem(ACTOR);
    expect(pem2).toBe(pem1);

    // Exactly one row stored for the actor.
    const row = await env.AP_DB.prepare('SELECT COUNT(*) AS n FROM local_keys WHERE actor = ?').bind(ACTOR).first();
    expect(row.n).toBe(1);
  });

  it('signs with the stored private key; signature verifies against the stored PEM', async () => {
    const signer = createLocalKeycastClient({ db: env.AP_DB });
    const pem = await signer.getPublicKeyPem(ACTOR);
    const signingString = '(request-target): post /inbox\nhost: remote.example';
    const sig = await signer.sign(ACTOR, signingString);

    // Verify the produced signature against the persisted public key using the
    // gateway's own verifier (the same path inbound signatures take).
    const result = await verifySignature({
      method: 'POST',
      path: '/inbox',
      headers: {
        host: 'remote.example',
        signature: `keyId="${ACTOR}#main-key",algorithm="rsa-sha256",headers="(request-target) host",signature="${sig}"`,
      },
      fetchPublicKeyPem: async () => pem,
    });
    expect(result.ok).toBe(true);
  });

  it('keeps distinct keys per actor', async () => {
    const signer = createLocalKeycastClient({ db: env.AP_DB });
    const a = await signer.getPublicKeyPem('https://divine.video/ap/users/alice');
    const b = await signer.getPublicKeyPem('https://divine.video/ap/users/bob');
    expect(a).not.toBe(b);
  });
});
