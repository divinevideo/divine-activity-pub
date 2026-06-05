// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Delivery fan-out — build ONE queue message per UNIQUE target inbox
// ABOUTME: (dedup by sharedInbox), and the queue consumer's per-message sign+POST.

import { buildCreate, actorUrls } from './as2.mjs';
import { buildSignedRequest } from './http-signature.mjs';

/**
 * Build the list of delivery queue messages for one video to its followers.
 *
 * CRITICAL: exactly one message per UNIQUE target inbox. Followers that share a
 * sharedInbox collapse to a single message (Mastodon-style shared inbox). We
 * NEVER fan out inline — each returned object becomes one Queue message, and the
 * queue consumer does the actual signed POST (subrequest/CPU caps).
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.username actor whose video is being delivered
 * @param {object} args.video FunnelCake VideoStats
 * @param {Array<{follower_inbox:string, shared_inbox?:string}>} args.followers
 * @returns {Array<{username:string, eventId:string, inbox:string, video:object}>}
 */
export function buildDeliveryMessages({ domain, username, video, followers }) {
  const eventId = video.event_id || video.id || video.d_tag;
  const seen = new Set();
  const messages = [];
  for (const f of followers) {
    // Prefer the shared inbox for fan-out dedup; fall back to personal inbox.
    const inbox = f.shared_inbox || f.sharedInbox || f.follower_inbox || f.followerInbox;
    if (!inbox || seen.has(inbox)) continue;
    seen.add(inbox);
    messages.push({ username, eventId, inbox, video });
  }
  return messages;
}

/**
 * Process one delivery queue message: build the Create{Note}, sign it via
 * keycast, POST it to the target inbox. Throws on non-2xx so the Queue retries.
 *
 * @param {object} args
 * @param {object} args.message the queue message body from buildDeliveryMessages
 * @param {string} args.domain
 * @param {import('./keycast.mjs').KeycastClient} args.keycast
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{status:number}>}
 */
export async function deliverMessage({ message, domain, keycast, fetchImpl = fetch }) {
  const { username, inbox, video } = message;
  const urls = actorUrls(domain, username);
  const keyId = `${urls.id}#main-key`;

  const activity = buildCreate({ domain, username, video });
  const body = JSON.stringify(activity);

  const { headers } = await buildSignedRequest({
    method: 'POST',
    url: inbox,
    body,
    keyId,
    // keycast is keyed on the stable, globally-unique actor URL (urls.id),
    // which is also the prefix of keyId. Keep this identifier consistent with
    // getPublicKeyPem(actor) in the actor route and Accept delivery.
    sign: (signingString) => keycast.sign(urls.id, signingString),
  });

  const res = await fetchImpl(inbox, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/activity+json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`delivery to ${inbox} failed: ${res.status}`);
  }
  return { status: res.status };
}
