// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Inbound activity tests — classify Follow/Undo, build Accept, extract
// ABOUTME: follower endpoints, and a D1-backed Follow->store->Accept flow.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  classifyActivity,
  buildAccept,
  extractFollowerEndpoints,
  usernameFromActorUrl,
} from './inbox.mjs';
import { initSchema, addFollower, listFollowers, removeFollower } from './db.mjs';

const DOMAIN = 'divine.video';

describe('classifyActivity', () => {
  it('classifies a Follow', () => {
    const c = classifyActivity({
      id: 'https://m/act/1', type: 'Follow',
      actor: 'https://m/users/bob', object: 'https://divine.video/ap/users/alice',
    });
    expect(c).toEqual({
      kind: 'Follow', activityId: 'https://m/act/1',
      actor: 'https://m/users/bob', target: 'https://divine.video/ap/users/alice',
    });
  });
  it('classifies an Undo{Follow}', () => {
    const c = classifyActivity({
      id: 'https://m/act/2', type: 'Undo', actor: 'https://m/users/bob',
      object: { type: 'Follow', object: 'https://divine.video/ap/users/alice' },
    });
    expect(c.kind).toBe('Undo:Follow');
    expect(c.target).toBe('https://divine.video/ap/users/alice');
  });
  it('marks Like/Announce as unsupported (out of scope)', () => {
    expect(classifyActivity({ type: 'Like' }).kind).toBe('unsupported');
    expect(classifyActivity({ type: 'Announce' }).kind).toBe('unsupported');
  });
});

describe('usernameFromActorUrl', () => {
  it('extracts the username from an actor url on our domain', () => {
    expect(usernameFromActorUrl('https://divine.video/ap/users/alice', DOMAIN)).toBe('alice');
  });
  it('returns null for foreign urls', () => {
    expect(usernameFromActorUrl('https://other/ap/users/x', DOMAIN)).toBeNull();
  });
});

describe('extractFollowerEndpoints', () => {
  it('prefers sharedInbox from endpoints', () => {
    const e = extractFollowerEndpoints({
      id: 'https://m/users/bob',
      inbox: 'https://m/users/bob/inbox',
      endpoints: { sharedInbox: 'https://m/inbox' },
    });
    expect(e).toEqual({
      followerActorUrl: 'https://m/users/bob',
      followerInbox: 'https://m/users/bob/inbox',
      sharedInbox: 'https://m/inbox',
    });
  });
  it('returns null when no inbox', () => {
    expect(extractFollowerEndpoints({ id: 'x' })).toBeNull();
  });
});

describe('buildAccept', () => {
  it('echoes the Follow as the Accept object', () => {
    const follow = { id: 'https://m/act/1', type: 'Follow', actor: 'https://m/users/bob' };
    const accept = buildAccept({ domain: DOMAIN, username: 'alice', followActivity: follow });
    expect(accept.type).toBe('Accept');
    expect(accept.actor).toBe('https://divine.video/ap/users/alice');
    expect(accept.object).toBe(follow);
  });
});

describe('Follow -> store -> list -> Undo (D1)', () => {
  beforeEach(async () => {
    await initSchema(env.AP_DB);
    await env.AP_DB.prepare('DELETE FROM followers').run();
  });

  it('stores a follower then removes it on Undo', async () => {
    await addFollower(env.AP_DB, {
      actorUsername: 'alice',
      followerActorUrl: 'https://m/users/bob',
      followerInbox: 'https://m/users/bob/inbox',
      sharedInbox: 'https://m/inbox',
    });
    let followers = await listFollowers(env.AP_DB, 'alice');
    expect(followers).toHaveLength(1);
    expect(followers[0].shared_inbox).toBe('https://m/inbox');

    // Idempotent: re-adding the same follower does not duplicate.
    await addFollower(env.AP_DB, {
      actorUsername: 'alice',
      followerActorUrl: 'https://m/users/bob',
      followerInbox: 'https://m/users/bob/inbox',
    });
    followers = await listFollowers(env.AP_DB, 'alice');
    expect(followers).toHaveLength(1);

    await removeFollower(env.AP_DB, { actorUsername: 'alice', followerActorUrl: 'https://m/users/bob' });
    followers = await listFollowers(env.AP_DB, 'alice');
    expect(followers).toHaveLength(0);
  });
});
