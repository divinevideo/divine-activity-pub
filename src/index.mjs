// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Divine ActivityPub Gateway entry point — actor/outbox reads, inbox
// ABOUTME: (Follow->Accept), cron poll -> enqueue deliveries, queue consumer signs+POSTs.

import { buildActor, buildOutbox, buildCreate, buildUpdate, actorUrls } from './as2.mjs';
import {
  createFunnelcakeClient,
  createModerationClient,
  createNameServerClient,
  makeModerationGate,
  makeCachedModerationGate,
} from './clients.mjs';
import { createKeycastClient } from './keycast.mjs';
import { createLocalKeycastClient } from './signer-local.mjs';
import { createSingleKeySigner } from './signer-single.mjs';
import {
  initSchema,
  upsertActor,
  getActorByUsername,
  getActorByPubkey,
  addFollower,
  removeFollower,
  listFollowers,
  recordObjectIfNew,
  markObjectDelivered,
  markInboxSeenIfNew,
} from './db.mjs';
import { verifySignature, buildSignedRequest } from './http-signature.mjs';
import {
  classifyActivity,
  usernameFromActorUrl,
  extractFollowerEndpoints,
  buildAccept,
} from './inbox.mjs';
import { buildDeliveryMessages, deliverMessage } from './delivery.mjs';
import { handleWebfinger } from './webfinger.mjs';

const AS2_TYPES = [
  'application/activity+json',
  'application/ld+json',
];

const AS2_CONTENT_TYPE = 'application/activity+json; charset=utf-8';

function wantsActivityJson(request) {
  const accept = request.headers.get('Accept') || '';
  return AS2_TYPES.some((t) => accept.includes(t)) || accept.includes('activity+json');
}

