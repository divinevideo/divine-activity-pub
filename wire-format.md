# Wire format — Divine Nostr (kind 34236) → ActivityPub `Note`

Implementation spec for the **Divine AP Gateway** outbound projection. Companion to [RESEARCH.md](./RESEARCH.md).
Sources: real `loops.video` actor (captured 2026-05-30), Pixelfed `MediaService::activitypub()` source (same team as Loops), Pixelfed AP docs, AS2.

> ⚠️ The live `loops.video` outbox is **auth-gated** (returns only the `OrderedCollection` header, `totalItems` but no items), so the *exact Loops* `Note` JSON couldn't be scraped. The shapes below are from the **Pixelfed-family source** Loops is built on + the **real Loops actor**. Verify byte-for-byte against a federated Loops `Note` if one becomes obtainable (e.g. as received by a Mastodon inbox we control).

## 1. Actor (verified from `https://loops.video/ap/users/1`)

Real Loops actor we mirror for `@user@divine.video`:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams","https://w3id.org/security/v1",
    {"loops":"https://joinloops.org/ns#",
     "interactionPolicy":{"@id":"loops:interactionPolicy","@type":"@id"},
     "canFeature":{"@id":"loops:canFeature","@type":"@id"}}],
  "id":"https://loops.video/ap/users/1",
  "type":"Person",
  "preferredUsername":"dansup",
  "name":"dansup",
  "summary":"<p>…</p>",
  "inbox":"https://loops.video/ap/users/1/inbox",
  "outbox":"https://loops.video/ap/users/1/outbox",
  "followers":"https://loops.video/ap/users/1/followers",
  "following":"https://loops.video/ap/users/1/following",
  "manuallyApprovesFollowers":false,
  "url":"https://loops.video/@dansup",
  "publicKey":{"id":"…#main-key","owner":"…","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n…RSA…\n-----END PUBLIC KEY-----\n"},
  "icon":{"type":"Image","mediaType":"image/jpeg","url":"https://loopsusercontent.com/avatars/1/….jpg"},
  "interactionPolicy":{"canFeature":{"automaticApproval":["https://www.w3.org/ns/activitystreams#Public"],"manualApproval":[]}},
  "endpoints":{"sharedInbox":"https://loops.video/ap/inbox"}
}
```

**Divine actor mapping** (per user):
| AP field | Divine source |
|---|---|
| `id` | `https://divine.video/ap/users/{username}` (or our actor host) |
| `type` | `Person` |
| `preferredUsername` / `name` | `usernames.username_display` (from `divine-name-server`) |
| `summary` | Nostr profile (kind 0) `about` |
| `icon` | kind 0 `picture` |
| `publicKey.publicKeyPem` | **per-actor RSA keypair the gateway mints + custodies** (NOT the Nostr key — AP requires RSA HTTP signatures) |
| `inbox`/`outbox`/`followers`/`following` | gateway routes |
| `endpoints.sharedInbox` | one shared inbox for the gateway |
| `url` | `https://username.divine.video` (existing subdomain profile) |

> Note: AP identity uses an **RSA keypair the gateway holds**, separate from the user's Nostr secp256k1 key. This is the custodial-key point flagged in RESEARCH.md — unavoidable for HTTP Signatures.

## 2. Video attachment (authoritative — Pixelfed `MediaService::activitypub()`)

Every media item (image AND video) serializes identically; **`type` is always `"Document"`**, MIME distinguishes video:

```json
{
  "type": "Document",
  "mediaType": "video/mp4",
  "url": "https://<divine-cdn>/<sha256>.mp4",
  "name": "<alt text / description, nullable>",
  "blurhash": "<blurhash string, 6–164 chars>",
  "focalPoint": [0, 0],
  "width": 720,
  "height": 1280
}
```

