// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: End-to-end integration with SIGNER_MODE=local (NO keycast). Exercises
// ABOUTME: GET actor, signed Follow -> Accept, and the delivery cron producing a
// ABOUTME: signed Create{Note} — all verified with the gateway's own crypto.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildClients,
  handleActor,
  handleInbox,
  runDeliveryCron,
} from './index.mjs';
import { initSchema, upsertActor, listFollowers } from './db.mjs';
import { actorUrls } from './as2.mjs';
import { createFakeKeycastClient } from './keycast.mjs';
import { buildSignedRequest, verifySignature } from './http-signature.mjs';
import { createLocalKeycastClient } from './signer-local.mjs';

const DOMAIN = 'divine.video';
const USERNAME = 'alice';
const PUBKEY = 'pub_alice';
const REMOTE_ACTOR_URL = 'https://masto.example/users/bob';
const REMOTE_INBOX = 'https://masto.example/users/bob/inbox';

// A fake FunnelCake whose profile + videos are fully controlled.
function fakeFunnelcake(videos = []) {
  return {
    async getProfile() {
      return { display_name: 'Alice', about: 'hi', picture: 'https://cdn/a.jpg' };
    },
    async getUserVideos() { return videos; },
    async getRecentVideos() { return videos; },
  };
}

// A fake moderation that marks everything SAFE.
const safeModeration = {
  async checkResult() { return { moderated: true, action: 'SAFE' }; },
};

// Test env: local signer, no real upstreams.
function testEnv() {
  return {
    ...env,
    AP_DOMAIN: DOMAIN,
    SIGNER_MODE: 'local',
    OUTBOX_MAX_ITEMS: '40',
    DELIVERY_POLL_LIMIT: '50',
  };
}

