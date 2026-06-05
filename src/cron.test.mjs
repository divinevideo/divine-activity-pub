// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cron delivery-poll test — new gated videos by followed actors enqueue
// ABOUTME: one message per unique inbox; gate filters; idempotent on re-run.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runDeliveryCron } from './index.mjs';
import { initSchema, upsertActor, addFollower } from './db.mjs';
import { actorUrls } from './as2.mjs';

const DOMAIN = 'divine.video';

function makeClients({ videos, quarantined = new Set() }) {
  return {
    funnelcake: {
      async getRecentVideos() { return videos; },
    },
    moderation: {
      async checkResult(sha) {
        if (quarantined.has(sha)) return { moderated: true, quarantined: true };
        return { moderated: true, action: 'SAFE' };
      },
    },
  };
}

class FakeQueue {
  constructor() { this.messages = []; }
  async send(m) { this.messages.push(m); }
}

describe('runDeliveryCron', () => {
  beforeEach(async () => {
    await initSchema(env.AP_DB);
    await env.AP_DB.prepare('DELETE FROM actors').run();
    await env.AP_DB.prepare('DELETE FROM followers').run();
    await env.AP_DB.prepare('DELETE FROM objects').run();

    await upsertActor(env.AP_DB, {
      username: 'alice',
      nostrPubkey: 'pub_alice',
      apActorUrl: actorUrls(DOMAIN, 'alice').id,
    });
  });

  it('enqueues one message per UNIQUE follower inbox for a new gated video', async () => {
    // 3 followers, 2 behind one shared inbox -> 2 unique targets.
    await addFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://m/a', followerInbox: 'https://m/a/inbox', sharedInbox: 'https://m/inbox' });
    await addFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://m/b', followerInbox: 'https://m/b/inbox', sharedInbox: 'https://m/inbox' });
    await addFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://p/c', followerInbox: 'https://p/c/inbox' });

    const videos = [{ id: 'evt1', pubkey: 'pub_alice', sha256: 'a'.repeat(64), video_url: 'https://cdn/x.mp4', mime_type: 'video/mp4', dimensions: '720x1280' }];
    const clients = makeClients({ videos });
    const queue = new FakeQueue();

    const result = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN, DELIVERY_POLL_LIMIT: '50' }, clients, queue);
    expect(result.enqueued).toBe(2);
    expect(queue.messages).toHaveLength(2);
    const inboxes = queue.messages.map((m) => m.inbox).sort();
    expect(inboxes).toEqual(['https://m/inbox', 'https://p/c/inbox']);
  });

  it('skips a quarantined video (moderation gate)', async () => {
    await addFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://m/a', followerInbox: 'https://m/a/inbox' });
    const videos = [{ id: 'evtbad', pubkey: 'pub_alice', sha256: 'q'.repeat(64), video_url: 'https://cdn/x.mp4' }];
    const clients = makeClients({ videos, quarantined: new Set(['q'.repeat(64)]) });
    const queue = new FakeQueue();

    const result = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN }, clients, queue);
    expect(result.enqueued).toBe(0);
    expect(queue.messages).toHaveLength(0);
  });

  it('skips videos by actors with no followers', async () => {
    const videos = [{ id: 'evt2', pubkey: 'pub_alice', sha256: 'a'.repeat(64), video_url: 'https://cdn/x.mp4' }];
    const clients = makeClients({ videos });
    const queue = new FakeQueue();
    const result = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN }, clients, queue);
    expect(result.enqueued).toBe(0);
  });

  it('delivers an un-moderated video immediately (permissive) then dedups', async () => {
    // Permissive MVP: an un-moderated video (status "unknown") is NOT blocked —
    // it federates on the first poll, then is deduped on later polls.
    await addFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://m/a', followerInbox: 'https://m/a/inbox' });
    const sha = 's'.repeat(64);
    const videos = [{ id: 'evtlate', pubkey: 'pub_alice', sha256: sha, video_url: 'https://cdn/x.mp4' }];
    const clients = {
      funnelcake: { async getRecentVideos() { return videos; } },
      moderation: { async checkResult() { return { moderated: false }; } },
    };
    // Poll 1: permissive gate -> delivered once.
    const q1 = new FakeQueue();
    const r1 = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN }, clients, q1);
    expect(r1.enqueued).toBe(1);

    // Poll 2: already delivered -> deduped to 0.
    const q2 = new FakeQueue();
    const r2 = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN }, clients, q2);
    expect(r2.enqueued).toBe(0);
  });

  it('is idempotent — a video already delivered is not re-enqueued', async () => {
    await addFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://m/a', followerInbox: 'https://m/a/inbox' });
    const videos = [{ id: 'evt3', pubkey: 'pub_alice', sha256: 'a'.repeat(64), video_url: 'https://cdn/x.mp4' }];
    const clients = makeClients({ videos });

    const q1 = new FakeQueue();
    const r1 = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN }, clients, q1);
    expect(r1.enqueued).toBe(1);

    const q2 = new FakeQueue();
    const r2 = await runDeliveryCron({ ...env, AP_DOMAIN: DOMAIN }, clients, q2);
    expect(r2.enqueued).toBe(0);
  });
});
