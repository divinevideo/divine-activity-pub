-- Divine ActivityPub Gateway — initial schema (PLAN.md §Data model)
-- The same statements are mirrored as CREATE TABLE IF NOT EXISTS in
-- src/db.mjs (initSchema) so tests don't depend on migration application.

-- Identity map: Nostr pubkey <-> Divine username <-> AP actor URL.
CREATE TABLE IF NOT EXISTS actors (
  username      TEXT PRIMARY KEY,            -- canonical Divine username (lowercase)
  nostr_pubkey  TEXT NOT NULL,               -- hex pubkey (source of truth in Nostr)
  ap_actor_url  TEXT NOT NULL,               -- https://{domain}/ap/users/{username}
  rsa_key_id    TEXT,                         -- keycast key reference (publicKey.id), nullable until minted
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actors_pubkey ON actors(nostr_pubkey);

-- Remote AP followers of a Divine actor. One row per (actor, follower).
CREATE TABLE IF NOT EXISTS followers (
  actor_username      TEXT NOT NULL,          -- the Divine actor being followed
  follower_actor_url  TEXT NOT NULL,          -- remote actor id (the follower)
  follower_inbox      TEXT NOT NULL,          -- remote actor's personal inbox
  shared_inbox        TEXT,                    -- remote endpoints.sharedInbox (preferred for fan-out)
  state               TEXT NOT NULL DEFAULT 'accepted',  -- pending | accepted
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_username, follower_actor_url)
);
CREATE INDEX IF NOT EXISTS idx_followers_actor ON followers(actor_username);

-- Object dedup + id->event map + last-seen cursor for the delivery cron.
CREATE TABLE IF NOT EXISTS objects (
  ap_object_id    TEXT PRIMARY KEY,           -- https://{domain}/ap/users/{u}/statuses/{eventId}
  actor_username  TEXT NOT NULL,
  nostr_event_id  TEXT NOT NULL,              -- Nostr event id (d-tag / event id)
  sha256          TEXT,                        -- video hash (moderation key)
  published_at    TEXT,                        -- ISO8601
  delivered       INTEGER NOT NULL DEFAULT 0, -- 1 once enqueued for delivery
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_objects_actor ON objects(actor_username);
CREATE INDEX IF NOT EXISTS idx_objects_event ON objects(nostr_event_id);

-- Inbound activity dedup. We ack/skip an activity_id we've already processed.
CREATE TABLE IF NOT EXISTS inbox_seen (
  activity_id   TEXT PRIMARY KEY,
  received_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