describe('integration (SIGNER_MODE=local, no keycast)', () => {
  beforeEach(async () => {
    await initSchema(env.AP_DB);
    for (const t of ['actors', 'followers', 'objects', 'inbox_seen', 'local_keys']) {
      await env.AP_DB.prepare(`DELETE FROM ${t}`).run();
    }
    // Seed the actor row so resolvePubkey/cron can map the actor.
    await upsertActor(env.AP_DB, {
      username: USERNAME,
      nostrPubkey: PUBKEY,
      apActorUrl: actorUrls(DOMAIN, USERNAME).id,
    });
  });

  it('(a) GET actor returns a real publicKeyPem minted by the local signer', async () => {
    const e = testEnv();
    const clients = buildClients(e, { funnelcake: fakeFunnelcake() });

    const res = await handleActor(e, clients, USERNAME);
    expect(res.status).toBe(200);
    const actor = await res.json();
    expect(actor.type).toBe('Person');
    expect(actor.id).toBe(actorUrls(DOMAIN, USERNAME).id);
    expect(actor.publicKey.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');

    // The PEM is the SAME one the local signer persisted in D1.
    const stored = await env.AP_DB
      .prepare('SELECT public_pem FROM local_keys WHERE actor = ?')
      .bind(actor.id).first();
    expect(stored.public_pem).toBe(actor.publicKey.publicKeyPem);
  });

  it('(b) a signed Follow is accepted, stored, and answered with a signed Accept', async () => {
    const e = testEnv();

    // The remote follower has its OWN RSA key (a separate fake keycast).
    const remoteSigner = createFakeKeycastClient();
    const remoteActorDoc = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: REMOTE_ACTOR_URL,
      type: 'Person',
      inbox: REMOTE_INBOX,
      endpoints: { sharedInbox: 'https://masto.example/inbox' },
      publicKey: {
        id: `${REMOTE_ACTOR_URL}#main-key`,
        owner: REMOTE_ACTOR_URL,
        publicKeyPem: await remoteSigner.getPublicKeyPem(REMOTE_ACTOR_URL),
      },
    };

    // Capture the Accept the gateway POSTs back to the remote inbox.
    let acceptPost = null;
    const fetchImpl = async (url, init) => {
      // The gateway dereferences the remote actor (for sig verify + endpoints).
      if (url === REMOTE_ACTOR_URL) {
        return new Response(JSON.stringify(remoteActorDoc), {
          status: 200, headers: { 'Content-Type': 'application/activity+json' },
        });
      }
      // The gateway delivers the signed Accept here.
      if (url === REMOTE_INBOX) {
        acceptPost = { url, init };
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const clients = buildClients(e, { funnelcake: fakeFunnelcake(), moderation: safeModeration, fetchImpl });

    // Build a signed Follow from the remote actor to the gateway's inbox.
    const followActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://masto.example/activities/follow-1',
      type: 'Follow',
      actor: REMOTE_ACTOR_URL,
      object: actorUrls(DOMAIN, USERNAME).id,
    };
    const followBody = JSON.stringify(followActivity);
    const inboxUrl = `https://${DOMAIN}/ap/users/${USERNAME}/inbox`;
    const { headers } = await buildSignedRequest({
      method: 'POST',
      url: inboxUrl,
      body: followBody,
      keyId: `${REMOTE_ACTOR_URL}#main-key`,
      sign: (s) => remoteSigner.sign(REMOTE_ACTOR_URL, s),
    });

    const request = new Request(inboxUrl, {
      method: 'POST',
      headers: { ...headers, Accept: 'application/activity+json' },
      body: followBody,
    });

    const res = await handleInbox(e, clients, request, USERNAME);
    expect(res.status).toBe(202);

    // Follower stored.
    const followers = await listFollowers(env.AP_DB, USERNAME);
    expect(followers).toHaveLength(1);
    expect(followers[0].follower_actor_url).toBe(REMOTE_ACTOR_URL);
    expect(followers[0].shared_inbox).toBe('https://masto.example/inbox');

    // An Accept was POSTed to the remote inbox, signed by the gateway actor.
    expect(acceptPost).not.toBeNull();
    const acceptDoc = JSON.parse(acceptPost.init.body);
    expect(acceptDoc.type).toBe('Accept');
    expect(acceptDoc.actor).toBe(actorUrls(DOMAIN, USERNAME).id);
    expect(acceptDoc.object.id).toBe(followActivity.id);

    // Verify the Accept's signature against the GATEWAY's own public key (from
    // the local signer), as a remote server would.
    const localSigner = createLocalKeycastClient({ db: env.AP_DB });
    const gatewayPem = await localSigner.getPublicKeyPem(actorUrls(DOMAIN, USERNAME).id);
    const ah = acceptPost.init.headers;
    const verified = await verifySignature({
      method: 'POST',
      path: '/users/bob/inbox',
      headers: {
        host: ah.Host, date: ah.Date, digest: ah.Digest,
        'content-type': ah['Content-Type'], signature: ah.Signature,
      },
      body: acceptPost.init.body,
      fetchPublicKeyPem: async () => gatewayPem,
    });
    expect(verified.ok).toBe(true);
  });

  it('(c) delivery cron produces exactly one signed Create{Note} that verifies', async () => {
    const e = testEnv();

    // One follower for alice (single personal inbox).
    await env.AP_DB.prepare(
      `INSERT INTO followers (actor_username, follower_actor_url, follower_inbox, shared_inbox, state)
       VALUES (?, ?, ?, ?, 'accepted')`,
    ).bind(USERNAME, REMOTE_ACTOR_URL, REMOTE_INBOX, null).run();

    const video = {
      id: 'evtC', pubkey: PUBKEY, sha256: 'a'.repeat(64),
      video_url: 'https://cdn.divine.video/evtC.mp4', mime_type: 'video/mp4',
      dimensions: '1080x1920', title: 't', content: 'hello',
    };

    const clients = buildClients(e, { funnelcake: fakeFunnelcake([video]), moderation: safeModeration });

    // Cron enqueues into a fake queue.
    const queued = [];
    const queue = { async send(m) { queued.push(m); } };
    const cronResult = await runDeliveryCron(e, clients, queue);
    expect(cronResult.enqueued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0].inbox).toBe(REMOTE_INBOX);

    // Now run the queue consumer logic (deliverMessage) and verify the signed POST.
    let delivered = null;
    const deliverFetch = async (url, init) => {
      delivered = { url, init };
      return new Response(null, { status: 202 });
    };
    const { deliverMessage } = await import('./delivery.mjs');
    await deliverMessage({
      message: queued[0],
      domain: DOMAIN,
      keycast: clients.keycast, // the local signer
      fetchImpl: deliverFetch,
    });

    expect(delivered).not.toBeNull();
    expect(delivered.url).toBe(REMOTE_INBOX);
    const createDoc = JSON.parse(delivered.init.body);
    expect(createDoc.type).toBe('Create');
    expect(createDoc.object.type).toBe('Note');
    expect(createDoc.object.attachment[0].url).toBe('https://cdn.divine.video/evtC.mp4');

    // The Create's signature verifies against the gateway actor's local key.
    const gatewayPem = await clients.keycast.getPublicKeyPem(actorUrls(DOMAIN, USERNAME).id);
    const dh = delivered.init.headers;
    const verified = await verifySignature({
      method: 'POST',
      path: '/users/bob/inbox',
      headers: {
        host: dh.Host, date: dh.Date, digest: dh.Digest,
        'content-type': dh['Content-Type'], signature: dh.Signature,
      },
      body: delivered.init.body,
      fetchPublicKeyPem: async () => gatewayPem,
    });
    expect(verified.ok).toBe(true);
  });
});
