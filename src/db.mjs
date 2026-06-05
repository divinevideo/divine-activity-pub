// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: D1 access for the gateway (actors/followers/objects/inbox_seen).
// ABOUTME: initSchema mirrors migrations/001-initial.sql so tests don't apply migrations.

/** Create tables if they don't exist (mirrors migrations/001-initial.sql). */
export async function initSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS actors (
      username TEXT PRIMARY KEY,
      nostr_pubkey TEXT NOT NULL,
      ap_actor_url TEXT NOT NULL,
      rsa_key_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_actors_pubkey ON actors(nostr_pubkey)`,
    `CREATE TABLE IF NOT EXISTS followers (
      actor_username TEXT NOT NULL,
      follower_actor_url TEXT NOT NULL,
      follower_inbox TEXT NOT NULL,
      shared_inbox TEXT,
      state TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (actor_username, follower_actor_url)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_followers_actor ON followers(actor_username)`,
    `CREATE TABLE IF NOT EXISTS objects (
      ap_object_id TEXT PRIMARY KEY,
      actor_username TEXT NOT NULL,
      nostr_event_id TEXT NOT NULL,
      sha256 TEXT,
      published_at TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_objects_actor ON objects(actor_username)`,
    `CREATE INDEX IF NOT EXISTS idx_objects_event ON objects(nostr_event_id)`,
    `CREATE TABLE IF NOT EXISTS inbox_seen (
      activity_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Local signer key storage (SIGNER_MODE=local). DEV/STAGING ONLY — holds
    // PKCS8 private keys. Prod uses SIGNER_MODE=keycast (no private keys here).
    // Mirrors migrations/002-local-keys.sql.
    `CREATE TABLE IF NOT EXISTS local_keys (
      actor TEXT PRIMARY KEY,
      public_pem TEXT NOT NULL,
      private_pkcs8 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ];
  for (const sql of statements) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare(sql).run();
  }
}

// --- actors ---

export async function upsertActor(db, { username, nostrPubkey, apActorUrl, rsaKeyId = null }) {
  await db.prepare(
    `INSERT INTO actors (username, nostr_pubkey, ap_actor_url, rsa_key_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       nostr_pubkey = excluded.nostr_pubkey,
       ap_actor_url = excluded.ap_actor_url,
       rsa_key_id = COALESCE(excluded.rsa_key_id, actors.rsa_key_id)`,
  ).bind(username, nostrPubkey, apActorUrl, rsaKeyId).run();
}

export async function getActorByUsername(db, username) {
  return db.prepare('SELECT * FROM actors WHERE username = ?').bind(username).first();
}

export async function getActorByPubkey(db, pubkey) {
  return db.prepare('SELECT * FROM actors WHERE nostr_pubkey = ? LIMIT 1').bind(pubkey).first();
}

// --- followers ---

export async function addFollower(db, { actorUsername, followerActorUrl, followerInbox, sharedInbox = null }) {
  await db.prepare(
    `INSERT INTO followers (actor_username, follower_actor_url, follower_inbox, shared_inbox, state)
     VALUES (?, ?, ?, ?, 'accepted')
     ON CONFLICT(actor_username, follower_actor_url) DO UPDATE SET
       follower_inbox = excluded.follower_inbox,
       shared_inbox = excluded.shared_inbox,
       state = 'accepted'`,
  ).bind(actorUsername, followerActorUrl, followerInbox, sharedInbox).run();
}

export async function removeFollower(db, { actorUsername, followerActorUrl }) {
  await db.prepare(
    'DELETE FROM followers WHERE actor_username = ? AND follower_actor_url = ?',
  ).bind(actorUsername, followerActorUrl).run();
}

export async function listFollowers(db, actorUsername) {
  const res = await db.prepare(
    'SELECT * FROM followers WHERE actor_username = ? AND state = ?',
  ).bind(actorUsername, 'accepted').all();
  return res.results || [];
}

// --- objects (dedup + delivery cursor) ---

/**
 * Record an object if new. Returns true if this is the first time we've seen it
 * (i.e. it should be delivered), false if it already existed.
 */
export async function recordObjectIfNew(db, { apObjectId, actorUsername, nostrEventId, sha256, publishedAt }) {
  const res = await db.prepare(
    `INSERT INTO objects (ap_object_id, actor_username, nostr_event_id, sha256, published_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ap_object_id) DO NOTHING`,
  ).bind(apObjectId, actorUsername, nostrEventId, sha256 || null, publishedAt || null).run();
  // D1 run() returns meta.changes; 1 => inserted, 0 => already present.
  return (res.meta && res.meta.changes) ? res.meta.changes > 0 : false;
}

export async function markObjectDelivered(db, apObjectId) {
  await db.prepare('UPDATE objects SET delivered = 1 WHERE ap_object_id = ?').bind(apObjectId).run();
}

// --- inbox dedup ---

/** Returns true if the activity is new (and records it), false if already seen. */
export async function markInboxSeenIfNew(db, activityId) {
  const res = await db.prepare(
    'INSERT INTO inbox_seen (activity_id) VALUES (?) ON CONFLICT(activity_id) DO NOTHING',
  ).bind(activityId).run();
  return (res.meta && res.meta.changes) ? res.meta.changes > 0 : false;
}
