// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Pure builders for ActivityStreams 2.0 documents (actor, Note, Create, outbox).
// ABOUTME: No I/O — every dependency (profile, videos, publicKeyPem, gate) is passed in.

// @context for the actor doc — verbatim from wire-format.md §1 (real loops.video actor).
// Standard Mastodon/Pixelfed-shaped actor context. We deliberately do NOT carry
// Loops' own `https://joinloops.org/ns#` namespace — a remote actor shouldn't
// advertise the importer's private vocab, and it's a likely "Invalid url" trigger.
export const ACTOR_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    toot: 'http://joinmastodon.org/ns#',
    schema: 'http://schema.org/',
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
    PropertyValue: 'schema:PropertyValue',
    value: 'schema:value',
  },
];

// @context for Note/Create docs — verbatim from wire-format.md §3 (incl. toot:blurhash).
export const NOTE_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    sensitive: 'as:sensitive',
    toot: 'http://joinmastodon.org/ns#',
    blurhash: 'toot:blurhash',
    Hashtag: 'as:Hashtag',
    schema: 'http://schema.org/',
  },
];

export const PUBLIC_URI = 'https://www.w3.org/ns/activitystreams#Public';

/**
 * Compute the canonical set of dereferenceable URLs for a Divine actor.
 * Stable ids: actor id, inbox, outbox, followers, following, shared inbox.
 * @param {string} domain e.g. "divine.video"
 * @param {string} username canonical username
 */
export function actorUrls(domain, username) {
  const base = `https://${domain}/ap/users/${username}`;
  return {
    id: base,
    inbox: `${base}/inbox`,
    outbox: `${base}/outbox`,
    followers: `${base}/followers`,
    following: `${base}/following`,
    sharedInbox: `https://${domain}/ap/inbox`,
    profileUrl: `https://${username}.${domain}`,
  };
}

/**
 * Stable id for the Note projecting a single video event.
 * @param {object} urls from actorUrls()
 * @param {string} eventId Nostr event id / d-tag
 */
export function noteId(urls, eventId) {
  return `${urls.id}/statuses/${eventId}`;
}

/**
 * Stable id for the Create activity wrapping a Note. Distinct from the Note id
 * so the activity and its object are independently dereferenceable.
 */
export function createActivityId(urls, eventId) {
  return `${urls.id}/statuses/${eventId}/activity`;
}

/**
 * Build the AS2 Person actor (wire-format.md §1).
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.username
 * @param {object} args.profile FunnelCake GET /api/users/{pubkey} (name/about/picture/display_name)
 * @param {string} args.publicKeyPem RSA public key PEM from keycast
 * @param {string} [args.keyId] publicKey.id (defaults to `${id}#main-key`)
 * @returns {object} AS2 Person
 */
export function buildActor({ domain, username, profile = {}, publicKeyPem, keyId }) {
  const urls = actorUrls(domain, username);
  const displayName = profile.display_name || profile.name || username;
  const summary = profile.about || profile.bio || profile.summary || '';
  const picture = profile.picture || profile.avatar || profile.avatar_url || null;
  const resolvedKeyId = keyId || `${urls.id}#main-key`;

  const actor = {
    '@context': ACTOR_CONTEXT,
    id: urls.id,
    type: 'Person',
    preferredUsername: username,
    name: displayName,
    summary: summary ? `<p>${escapeHtml(summary)}</p>` : '',
    inbox: urls.inbox,
    outbox: urls.outbox,
    followers: urls.followers,
    following: urls.following,
    manuallyApprovesFollowers: false,
    url: urls.profileUrl,
    publicKey: {
      id: resolvedKeyId,
      owner: urls.id,
      publicKeyPem,
    },
    endpoints: { sharedInbox: urls.sharedInbox },
  };

  if (picture) {
    actor.icon = {
      type: 'Image',
      mediaType: guessImageMime(picture),
      url: picture,
    };
  }

  const banner = profile.banner || profile.banner_url || null;
  if (banner) {
    actor.image = { type: 'Image', mediaType: guessImageMime(banner), url: banner };
  }

  // Profile metadata fields (Mastodon/Loops render these as the link/field list).
  const fields = [];
  const link = (name, href, text) =>
    fields.push({ type: 'PropertyValue', name, value: `<a href="${escapeHtml(href)}" rel="me">${escapeHtml(text || href)}</a>` });
  link('Divine', urls.profileUrl, `${username}.${domain}`);
  if (profile.website) link('Website', profile.website);
  if (profile.nip05) fields.push({ type: 'PropertyValue', name: 'Nostr', value: escapeHtml(profile.nip05) });
  if (profile.lud16) fields.push({ type: 'PropertyValue', name: '⚡ Lightning', value: escapeHtml(profile.lud16) });
  if (fields.length) actor.attachment = fields;

  return actor;
}