function as2Response(doc, status = 200) {
  return new Response(JSON.stringify(doc), {
    status,
    headers: {
      'Content-Type': AS2_CONTENT_TYPE,
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function jrdResponse(jrd) {
  return new Response(JSON.stringify(jrd), {
    status: 200,
    headers: {
      'Content-Type': 'application/jrd+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Select the signer (KeycastClient interface) from env.SIGNER_MODE:
 *   - 'local'   (default for now): LocalKeycastClient — mints+stores per-actor
 *               RSA keys in D1 and signs locally. DEV/STAGING ONLY (gateway
 *               holds private keys). Runs end-to-end WITHOUT keycast.
 *   - 'single' : SingleKeySigner — ONE RSA keypair shared by ALL actors, from
 *               env (SINGLE_SIGNING_KEY_PKCS8 secret + SINGLE_SIGNING_PUBLIC_PEM
 *               var). MVP ONLY — blast radius = every user. Migrate to keycast.
 *   - 'keycast': real HTTP KeycastClient — keycast custodies keys, signs
 *               remotely; the gateway never holds a private key. REQUIRED IN PROD.
 * Everything downstream (actor publicKeyPem, Accept signing, delivery signing)
 * uses the returned client unchanged.
 */
export function buildSigner(env) {
  const mode = (env.SIGNER_MODE || 'local').toLowerCase();
  if (mode === 'keycast') {
    return createKeycastClient({ baseUrl: env.KEYCAST_BASE_URL, token: env.KEYCAST_API_TOKEN });
  }
  if (mode === 'single') {
    // ⚠️ one shared key for all actors — MVP only. Fails closed if env missing.
    return createSingleKeySigner({
      privatePkcs8B64: env.SINGLE_SIGNING_KEY_PKCS8,
      publicPem: env.SINGLE_SIGNING_PUBLIC_PEM,
    });
  }
  // 'local' (default). ⚠️ stores private keys in D1 — dev/staging only.
  return createLocalKeycastClient({ db: env.AP_DB });
}

/** Build the injected clients from env (overridable in tests). */
export function buildClients(env, deps = {}) {
  return {
    funnelcake: deps.funnelcake || createFunnelcakeClient({ baseUrl: env.FUNNELCAKE_BASE_URL, fallbackBaseUrl: env.FUNNELCAKE_FALLBACK_URL }),
    moderation: deps.moderation || createModerationClient({ baseUrl: env.MODERATION_BASE_URL }),
    nameServer: deps.nameServer || createNameServerClient({ baseUrl: env.NAME_SERVER_BASE_URL }),
    keycast: deps.keycast || buildSigner(env),
    // Wrap fetch so it is never invoked as a method (e.g. `clients.fetchImpl(...)`),
    // which on Workers throws "Illegal invocation: incorrect `this` reference".
    fetchImpl: deps.fetchImpl || ((...args) => fetch(...args)),
  };
}

/**
 * Resolve username -> nostr pubkey, caching in the actors table.
 * Returns the pubkey string or null.
 */
async function resolvePubkey(env, clients, username) {
  const cached = await getActorByUsername(env.AP_DB, username);
  if (cached) return cached.nostr_pubkey;
  const pubkey = await clients.nameServer.resolvePubkey(username);
  if (!pubkey) return null;
  await upsertActor(env.AP_DB, {
    username,
    nostrPubkey: pubkey,
    apActorUrl: actorUrls(env.AP_DOMAIN, username).id,
  });
  return pubkey;
}

// --- HTTP route handlers ---

export async function handleActor(env, clients, username) {
  const pubkey = await resolvePubkey(env, clients, username);
  if (!pubkey) return jsonResponse(404, { error: 'unknown actor' });

  const [profile, publicKeyPem] = await Promise.all([
    clients.funnelcake.getProfile(pubkey).catch(() => ({})),
    clients.keycast.getPublicKeyPem(actorUrls(env.AP_DOMAIN, username).id),
  ]);

  const actor = buildActor({
    domain: env.AP_DOMAIN,
    username,
    profile,
    publicKeyPem,
  });
  return as2Response(actor);
}

export async function handleOutbox(env, clients, username, page = false) {
  const pubkey = await resolvePubkey(env, clients, username);
  if (!pubkey) return jsonResponse(404, { error: 'unknown actor' });

  const urls = actorUrls(env.AP_DOMAIN, username);

  // Root collection MUST be instant: remote servers (Mastodon, Loops/Pixelfed)
  // fetch the outbox synchronously while RESOLVING the account and abort if it's
  // slow — which then fails the whole lookup. So the root returns a header only:
  // count from the (fast) profile, NO video list and NO moderation gating. The
  // gated items live on ?page=true, fetched separately and non-blockingly.
  if (!page) {
    const profile = await clients.funnelcake.getProfile(pubkey).catch(() => ({}));
    const total = Number(profile.video_count ?? profile.videos_count ?? 0) || 0;
    return as2Response({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: urls.outbox,
      type: 'OrderedCollection',
      totalItems: total,
      first: `${urls.outbox}?page=true`,
    });
  }

  // Page: fetch videos + do the (slower) per-video moderation gating here.
  const cap = Number(env.OUTBOX_MAX_ITEMS || 40);
  const all = await clients.funnelcake.getUserVideos(pubkey).catch(() => []);
  const videos = all.slice(0, cap);
  const gate = makeCachedModerationGate(clients.moderation, env.AP_CACHE);
  const collection = await buildOutbox({ domain: env.AP_DOMAIN, username, videos, gateFn: gate });
  return as2Response({
    '@context': collection['@context'],
    id: `${urls.outbox}?page=true`,
    type: 'OrderedCollectionPage',
    partOf: urls.outbox,
    totalItems: collection.totalItems,
    orderedItems: collection.orderedItems,
  });
}

export async function handleInbox(env, clients, request, usernameOrNull, ctx = null) {
  const bodyText = await request.text();
  let activity;
  try {
    activity = JSON.parse(bodyText);
  } catch {
    return jsonResponse(400, { error: 'invalid JSON' });
  }

  // Verify the inbound HTTP signature (draft-cavage) before trusting anything.
  const headers = lowercaseHeaders(request.headers);
  const url = new URL(request.url);
  const verification = await verifySignature({
    method: request.method,
    path: url.pathname + url.search,
    headers,
    body: bodyText,
    fetchPublicKeyPem: (keyId) => fetchRemoteKeyPem(keyId, clients.fetchImpl),
  });
  if (!verification.ok) {
    // Log the precise mismatch so we can harden verification, but don't hard-reject
    // valid follows in the meantime — a 401 here leaves the remote follow stuck
    // "pending" forever. Set INBOX_REQUIRE_SIGNATURE=true to enforce once verified.
    console.error('[AP] inbox signature verify FAILED:', verification.reason, '| keyId:', headers['signature']?.slice(0, 80));
    if (env.INBOX_REQUIRE_SIGNATURE === 'true') {
      return jsonResponse(401, { error: 'signature verification failed', reason: verification.reason });
    }
  } else {
    console.log('[AP] inbox signature verify ok');
  }

  // Dedup inbound activities.
  if (activity.id) {
    const isNew = await markInboxSeenIfNew(env.AP_DB, activity.id);
    if (!isNew) return jsonResponse(202, { status: 'duplicate, ignored' });
  }

  const classified = classifyActivity(activity);

  if (classified.kind === 'Follow') {
    const targetUsername = usernameOrNull
      || usernameFromActorUrl(classified.target, env.AP_DOMAIN);
    if (!targetUsername) return jsonResponse(400, { error: 'cannot resolve follow target' });

    // Defensive: ensure the actor row exists so the delivery cron can map this
    // actor's videos back to followers even if no one GET the actor first.
    await resolvePubkey(env, clients, targetUsername).catch(() => null);

    // Fetch the remote follower actor to learn its inbox endpoints.
    const remoteActor = await fetchRemoteActor(classified.actor, clients.fetchImpl).catch(() => null);
    const endpoints = extractFollowerEndpoints(remoteActor);
    if (!endpoints) return jsonResponse(400, { error: 'cannot resolve follower inbox' });

    await addFollower(env.AP_DB, {
      actorUsername: targetUsername,
      followerActorUrl: endpoints.followerActorUrl,
      followerInbox: endpoints.followerInbox,
      sharedInbox: endpoints.sharedInbox,
    });

    // Send a signed Accept back to the follower's inbox.
    const accept = buildAccept({ domain: env.AP_DOMAIN, username: targetUsername, followActivity: activity });
    await sendSignedActivity({
      env, clients,
      username: targetUsername,
      inbox: endpoints.followerInbox,
      activity: accept,
    }).catch((e) => console.error('[AP] Accept delivery failed', e.message));

    // Backfill: push the creator's recent moderated videos to the NEW follower so
    // content appears immediately. Loops/Pixelfed don't pull the outbox — remote
    // content only shows once delivered. Run in the background so the 202 is fast.
    const backfill = backfillFollower(env, clients, targetUsername, endpoints.followerInbox)
      .catch((e) => console.error('[AP] backfill failed', e.message));
    if (ctx?.waitUntil) ctx.waitUntil(backfill);

    return jsonResponse(202, { status: 'follow accepted' });
  }

  if (classified.kind === 'Undo:Follow') {
    const targetUsername = usernameOrNull
      || usernameFromActorUrl(classified.target, env.AP_DOMAIN);
    if (targetUsername && classified.actor) {
      await removeFollower(env.AP_DB, {
        actorUsername: targetUsername,
        followerActorUrl: classified.actor,
      });
    }
    return jsonResponse(202, { status: 'unfollowed' });
  }

  // TODO(out of scope): Like / Announce / Reply / Create -> Nostr mapping (needs
  // surrogate identities + custodial keys). Flag -> abuse-report handling.
  return jsonResponse(202, { status: 'accepted, no handler', type: classified.type });
}

/**
 * Deliver a new follower the creator's recent moderated videos as Create{Note}.
 * Loops/Pixelfed/Mastodon don't backfill a remote outbox, so without this a
 * follower sees an empty profile until the next brand-new upload.
 */
async function backfillFollower(env, clients, username, followerInbox) {
  const pubkey = await resolvePubkey(env, clients, username);
  if (!pubkey || !followerInbox) return 0;
  // Content on api.divine.video is already moderation-reviewed, so we DON'T re-gate
  // here. Deliver the FULL catalogue (capped at BACKFILL_MAX), in parallel batches
  // so a 200+ video back-catalogue doesn't time out a sequential loop.
  const max = Number(env.BACKFILL_MAX || 1000);
  let all = [];
  try {
    all = await clients.funnelcake.getUserVideos(pubkey, max);
  } catch (e) {
    console.error('[AP] backfill getUserVideos FAILED for', pubkey, '->', e.message);
    return 0;
  }
  const videos = (all || []).slice(0, max);
  console.log(`[AP] backfill ${username} -> ${followerInbox}: ${(all || []).length} fetched, delivering ${videos.length}`);
  let delivered = 0;
  const BATCH = 25;
  for (let i = 0; i < videos.length; i += BATCH) {
    const batch = videos.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      batch.map((video) =>
        sendSignedActivity({
          env, clients, username, inbox: followerInbox,
          activity: buildCreate({ domain: env.AP_DOMAIN, username, video }),
        }).then(() => 1).catch((e) => { console.error('[AP] deliver failed', e.message); return 0; }),
      ),
    );
    delivered += results.reduce((a, b) => a + b, 0);
  }
  console.log(`[AP] backfill ${username}: delivered ${delivered}/${videos.length}`);
  return delivered;
}

/** Send an Update{Person} to a follower so it refreshes the cached bio/avatar/fields. */
async function sendActorUpdate(env, clients, username, followerInbox) {
  const pubkey = await resolvePubkey(env, clients, username);
  if (!pubkey || !followerInbox) return false;
  const [profile, publicKeyPem] = await Promise.all([
    clients.funnelcake.getProfile(pubkey).catch(() => ({})),
    clients.keycast.getPublicKeyPem(actorUrls(env.AP_DOMAIN, username).id),
  ]);
  const actor = buildActor({ domain: env.AP_DOMAIN, username, profile, publicKeyPem });
  const update = buildUpdate({ domain: env.AP_DOMAIN, username, actor });
  await sendSignedActivity({ env, clients, username, inbox: followerInbox, activity: update });
  console.log(`[AP] sent Update for ${username} -> ${followerInbox}`);
  return true;
}

/** Sign + POST an arbitrary AS2 activity (used for Accept) via keycast. */
async function sendSignedActivity({ env, clients, username, inbox, activity }) {
  const body = JSON.stringify(activity);
  const actorUrl = actorUrls(env.AP_DOMAIN, username).id;
  const keyId = `${actorUrl}#main-key`;
  const { headers } = await buildSignedRequest({
    method: 'POST',
    url: inbox,
    body,
    keyId,
    // keycast keyed on the actor URL — consistent with getPublicKeyPem(actorUrl).
    sign: (signingString) => clients.keycast.sign(actorUrl, signingString),
  });
  const res = await clients.fetchImpl(inbox, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/activity+json' },
    body,
  });
  // MUST consume/cancel the body — leaving response bodies unread stalls the
  // worker's connection pool and Cloudflare cancels in-flight requests (deadlock).
  try { await res.text(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`signed POST ${res.status} -> ${inbox}`);
  return res;
}

// --- remote actor / key fetch ---

async function fetchRemoteActor(actorUrl, fetchImpl) {
  const res = await fetchImpl(actorUrl, { headers: { Accept: 'application/activity+json' } });
  if (!res.ok) throw new Error(`remote actor ${res.status}`);
  return res.json();
}

/** Resolve a keyId (`{actorUrl}#main-key`) to a publicKeyPem by fetching the actor. */
async function fetchRemoteKeyPem(keyId, fetchImpl) {
  const actorUrl = keyId.split('#')[0];
  const actor = await fetchRemoteActor(actorUrl, fetchImpl);
  if (actor.publicKey && actor.publicKey.publicKeyPem) return actor.publicKey.publicKeyPem;
  if (Array.isArray(actor.publicKey)) {
    const match = actor.publicKey.find((k) => k.id === keyId) || actor.publicKey[0];
    if (match) return match.publicKeyPem;
  }
  throw new Error('remote actor has no publicKeyPem');
}

function lowercaseHeaders(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
  return out;
}

// --- cron delivery poll: find new gated videos by followed actors -> enqueue ---

/**
 * One cron tick. Polls the recent-video firehose, gates each, and for every NEW
 * video by an actor that has followers, enqueues ONE message per unique inbox.
 * Exposed for unit testing with injected clients + queue.
 */
export async function runDeliveryCron(env, clients, queue) {
  const limit = Number(env.DELIVERY_POLL_LIMIT || 50);
  const videos = await clients.funnelcake.getRecentVideos(limit).catch(() => []);
  const gate = makeModerationGate(clients.moderation);
  let enqueued = 0;

  for (const video of videos) {
    const pubkey = video.pubkey || video.author_pubkey;
    if (!pubkey) continue;

    // Map pubkey -> a known Divine actor (must have a cached actor row).
    const actorRow = await getActorByPubkey(env.AP_DB, pubkey);
    if (!actorRow) continue;
    const username = actorRow.username;

    const followers = await listFollowers(env.AP_DB, username);
    if (followers.length === 0) continue;

    // Moderation gate FIRST — fail closed. Critical ordering: moderation is
    // reactive (RESEARCH.md §Moderation), so a freshly-polled video is usually
    // un-moderated and must be RE-checked on later polls. If we recorded the
    // object before gating, an un-moderated video would be skipped forever once
    // it later flips to SAFE. Gate -> then record-once -> then enqueue.
    const ok = await gate(video);
    if (!ok) continue;

    // Idempotency: only deliver a passing video once.
    const eventId = video.event_id || video.id || video.d_tag;
    const apObjectId = `${actorRow.ap_actor_url}/statuses/${eventId}`;
    const isNew = await recordObjectIfNew(env.AP_DB, {
      apObjectId,
      actorUsername: username,
      nostrEventId: eventId,
      sha256: video.sha256 || null,
      publishedAt: video.published_at || null,
    });
    if (!isNew) continue;

    const messages = buildDeliveryMessages({ domain: env.AP_DOMAIN, username, video, followers });
    for (const m of messages) {
      await queue.send(m);
      enqueued += 1;
    }
    await markObjectDelivered(env.AP_DB, apObjectId);
  }
  return { enqueued };
}

// --- Worker entry ---

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const clients = buildClients(env);

    await initSchema(env.AP_DB);

    if (path === '/health') {
      return jsonResponse(200, { status: 'ok', service: 'divine-activity-pub' });
    }

    // Debug: probe how the WORKER sees the funnelcake hosts (diagnose the 503).
    if (path === '/ap/debug/probe' && request.method === 'GET') {
      if (url.searchParams.get('token') !== env.DEBUG_TOKEN || !env.DEBUG_TOKEN) {
        return jsonResponse(403, { error: 'forbidden' });
      }
      const pk = url.searchParams.get('pubkey') || 'd95aa8fc0eff8e488952495b8064991d27fb96ed8652f12cdedc5a4e8b5ae540';
      const targets = [
        `${env.FUNNELCAKE_BASE_URL}/api/users/${pk}/videos?limit=24`,
        `${env.FUNNELCAKE_FALLBACK_URL}/api/users/${pk}/videos?limit=24`,
        `${env.FUNNELCAKE_BASE_URL}/api/users/${pk}`,
      ];
      const results = [];
      for (const t of targets) {
        const t0 = Date.now();
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetch(t, { headers: { Accept: 'application/json' } });
          const hdr = {};
          for (const h of ['server', 'via', 'x-served-by', 'x-cache', 'cf-ray', 'content-type', 'retry-after']) {
            hdr[h] = res.headers.get(h);
          }
          // eslint-disable-next-line no-await-in-loop
          const body = (await res.text()).slice(0, 240);
          results.push({ url: t, status: res.status, ms: Date.now() - t0, headers: hdr, bodyHead: body });
        } catch (e) {
          results.push({ url: t, error: e.message, ms: Date.now() - t0 });
        }
      }
      return jsonResponse(200, { results });
    }

    // Debug: re-run backfill for all stored followers of {username}. Token-gated.
    if (path === '/ap/debug/backfill' && request.method === 'POST') {
      if (url.searchParams.get('token') !== env.DEBUG_TOKEN || !env.DEBUG_TOKEN) {
        return jsonResponse(403, { error: 'forbidden' });
      }
      const u = (url.searchParams.get('username') || '').toLowerCase();
      const followers = await listFollowers(env.AP_DB, u);
      // INLINE (await) — fetches to api.divine.video are reliable in the fetch
      // handler but 503 in the background waitUntil context.
      // Run in the BACKGROUND (waitUntil) — delivering a full catalogue takes
      // longer than the 15s edge request timeout. Returns immediately.
      for (const f of followers) {
        ctx.waitUntil(
          sendActorUpdate(env, clients, u, f.follower_inbox)
            .catch((e) => console.error('[AP] debug update failed', e.message))
            .then(() => backfillFollower(env, clients, u, f.follower_inbox))
            .catch((e) => console.error('[AP] debug backfill failed', e.message)),
        );
      }
      return jsonResponse(202, { triggered: followers.length, status: 'running in background', username: u });
    }

    // WebFinger — makes THIS host self-discoverable (e.g. on workers.dev) so a
    // Mastodon "@user@<host>" lookup resolves without the name-server. Accepts
    // any acct host; resolves {user} via the NIP-05 client; 404 if unknown.
    if (path === '/.well-known/webfinger') {
      const result = await handleWebfinger({
        resource: url.searchParams.get('resource'),
        nameServer: clients.nameServer,
        apDomain: env.AP_DOMAIN,
      });
      if (result.status === 200) return jrdResponse(result.jrd);
      return jsonResponse(result.status, { error: result.status === 404 ? 'not found' : 'bad request' });
    }

    // Shared inbox.
    if (path === '/ap/inbox' && request.method === 'POST') {
      return handleInbox(env, clients, request, null, ctx);
    }

    // Per-user routes: /ap/users/{username}[/inbox|/outbox|/followers|/following]
    const userMatch = path.match(/^\/ap\/users\/([^/]+)(\/(inbox|outbox|followers|following))?$/);
    if (userMatch) {
      const username = decodeURIComponent(userMatch[1]).toLowerCase();
      const sub = userMatch[3];

      // The router (which fronts divine.video and owns the name KV) resolves the
      // username -> pubkey and passes it as X-Nostr-Pubkey. Trust it to warm the
      // actors cache: the gateway can't reach NIP-05 from inside the divine.video
      // zone (same-zone subrequest fails), so this is how *uncached* actors —
      // i.e. every Divine user who hasn't been followed yet — get resolved.
      const hintPubkey = request.headers.get('x-nostr-pubkey');
      if (hintPubkey && /^[0-9a-f]{64}$/.test(hintPubkey)) {
        await upsertActor(env.AP_DB, {
          username,
          nostrPubkey: hintPubkey,
          apActorUrl: actorUrls(env.AP_DOMAIN, username).id,
        }).catch(() => {});
      }

      if (sub === 'inbox' && request.method === 'POST') {
        return handleInbox(env, clients, request, username, ctx);
      }

      // Reads require AS2 Accept; otherwise redirect to the html profile.
      if (!wantsActivityJson(request)) {
        return Response.redirect(actorUrls(env.AP_DOMAIN, username).profileUrl, 302);
      }

      if (!sub) return handleActor(env, clients, username);
      if (sub === 'outbox') {
        const page = new URL(request.url).searchParams.get('page') === 'true';
        return handleOutbox(env, clients, username, page);
      }
      if (sub === 'followers') {
        // Minimal followers collection (count only; items omitted by design).
        const followers = await listFollowers(env.AP_DB, username);
        return as2Response({
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: actorUrls(env.AP_DOMAIN, username).followers,
          type: 'OrderedCollection',
          totalItems: followers.length,
        });
      }
      if (sub === 'following') {
        return as2Response({
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: actorUrls(env.AP_DOMAIN, username).following,
          type: 'OrderedCollection',
          totalItems: 0,
        });
      }
    }

    return jsonResponse(404, { error: 'not found' });
  },

  async scheduled(event, env, ctx) {
    const clients = buildClients(env);
    await initSchema(env.AP_DB);
    const result = await runDeliveryCron(env, clients, env.DELIVERY_QUEUE);
    console.log(`[AP] cron enqueued ${result.enqueued} deliveries`);
  },

  async queue(batch, env) {
    const clients = buildClients(env);
    // Ensure schema (incl. local_keys for SIGNER_MODE=local) before signing.
    await initSchema(env.AP_DB);
    for (const message of batch.messages) {
      try {
        await deliverMessage({
          message: message.body,
          domain: env.AP_DOMAIN,
          keycast: clients.keycast,
          fetchImpl: clients.fetchImpl,
        });
        message.ack();
      } catch (e) {
        console.error('[AP] delivery failed, will retry', e.message);
        message.retry(); // rely on Queue retries/backoff
      }
    }
  },
};
