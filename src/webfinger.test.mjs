// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: WebFinger tests — resource parsing, JRD shape, resolve via NIP-05,
// ABOUTME: 404 for unknown users, and the full handler.

import { describe, it, expect } from 'vitest';
import { parseAcctResource, buildWebfingerJrd, handleWebfinger } from './webfinger.mjs';

const AP_DOMAIN = 'divine.video';

describe('parseAcctResource', () => {
  it('parses acct:user@host', () => {
    expect(parseAcctResource('acct:alice@divine.video')).toEqual({ user: 'alice', host: 'divine.video' });
  });
  it('parses a bare user@host', () => {
    expect(parseAcctResource('alice@my-worker.workers.dev')).toEqual({ user: 'alice', host: 'my-worker.workers.dev' });
  });
  it('rejects malformed resources', () => {
    expect(parseAcctResource('')).toBeNull();
    expect(parseAcctResource('acct:@host')).toBeNull();
    expect(parseAcctResource('acct:user@')).toBeNull();
    expect(parseAcctResource('acct:nohost')).toBeNull();
    expect(parseAcctResource(null)).toBeNull();
  });
});

describe('buildWebfingerJrd', () => {
  it('builds a JRD with rel:self -> the gateway actor URL', () => {
    const jrd = buildWebfingerJrd({ user: 'alice', host: 'my-worker.workers.dev', apDomain: AP_DOMAIN });
    expect(jrd.subject).toBe('acct:alice@my-worker.workers.dev'); // echoes the request host
    expect(jrd.aliases).toContain('https://divine.video/ap/users/alice');
    expect(jrd.aliases).toContain('https://alice.divine.video');
    const self = jrd.links.find((l) => l.rel === 'self');
    expect(self.type).toBe('application/activity+json');
    expect(self.href).toBe('https://divine.video/ap/users/alice');
    const profile = jrd.links.find((l) => l.rel === 'http://webfinger.net/rel/profile-page');
    expect(profile.type).toBe('text/html');
    expect(profile.href).toBe('https://alice.divine.video');
  });
});

describe('handleWebfinger', () => {
  const nameServer = {
    async resolvePubkey(username) {
      return username === 'alice' ? 'pub_alice' : null;
    },
  };

  it('returns 200 + a JRD for a resolvable username', async () => {
    const res = await handleWebfinger({
      resource: 'acct:alice@divine.video',
      nameServer,
      apDomain: AP_DOMAIN,
    });
    expect(res.status).toBe(200);
    expect(res.jrd.subject).toBe('acct:alice@divine.video');
    expect(res.jrd.links.find((l) => l.rel === 'self').href).toBe('https://divine.video/ap/users/alice');
  });

  it('accepts any acct host (echoed into subject) and still points self at AP_DOMAIN', async () => {
    const res = await handleWebfinger({
      resource: 'acct:alice@my-worker.workers.dev',
      nameServer,
      apDomain: AP_DOMAIN,
    });
    expect(res.status).toBe(200);
    expect(res.jrd.subject).toBe('acct:alice@my-worker.workers.dev');
    expect(res.jrd.links.find((l) => l.rel === 'self').href).toBe('https://divine.video/ap/users/alice');
  });

  it('returns the JRD for any well-formed handle (lenient — actor enforces existence)', async () => {
    const res = await handleWebfinger({
      resource: 'acct:ghost@divine.video',
      nameServer,
      apDomain: AP_DOMAIN,
    });
    expect(res.status).toBe(200);
    expect(res.jrd.subject).toBe('acct:ghost@divine.video');
  });

  it('returns 400 for a malformed resource', async () => {
    const res = await handleWebfinger({ resource: 'garbage', nameServer, apDomain: AP_DOMAIN });
    expect(res.status).toBe(400);
  });
});