## 3. The `Note` (Pixelfed-family Create/Note + Loops "Note+attachment" convention)

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams","https://w3id.org/security/v1",
    {"sensitive":"as:sensitive","toot":"http://joinmastodon.org/ns#","blurhash":"toot:blurhash",
     "Hashtag":"as:Hashtag","schema":"http://schema.org/"}],
  "id":"https://divine.video/ap/users/{username}/statuses/{eventId}",
  "type":"Note",
  "attributedTo":"https://divine.video/ap/users/{username}",
  "content":"<p>caption</p>",
  "summary": null,            // content-warning text when sensitive
  "sensitive": false,         // from moderation verdict / NIP content-warning
  "published":"<event created_at, ISO8601>",
  "url":"https://username.divine.video/<eventId>",
  "to":["https://www.w3.org/ns/activitystreams#Public"],
  "cc":["https://divine.video/ap/users/{username}/followers"],
  "attachment":[ { /* Document item from §2 */ } ],
  "tag":[ /* Hashtag / Mention objects */ ]
}
```
Delivered wrapped in a `Create` activity, HTTP-signed (RSA-SHA256) to followers' inboxes (prefer `sharedInbox`).

## 4. Source → AP mapping — use the FunnelCake REST API (normalized, no imeta parsing)

Divine videos = **kind 34236** (vertical/short, most videos) and **kind 34235** (horizontal) — both NIP-71 (`crates/proto/src/lib.rs`). **Source via the public FunnelCake REST API** at `https://api.divine.video/api/` (no auth), which already normalizes `imeta` into flat fields — the gateway does NOT need a raw relay subscription.

Endpoints:
- `GET /api/users/{pubkey}/videos` (or `/api/v2/...`, paginated `{data, pagination, next_cursor}`) → an actor's **outbox**.
- `GET /api/v2/videos?sort=recent` → new-video firehose → **delivery trigger** (poll on interval).
- `GET /api/videos/{id}` → full raw event (`id, pubkey, kind, created_at, tags, content, sig`) + stats, if the raw event/sig is needed.
- `GET /api/users/{pubkey}` → profile (name, avatar, bio, follower counts) → **actor** doc.

`VideoStats` → AP `Note` + attachment (1:1):

| AP `Note` / attachment | FunnelCake `VideoStats` field |
|---|---|
| attachment `url` | `video_url` |
| attachment `mediaType` | `mime_type` (e.g. `video/mp4`) |
| attachment `width`/`height` | `dimensions` (`"1080x1920"` → split) |
| attachment `blurhash` | `blurhash` |
| attachment `name` | `title` (alt) |
| preview/thumbnail | `thumbnail` |
| `content` | `content` (description) / `title` |
| `published` | `published_at` (NIP-71) or `created_at` |
| `id` / `url` | event `id` + `d_tag` |
| `attributedTo` | actor for `pubkey` (via name-server `usernames`) |
| `sensitive` / `summary` | content-warning + moderation verdict |
| (duration) | `duration` (seconds) |

**Moderation gate (before emitting):** take `sha256` from the video object, call `GET /check-result/{sha256}`, require `moderated:true` AND not `blocked`/`quarantined` (hold `REVIEW`). Federation isn't retractable.

> Note: kind 34235 (horizontal) maps identically — only `dimensions` differ. Support both.

## 5. To verify / open
- [ ] **Exact kind-34236 tag schema** — confirm `d`/`imeta`/`title`/`content-warning` against a real event from `wss://relay.divine.video` (and whether NIP-71 kind 21/22 is also emitted).
- [ ] **Byte-level Loops `Note`** — capture a real federated Loops `Note` (gated outbox blocks direct scrape) to confirm Loops matches Pixelfed shape + any `loops:` extensions.
- [ ] **`focalPoint`** — confirm consumers (Loops/Mastodon) need it or if it's optional.
- [ ] **Thumbnail/preview** — Loops federates generated thumbnails; decide `image` preview attachment vs `blurhash`-only.
- [ ] **FEP-3b86 follow intents** — optional UX (Loops actor advertised it); not required for core federation.
