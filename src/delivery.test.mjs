// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Delivery fan-out tests — one message per UNIQUE inbox (sharedInbox
// ABOUTME: dedup) and the queue consumer's sign+POST via fake keycast.

import { describe, it, expect } from 'vitest';
import { buildDeliveryMessages, deliverMessage } from './delivery.mjs';
import { createFakeKeycastClient } from './keycast.mjs';
import { verifySignature } from './http-signature.mjs';

const DOMAIN = 'divine.video';
const VIDEO = {
  id: 'evt9',
  video_url: 'https://cdn.divine.video/x.mp4',
  mime_type: 'video/mp4',
  dimensions: '720x1280',
  title: 't',
  content: 'c',
};

describe('buildDeliveryMessages — one message per UNIQUE inbox', () => {
  it('collapses followers behind the same sharedInbox to one message', () => {
    const followers = [
      { follower_inbox: 'https://masto.social/users/a/inbox', shared_inbox: 'https://masto.social/inbox' },
      { follower_inbox: 'https://masto.social/users/b/inbox', shared_inbox: 'https://masto.social/inbox' },
      { follower_inbox: 'https://masto.social/users/c/inbox', shared_inbox: 'https://masto.social/inbox' },
      { follower_inbox: 'https://pixelfed.social/users/d/inbox', shared_inbox: 'https://pixelfed.social/f/inbox' },
      { follower_inbox: 'https://lonely.example/users/e/inbox' }, // no shared inbox
    ];
    const msgs = buildDeliveryMessages({ domain: DOMAIN, username: 'alice', video: VIDEO, followers });
    const inboxes = msgs.map((m) => m.inbox);
    // 5 followers -> 3 unique targets (2 shared + 1 personal).
    expect(msgs).toHaveLength(3);
    expect(inboxes).toContain('https://masto.social/inbox');
    expect(inboxes).toContain('https://pixelfed.social/f/inbox');
    expect(inboxes).toContain('https://lonely.example/users/e/inbox');
    // No duplicate masto.social.
    expect(inboxes.filter((i) => i === 'https://masto.social/inbox')).toHaveLength(1);
  });

  it('every message carries the actor + eventId + video', () => {
    const msgs = buildDeliveryMessages({
      domain: DOMAIN, username: 'alice', video: VIDEO,
      followers: [{ follower_inbox: 'https://x/inbox' }],
    });
    expect(msgs[0]).toMatchObject({ username: 'alice', eventId: 'evt9', inbox: 'https://x/inbox' });
    expect(msgs[0].video).toBe(VIDEO);
  });
});

describe('deliverMessage — signs the Create and POSTs it', () => {
  it('produces a verifiable HTTP-signed POST', async () => {
    const keycast = createFakeKeycastClient();
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(null, { status: 202 });
    };

    const res = await deliverMessage({
      message: { username: 'alice', eventId: 'evt9', inbox: 'https://remote.example/inbox', video: VIDEO },
      domain: DOMAIN,
      keycast,
      fetchImpl,
    });
    expect(res.status).toBe(202);
    expect(captured.url).toBe('https://remote.example/inbox');
    expect(captured.init.method).toBe('POST');

    // The signature on the captured request must verify against the actor key.
    const body = captured.init.body;
    const h = captured.init.headers;
    const hdrMap = {
      host: h.Host, date: h.Date, digest: h.Digest,
      'content-type': h['Content-Type'], signature: h.Signature,
    };
    const verified = await verifySignature({
      method: 'POST',
      path: '/inbox',
      headers: hdrMap,
      body,
      fetchPublicKeyPem: () => keycast.getPublicKeyPem('https://divine.video/ap/users/alice'),
    });
    expect(verified.ok).toBe(true);

    // The body is a Create{Note} pointing at the CDN url.
    const activity = JSON.parse(body);
    expect(activity.type).toBe('Create');
    expect(activity.object.attachment[0].url).toBe('https://cdn.divine.video/x.mp4');
  });

  it('throws on a non-2xx response so the Queue retries', async () => {
    const keycast = createFakeKeycastClient();
    const fetchImpl = async () => new Response('nope', { status: 500 });
    await expect(deliverMessage({
      message: { username: 'alice', eventId: 'evt9', inbox: 'https://x/inbox', video: VIDEO },
      domain: DOMAIN,
      keycast,
      fetchImpl,
    })).rejects.toThrow(/failed: 500/);
  });
});
