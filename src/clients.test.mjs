// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the moderation gate predicate (fail-closed) + NIP-05 resolution.

import { describe, it, expect } from 'vitest';
import {
  verdictAllowsFederation,
  makeModerationGate,
  createNameServerClient,
} from './clients.mjs';

describe('verdictAllowsFederation (permissive MVP)', () => {
  it('allows a moderated, safe, not-blocked, not-quarantined video', () => {
    expect(verdictAllowsFederation({ moderated: true, blocked: false, quarantined: false, action: 'SAFE' })).toBe(true);
  });
  it('allows when action absent but moderated + clean', () => {
    expect(verdictAllowsFederation({ moderated: true })).toBe(true);
  });
  it('rejects a quarantined video', () => {
    expect(verdictAllowsFederation({ moderated: true, quarantined: true })).toBe(false);
  });
  it('rejects a blocked video', () => {
    expect(verdictAllowsFederation({ moderated: true, blocked: true })).toBe(false);
  });
  it('ALLOWS an un-moderated video (permissive: federate unless explicitly bad)', () => {
    expect(verdictAllowsFederation({ moderated: false })).toBe(true);
    expect(verdictAllowsFederation(null)).toBe(true);
    expect(verdictAllowsFederation({})).toBe(true);
  });
  it('allows REVIEW, rejects QUARANTINE/BLOCKED actions', () => {
    expect(verdictAllowsFederation({ moderated: true, action: 'REVIEW' })).toBe(true);
    expect(verdictAllowsFederation({ action: 'QUARANTINE' })).toBe(false);
    expect(verdictAllowsFederation({ action: 'PERMANENT_BAN' })).toBe(false);
  });
});

describe('makeModerationGate', () => {
  it('filters a quarantined video by sha256', async () => {
    const moderation = {
      async checkResult(sha) {
        if (sha === 'quar') return { moderated: true, quarantined: true };
        return { moderated: true, action: 'SAFE' };
      },
    };
    const gate = makeModerationGate(moderation);
    expect(await gate({ sha256: 'safe' })).toBe(true);
    expect(await gate({ sha256: 'quar' })).toBe(false);
  });
  it('fails closed when sha256 missing', async () => {
    const gate = makeModerationGate({ async checkResult() { return { moderated: true }; } });
    expect(await gate({})).toBe(false);
  });
  it('fails closed when moderation lookup throws', async () => {
    const gate = makeModerationGate({ async checkResult() { throw new Error('boom'); } });
    expect(await gate({ sha256: 'x' })).toBe(false);
  });
});

describe('createNameServerClient.resolvePubkey', () => {
  it('reads the NIP-05 names map', async () => {
    const fetchImpl = async (url) => {
      expect(url).toContain('/.well-known/nostr.json?name=alice');
      return new Response(JSON.stringify({ names: { alice: 'pub_alice' } }), { status: 200 });
    };
    const ns = createNameServerClient({ baseUrl: 'https://divine.video', fetchImpl });
    expect(await ns.resolvePubkey('alice')).toBe('pub_alice');
  });
  it('returns null for unknown user', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ names: {} }), { status: 200 });
    const ns = createNameServerClient({ baseUrl: 'https://divine.video', fetchImpl });
    expect(await ns.resolvePubkey('ghost')).toBeNull();
  });
});
