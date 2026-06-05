// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Pure helpers for inbound activity handling — extract follower info,
// ABOUTME: build a signed Accept, and decide what an inbound activity means.

import { actorUrls, NOTE_CONTEXT } from './as2.mjs';

/** Resolve the id of an actor reference that may be a string or an object. */
export function refId(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  return ref.id || null;
}

/**
 * Classify an inbound activity. Returns { kind, ... } describing what to do.
 * Supported now: 'Follow', 'Undo{Follow}'. Everything else -> { kind: 'unsupported' }.
 * TODO(out of scope): Like / Announce / Reply / Create -> map to Nostr (needs
 * surrogate identities + custodial keys). Flag handling for abuse reports.
 */
export function classifyActivity(activity) {
  if (!activity || typeof activity !== 'object') return { kind: 'invalid' };
  const type = activity.type;
  if (type === 'Follow') {
    return {
      kind: 'Follow',
      activityId: activity.id,
      actor: refId(activity.actor),
      target: refId(activity.object),
    };
  }
  if (type === 'Undo') {
    const inner = activity.object;
    if (inner && inner.type === 'Follow') {
      return {
        kind: 'Undo:Follow',
        activityId: activity.id,
        actor: refId(activity.actor),
        target: refId(inner.object),
      };
    }
    return { kind: 'unsupported', type: `Undo:${inner && inner.type}` };
  }
  // Explicitly out of scope for this workstream.
  if (['Like', 'Announce', 'Create', 'Flag'].includes(type)) {
    return { kind: 'unsupported', type };
  }
  return { kind: 'unsupported', type };
}

/** Map a target actor URL (the followed party) back to a Divine username. */
export function usernameFromActorUrl(actorUrl, domain) {
  if (!actorUrl) return null;
  const prefix = `https://${domain}/ap/users/`;
  if (!actorUrl.startsWith(prefix)) return null;
  const rest = actorUrl.slice(prefix.length);
  const username = rest.split('/')[0];
  return username || null;
}

/**
 * Extract a remote follower's delivery endpoints from its fetched actor doc.
 * @param {object} remoteActor the dereferenced remote actor JSON
 */
export function extractFollowerEndpoints(remoteActor) {
  if (!remoteActor) return null;
  const inbox = remoteActor.inbox;
  if (!inbox) return null;
  const sharedInbox =
    (remoteActor.endpoints && remoteActor.endpoints.sharedInbox) || null;
  return {
    followerActorUrl: remoteActor.id,
    followerInbox: inbox,
    sharedInbox,
  };
}

/**
 * Build an Accept activity acknowledging a Follow. Signed + delivered separately.
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.username the Divine actor accepting
 * @param {object} args.followActivity the original Follow (echoed as `object`)
 */
export function buildAccept({ domain, username, followActivity }) {
  const urls = actorUrls(domain, username);
  return {
    '@context': NOTE_CONTEXT,
    id: `${urls.id}/accepts/${encodeURIComponent(followActivity.id || crypto.randomUUID())}`,
    type: 'Accept',
    actor: urls.id,
    object: followActivity,
  };
}
