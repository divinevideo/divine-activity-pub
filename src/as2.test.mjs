// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the pure AS2 builders (actor, Note, Create, outbox + gate).

import { describe, it, expect } from 'vitest';
import {
  buildActor,
  buildNote,
  buildCreate,
  buildOutbox,
  buildAttachment,
  splitDimensions,
  actorUrls,
  ACTOR_CONTEXT,
  NOTE_CONTEXT,
  PUBLIC_URI,
} from './as2.mjs';

const DOMAIN = 'divine.video';
const PEM = '-----BEGIN PUBLIC KEY-----\nMIIBdummy\n-----END PUBLIC KEY-----\n';

const VIDEO = {
  id: 'evt123',
  pubkey: 'abc',
  title: 'My clip',
  content: 'a cool video',
  video_url: 'https://cdn.divine.video/abc.mp4',
  mime_type: 'video/mp4',
  dimensions: '1080x1920',
  blurhash: 'LEHV6nWB2yk8pyo',
  sha256: 'd'.repeat(64),
  published_at: '2026-05-30T00:00:00Z',
};

describe('actorUrls', () => {
  it('builds stable dereferenceable ids', () => {
    const u = actorUrls(DOMAIN, 'alice');
    expect(u.id).toBe('https://divine.video/ap/users/alice');
    expect(u.inbox).toBe('https://divine.video/ap/users/alice/inbox');
    expect(u.outbox).toBe('https://divine.video/ap/users/alice/outbox');
    expect(u.sharedInbox).toBe('https://divine.video/ap/inbox');
  });
});

describe('buildActor', () => {
  it('renders a valid AS2 Person per wire-format.md §1', () => {
    const actor = buildActor({
      domain: DOMAIN,
      username: 'alice',
      profile: { display_name: 'Alice', about: 'hi <there>', picture: 'https://x/a.jpg' },
      publicKeyPem: PEM,
    });
    expect(actor['@context']).toEqual(ACTOR_CONTEXT);
    expect(actor.type).toBe('Person');
    expect(actor.id).toBe('https://divine.video/ap/users/alice');
    expect(actor.preferredUsername).toBe('alice');
    expect(actor.name).toBe('Alice');
    expect(actor.summary).toBe('<p>hi &lt;there&gt;</p>');
    expect(actor.inbox).toBe('https://divine.video/ap/users/alice/inbox');
    expect(actor.endpoints.sharedInbox).toBe('https://divine.video/ap/inbox');
    expect(actor.publicKey.publicKeyPem).toBe(PEM);
    expect(actor.publicKey.id).toBe('https://divine.video/ap/users/alice#main-key');
    expect(actor.publicKey.owner).toBe(actor.id);
    expect(actor.icon).toEqual({ type: 'Image', mediaType: 'image/jpeg', url: 'https://x/a.jpg' });
    expect(actor.manuallyApprovesFollowers).toBe(false);
  });

  it('omits icon when no picture', () => {
    const actor = buildActor({ domain: DOMAIN, username: 'bob', profile: {}, publicKeyPem: PEM });
    expect(actor.icon).toBeUndefined();
    expect(actor.name).toBe('bob');
  });
});

describe('buildAttachment', () => {
  it('always uses type Document with mediaType from mime_type', () => {
    const a = buildAttachment(VIDEO);
    expect(a.type).toBe('Document');
    expect(a.mediaType).toBe('video/mp4');
    expect(a.url).toBe('https://cdn.divine.video/abc.mp4');
    expect(a.width).toBe(1080);
    expect(a.height).toBe(1920);
    expect(a.blurhash).toBe('LEHV6nWB2yk8pyo');
    expect(a.name).toBe('My clip');
  });
});

describe('splitDimensions', () => {
  it('parses WxH', () => {
    expect(splitDimensions('720x1280')).toEqual({ width: 720, height: 1280 });
  });
  it('handles missing/garbage', () => {
    expect(splitDimensions(undefined)).toEqual({ width: null, height: null });
    expect(splitDimensions('weird')).toEqual({ width: null, height: null });
  });
});

describe('buildNote', () => {
  it('renders a valid AS2 Note per wire-format.md §3', () => {
    const note = buildNote({ domain: DOMAIN, username: 'alice', video: VIDEO });
    expect(note['@context']).toEqual(NOTE_CONTEXT);
    expect(note.type).toBe('Note');
    expect(note.id).toBe('https://divine.video/ap/users/alice/statuses/evt123');
    expect(note.attributedTo).toBe('https://divine.video/ap/users/alice');
    expect(note.content).toBe('<p>a cool video</p>');
    expect(note.to).toEqual([PUBLIC_URI]);
    expect(note.cc).toEqual(['https://divine.video/ap/users/alice/followers']);
    expect(note.attachment).toHaveLength(1);
    expect(note.attachment[0].type).toBe('Document');
    expect(note.published).toBe('2026-05-30T00:00:00.000Z');
    expect(note.sensitive).toBe(false);
  });

  it('marks sensitive content with a summary', () => {
    const note = buildNote({
      domain: DOMAIN,
      username: 'alice',
      video: { ...VIDEO, content_warning: 'nudity' },
    });
    expect(note.sensitive).toBe(true);
    expect(note.summary).toBe('nudity');
  });
});

describe('buildCreate', () => {
  it('wraps a Note in a Create with a distinct activity id', () => {
    const create = buildCreate({ domain: DOMAIN, username: 'alice', video: VIDEO });
    expect(create.type).toBe('Create');
    expect(create.id).toBe('https://divine.video/ap/users/alice/statuses/evt123/activity');
    expect(create.object.id).toBe('https://divine.video/ap/users/alice/statuses/evt123');
    expect(create.object.type).toBe('Note');
    expect(create.object['@context']).toBeUndefined(); // embedded object has no context
    expect(create.actor).toBe('https://divine.video/ap/users/alice');
  });
});

describe('buildOutbox moderation gate', () => {
  it('filters videos that fail the gate (quarantined) and keeps passing ones', async () => {
    const videos = [
      { ...VIDEO, id: 'good1', sha256: 'a'.repeat(64) },
      { ...VIDEO, id: 'bad1', sha256: 'b'.repeat(64) },
      { ...VIDEO, id: 'good2', sha256: 'c'.repeat(64) },
    ];
    const blocked = new Set(['b'.repeat(64)]);
    const gateFn = async (v) => !blocked.has(v.sha256);

    const outbox = await buildOutbox({ domain: DOMAIN, username: 'alice', videos, gateFn });
    expect(outbox.type).toBe('OrderedCollection');
    expect(outbox.totalItems).toBe(2);
    const ids = outbox.orderedItems.map((c) => c.object.id);
    expect(ids).toContain('https://divine.video/ap/users/alice/statuses/good1');
    expect(ids).toContain('https://divine.video/ap/users/alice/statuses/good2');
    expect(ids).not.toContain('https://divine.video/ap/users/alice/statuses/bad1');
  });
});
