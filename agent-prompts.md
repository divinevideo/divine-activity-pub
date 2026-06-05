# Build handoff prompts — Divine AP Gateway

Self-contained prompts for agents building each workstream. Context lives in
[RESEARCH.md](./RESEARCH.md), [wire-format.md](./wire-format.md), [PLAN.md](./PLAN.md).
Order: **keycast (B)** and **name-server (A)** can run in parallel now; **gateway (C)** consumes both.

---

## Workstream B — keycast: RSA / ActivityPub HTTP-Signature signing

*(Delivered already; see the version handed to the keycast repo. Summary of the contract it must expose, which the gateway depends on:)*
- `POST /api/ap/keys` → create/return an RSA-2048 keypair for an actor id; returns **public PEM**.
- `GET  /api/ap/keys/{actor}` → return public PEM (for the actor doc's `publicKey.publicKeyPem`).
- `POST /api/ap/sign` → input `{actor, signing_string}` → output base64 **RSA-SHA256** signature. Private key never exported.
Full prompt: see chat history / the keycast repo task. Keep Nostr (secp256k1/Schnorr) signing untouched.

---

## Workstream A — divine-name-server: WebFinger + NodeInfo

```
# Task: Add ActivityPub WebFinger + NodeInfo to divine-name-server

## Context
divine-name-server is a Cloudflare Worker (Hono) that already serves NIP-05 at
`/.well-known/nostr.json` from a D1 table `usernames` (columns incl. `name`,
`username_canonical`, `username_display`, `pubkey`, `status`). `wrangler.toml` already
routes `/.well-known/*`. We're adding an ActivityPub gateway so Divine users become
`@user@divine.video` fediverse actors. This task adds the two discovery endpoints that
make those handles resolvable and make Divine *counted* on the fediverse.

## Read first
- `src/routes/nip05.ts` (route pattern to mirror), `src/db/queries.ts`
  (`getUsernameByName`, `countActiveUsernames`), `src/index.ts` (route mounting),
  `wrangler.toml`.

## Build
1. `GET /.well-known/webfinger?resource=acct:{user}@divine.video`
   - Parse the `acct:` resource; extract `{user}`. Look up via `getUsernameByName(env.DB, user)`.
   - 404 if unknown/inactive. On hit, return JRD (content-type `application/jrd+json`),
     CORS enabled, short cache:
     {
       "subject": "acct:{user}@divine.video",
       "aliases": ["https://{user}.divine.video", "https://divine.video/ap/users/{user}"],
       "links": [
         {"rel":"http://webfinger.net/rel/profile-page","type":"text/html","href":"https://{user}.divine.video"},
         {"rel":"self","type":"application/activity+json","href":"https://divine.video/ap/users/{user}"}
       ]
     }
   - The `rel=self` href is the gateway actor URL. Keep it configurable (env) — default
     `https://divine.video/ap/users/{user}`.
2. `GET /.well-known/nodeinfo`  → {"links":[{"rel":"http://nodeinfo.diaspora.software/ns/schema/2.1","href":"https://divine.video/nodeinfo/2.1"}]}
3. `GET /nodeinfo/2.1` → NodeInfo 2.1 doc:
   {"version":"2.1","software":{"name":"divine","version":"<x>"},"protocols":["activitypub"],
    "services":{"inbound":[],"outbound":[]},"openRegistrations":false,
    "usage":{"users":{"total": <countActiveUsernames()>},"localPosts":0}}
   - Add a `/nodeinfo/*` route to wrangler.toml if not covered.

## Constraints
- Do NOT change NIP-05 behaviour. Read-only. Reuse existing D1 queries; no schema change.
- Match the JRD shape Mastodon/Loops expect (compare against a real `loops.video` webfinger).
- Tests: webfinger for a real active username returns valid JRD; unknown → 404;
  nodeinfo parses and reports a plausible user count.

## Deliverable
Short plan first (routes, files touched), then implementation + tests + wrangler route updates.
```

---

## Workstream C — divine-activity-pub: the gateway (CF Worker)

```
# Task: Build the Divine ActivityPub Gateway (Cloudflare Worker)

## What this is
A Cloudflare Worker that projects Divine's videos into the fediverse: Divine users appear
as `@user@divine.video` ActivityPub actors so Mastodon / Pixelfed / Loops can follow them
and receive their videos. **Nostr/Divine stays the source of truth; this is a read-projection
+ inbox gateway.** It hosts NO video — attachment URLs point at Divine's existing CDN.

## Read first (in this repo)
RESEARCH.md (decision/architecture), wire-format.md (EXACT actor + Note + attachment shape
and the FunnelCake field mapping), PLAN.md (phases, data model, acceptance criteria).
Template to mirror: `../divine-moderation-service` (CF Worker that cron-polls videos, uses
D1 + KV + Queues, calls a moderation API). Same house patterns.

## Stack & infra
- Cloudflare Worker (Hono or itty-router), `wrangler.toml` with: **D1** (tables per PLAN.md
  §Data model), **Queues** (delivery), **cron** trigger, KV (cache, optional).
- Actors served under `https://divine.video/ap/*` (same origin as WebFinger → avoids
  split-domain webfinger checks). Confirm `/ap/*` routes here via the edge; else use
  `ap.divine.video` and implement the bidirectional-webfinger cooperation (RESEARCH.md §Caveat).

## Dependencies (interfaces, may be built in parallel)
- **keycast RSA** (Workstream B): `GET /api/ap/keys/{actor}` → public PEM;
  `POST /api/ap/sign {actor, signing_string}` → base64 RSA-SHA256 sig. Used for outbound
  HTTP Signatures. Stub behind an interface if keycast isn't ready.
- **name-server WebFinger** (Workstream A): resolves `@user@divine.video` → this actor URL.
- **FunnelCake REST API** (`https://api.divine.video/api/`, public): video/profile source.
- **moderation**: `GET https://moderation-api.divine.video/check-result/{sha256}` (public)
  → `{moderated, blocked, quarantined, action}`.

## Phase 2 — read-only projection (ship first → Mastodon can render a profile + videos)
- `GET /ap/users/{username}` → AS2 `Person` actor (EXACT shape in wire-format.md §1):
  profile from `GET /api/users/{pubkey}`; `publicKey.publicKeyPem` from keycast;
  `endpoints.sharedInbox`; inbox/outbox/followers/following URLs.
- `GET /ap/users/{username}/outbox` → `OrderedCollection` of `Create{Note}` built from
  `GET /api/users/{pubkey}/videos` (kinds 34236 & 34235). Each Note + `Document` attachment
  per wire-format.md §2–4 (`type:"Document"`, `mediaType` from `mime_type`, `url`=`video_url`,
  `width`/`height` from `dimensions`, `blurhash`, `name`=`title`).
  **MODERATION GATE**: skip any video whose `GET /check-result/{sha256}` is not
  `moderated:true && !blocked && !quarantined` (hold `REVIEW`).
- Content negotiation: serve AS2 only for `Accept: application/activity+json` (or `ld+json`).
- Map username↔pubkey via the name-server `usernames` data (or call its API). Cache in D1 `actors`.

## Phase 3 — follow + delivery (→ it federates)
- `POST /ap/users/{username}/inbox` and shared `POST /ap/inbox`:
  - **Verify the inbound HTTP Signature**: parse `Signature` header (draft-cavage), fetch the
    remote actor, import its `publicKeyPem`, verify with WebCrypto
    (`RSASSA-PKCS1-v1_5` + SHA-256) over the reconstructed signing string; verify `Digest`.
  - Handle `Follow` → store in D1 `followers` (with `follower_inbox`/`shared_inbox`), send a
    signed `Accept`. Handle `Undo{Follow}`. Dedup via `inbox_seen`.
- Delivery (cron + Queue): cron polls `GET /api/v2/videos?sort=recent`; for each NEW gated
  video by an actor that has followers, **enqueue one Queue message per follower inbox**
  (dedup by sharedInbox). Queue consumer: build `Create{Note}`, sign via keycast
  (`signing_string` = draft-cavage `(request-target) host date digest`), POST to the inbox,
  rely on Queue retries/backoff for failures.
  ⚠️ NEVER fan out deliveries inline in one invocation — one delivery = one Queue message
  (Worker subrequest/CPU caps). This is the make-or-break constraint.

## Out of scope (separate later phase)
Inbound Like/Announce/Reply → Nostr mapping (needs surrogate identities + custodial keys),
CSAM hash-matching, instance blocklist subscriptions. Leave clear TODOs.

## Constraints & correctness
- Idempotent: dedup objects (`objects`) and inbound activities (`inbox_seen`).
- Correct `@context` on every AS2 doc (incl. `toot:blurhash`).
- `id`s must be stable, dereferenceable URLs.
- Don't block actor/outbox reads on slow upstreams — cache in D1/KV.

## Deliverables
1. A written **plan** FIRST (wrangler bindings, D1 schema/migration, route list, module layout,
   the keycast/funnelcake/moderation client interfaces) — post before coding.
2. Phase 2 implementation + tests (actor + outbox render valid AS2; gate filters quarantined).
3. Phase 3 implementation + tests (sig verify with a known vector; Follow→Accept; a delivery
   queue unit test). End-to-end: follow from a controlled Mastodon test instance and receive a video.
4. `wrangler.toml`, migration, and a README with the deploy + the dependency endpoints.
```

---

### Cross-cutting acceptance (the milestone that proves the whole feature)
From a Mastodon test instance: search `@<realuser>@divine.video` → profile resolves (A) →
renders recent videos (C/Phase2) → follow → publish a new Divine video → it arrives in the
Mastodon timeline, HTTP-signed (C/Phase3 + B). At that point Divine is live and *counted*
(NodeInfo) on the fediverse.