/**
 * Build an Update{Person} activity to refresh a remote server's cached actor
 * (bio / avatar / fields). Deliver to followers' inboxes like a Create.
 */
export function buildUpdate({ domain, username, actor }) {
  const urls = actorUrls(domain, username);
  return {
    '@context': ACTOR_CONTEXT,
    // eslint-disable-next-line no-undef
    id: `${urls.id}#updates/${Math.floor(Date.now() / 1000)}`,
    type: 'Update',
    actor: urls.id,
    to: [PUBLIC_URI],
    cc: [urls.followers],
    object: actor,
  };
}

/**
 * Build a Document attachment for a video (wire-format.md §2). type is always
 * "Document"; MIME distinguishes video. url points at Divine's existing CDN.
 * @param {object} video FunnelCake VideoStats
 */
export function buildAttachment(video) {
  const { width, height } = splitDimensions(video.dimensions);
  const attachment = {
    type: 'Document',
    mediaType: video.mime_type || 'video/mp4',
    url: video.video_url,
    name: video.title || null,
  };
  if (video.blurhash) attachment.blurhash = video.blurhash;
  if (width != null) attachment.width = width;
  if (height != null) attachment.height = height;
  return attachment;
}

/**
 * Build the AS2 Note for a single video (wire-format.md §3-4). The Note carries
 * its own @context so it is valid when dereferenced standalone.
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.username
 * @param {object} args.video FunnelCake VideoStats (must have an `id`/`event_id`)
 */
export function buildNote({ domain, username, video }) {
  const urls = actorUrls(domain, username);
  const eventId = video.event_id || video.id || video.d_tag;
  const id = noteId(urls, eventId);
  const caption = video.content || video.description || video.title || '';
  const published = toIso(video.published_at || video.created_at);
  const sensitive = Boolean(video.sensitive || video.content_warning);

  return {
    '@context': NOTE_CONTEXT,
    id,
    type: 'Note',
    attributedTo: urls.id,
    content: caption ? `<p>${escapeHtml(caption)}</p>` : '',
    summary: sensitive ? video.content_warning || null : null,
    sensitive,
    published,
    url: `${urls.profileUrl}/${eventId}`,
    to: [PUBLIC_URI],
    cc: [urls.followers],
    attachment: [buildAttachment(video)],
    tag: [],
  };
}

/**
 * Wrap a Note in a Create activity, ready for delivery / outbox embedding.
 */
export function buildCreate({ domain, username, video }) {
  const urls = actorUrls(domain, username);
  const eventId = video.event_id || video.id || video.d_tag;
  const note = buildNote({ domain, username, video });
  return {
    '@context': NOTE_CONTEXT,
    id: createActivityId(urls, eventId),
    type: 'Create',
    actor: urls.id,
    published: note.published,
    to: note.to,
    cc: note.cc,
    object: stripContext(note),
  };
}

/**
 * Build an OrderedCollection outbox of Create{Note} from a list of videos.
 * `gateFn(video) -> Promise<boolean>` decides whether a video passes the
 * moderation gate. Videos that fail (or are un-moderated) are skipped.
 * @returns {Promise<object>} AS2 OrderedCollection
 */
export async function buildOutbox({ domain, username, videos, gateFn }) {
  const urls = actorUrls(domain, username);
  // Gate every video CONCURRENTLY — a serial await-loop here means one
  // /check-result round-trip per video in series (~1.5s × N), which blows the
  // upstream timeout for prolific actors. Order is preserved via index filter.
  const verdicts = await Promise.all(
    videos.map((v) => Promise.resolve(gateFn(v)).catch(() => false)),
  );
  const items = videos
    .filter((_, i) => verdicts[i])
    .map((video) => buildCreate({ domain, username, video }));
  return {
    '@context': NOTE_CONTEXT,
    id: urls.outbox,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  };
}

// --- small pure helpers ---

export function splitDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'string') return { width: null, height: null };
  const m = dimensions.match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!m) return { width: null, height: null };
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function toIso(value) {
  if (value == null) return new Date(0).toISOString();
  // Nostr created_at is unix seconds; ISO strings pass through.
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  if (/^\d+$/.test(String(value))) return new Date(Number(value) * 1000).toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function guessImageMime(url) {
  const u = String(url).toLowerCase();
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function stripContext(doc) {
  const { '@context': _ctx, ...rest } = doc;
  return rest;
}
