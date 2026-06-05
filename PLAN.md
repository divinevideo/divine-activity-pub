# Divine AP Gateway — Implementation Plan

Companion to [RESEARCH.md](./RESEARCH.md) (decision) and [wire-format.md](./wire-format.md) (format).
Goal: a Mastodon/Loops/Pixelfed user can find `@user@divine.video`, follow them, and receive their
Divine videos — Nostr stays the source of truth; ActivityPub is a moderated projection.

## Architecture — three components, each in its natural house home

```
┌─────────────────────────────────────────────────────────────────────────┐
│ divine.video  (fronted by divine-router / existing edge)                  │
│                                                                            │
│  /.well-known/webfinger ─┐                                                 │
│  /.well-known/nodeinfo   ├─► divine-name-server  (EXISTING CF Worker)      │  [A] naming + counting
│  /nodeinfo/2.1          ─┘    reads D1 `usernames` (name→pubkey)           │
│                                                                            │
│  /ap/users/{username}        ┐                                            │
│  /ap/users/{username}/outbox │                                            │
│  /ap/users/{username}/inbox  ├─► divine-activity-pub (NEW Rust/Axum svc)   │  [C] the gateway
│  /ap/users/{username}/followers                                            │
│  /ap/inbox  (shared inbox)  ─┘    Postgres; delivery + inbox state         │
└─────────────────────────────────────────────────────────────────────────┘
    │ sign/pubkey (RSA)      │ moderation verdict        │ videos + profiles (REST, public)
    ▼                        ▼                           ▼
 keycast (EXTENDED: RSA)   moderation-api /check-result   FunnelCake api.divine.video/api/
```

**Data source = FunnelCake REST API** (`api.divine.video/api/`, public, no auth) — NOT a raw relay subscription. It returns `imeta`-normalized video fields (`video_url`, `mime_type`, `dimensions`, `blurhash`, `thumbnail`, `sha256`, …). Gateway polls REST; no nostr-sdk/NIP-42 WS needed. See wire-format.md §4.

**Runtime decisions (grounded in house patterns):**
- **[A] Naming → extend `divine-name-server`** (CF Worker, already serves `/.well-known/*`, owns D1 `usernames`). WebFinger + NodeInfo are small stateless reads. No new infra.
- **[C] Gateway → new Cloudflare Worker** (D1 + Queues + cron), modeled on **`divine-moderation-service`** (cron-polls videos, D1 + KV + Queue, calls `/check-result`). Decided 2026-05-30. AP hard parts on Workers: outbound signing → **keycast**; inbound sig verify → **WebCrypto** (`RSASSA-PKCS1-v1_5`+SHA-256); delivery fan-out + retries → **Queues, one message per target inbox** (never loop-deliver inline — subrequest/CPU caps); state → **D1**; trigger → **cron** poll of FunnelCake.
- **Source/trigger → poll FunnelCake REST** (`GET /api/v2/videos?sort=recent` for new-video firehose; `GET /api/users/{pubkey}/videos` for outbox; `GET /api/users/{pubkey}` for profile). Public, no auth, `imeta` already normalized. Cron/interval poll (moderation-service style) — **no relay WS / NIP-42 needed.** (Raw relay only if we later need sig verification: `GET /api/videos/{id}` returns the signed event.)
- **Actor host = `divine.video/ap/...`** (route `/ap/*` to the gateway via the existing edge). Same-origin as WebFinger → **avoids the bidirectional-WebFinger split-domain complexity**. (If `/ap/*` can't route to the gateway, fall back to `ap.divine.video` + the split-domain cooperation from RESEARCH.md §Caveat.)

## Data model (gateway D1)

| Table | Purpose | Key columns |
|---|---|---|
| `actors` | identity map | `nostr_pubkey` (hex), `username`, `ap_actor_url`, `rsa_key_id` (keycast ref), `created_at` |
| `followers` | remote AP followers of a Divine actor | `actor_username`, `follower_actor_url`, `follower_inbox`, `shared_inbox`, `state` (pending/accepted), `created_at` |
| `objects` | dedup / id→event map + last-seen for cron | `ap_object_id`, `nostr_event_id`, `sha256`, `published_at` |
| `inbox_seen` | inbound dedup | `activity_id`, `received_at` |

Outbound delivery state lives in the **Queue** (one message per target inbox) with its own retry/backoff; persist only terminal failures if needed. (Mirrors `divine-moderation-service`'s D1 + Queue pattern.)

## ✅ LIVE & WORKING on divine.video (2026-06-05)

End-to-end **Divine (Nostr) → ActivityPub → Loops** federation is working on the real `divine.video` domain, no keycast (single-key signer):
- WebFinger + actor resolve `@user@divine.video` on Loops/Mastodon.
- Inbound **Follow → signed Accept** completes (follow flips from "pending" to followed).
- **Backfill-on-follow** delivers the creator's recent videos as signed `Create{Note}` to the follower's inbox → they appear on Loops. Verified: `delivered 10/10` to `loops.video`.
- Routing: `divine.video/ap/*` + `/nodeinfo` → the gateway worker (`divine-activity-pub.protestnet.workers.dev`); **`/.well-known/webfinger` is served by the `divine-router` itself** from the `divine-names` KV (KV-backed, proper 404s — NOT the gateway, which had a same-zone-subrequest bug). All via the `divine-router` Fastly service (v38).
- **WebFinger home = the router** (reads the username KV that NIP-05 uses). The gateway's and name-server's WebFinger code is now dormant/unused (committed but not on the serving path).

### Hard-won findings (don't relearn these)
- **Loops/Pixelfed never pull a remote outbox** — `handleRemoteActor` returns `videos:[]`. Remote content shows ONLY when **delivered** (push). Hence backfill-on-follow + ongoing delivery are required; the outbox is just for spec-compliance.
- **Strict content-type:** Loops `fetchActivityPub` does an exact `in_array` match — must be `application/activity+json; charset=utf-8` (we match).
- **"Invalid url" on Loops** was a *symptom*: the search-box webfinger import failed → UI fell back to a URL-only button that rejects a bare handle. Root causes were ours (dead workers.dev subdomain in `url`; 9s outbox > Loops' 5s fetch timeout; the `loops:` namespace in `@context`) — all fixed.
- **Federation allowlist (`open`/`lockdown` + `allowedInstances`)** only gates *inbound authorized-fetch* of Loops' own content (`AuthorizedFetch` middleware), NOT remote-actor import. So it does NOT block us.
- **`clients.fetchImpl(...)` called as a method → "Illegal invocation"** on Workers. Wrap: `(...a) => fetch(...a)`.
- **`api.divine.video` edge-throttles the Worker's egress IP** under load → fast (<55ms) header-less `503 "Service Unavailable"` (not the funnelcake origin). `relay.divine.video` is the unthrottled path — gateway uses it as `FUNNELCAKE_FALLBACK_URL`. **TODO (funnelcake/Fastly owners): fix the api.divine.video edge throttle for server-to-server.**
- **Permissive MVP choices** (per product call): inbound HTTP-signature verify is **log-but-proceed** (`INBOX_REQUIRE_SIGNATURE` to enforce later); moderation gate is **fail-open** except explicit blocked/quarantined (API content is pre-vetted).

### Open / next (not blocking the demo)
- [ ] **Ongoing new-video delivery:** cron currently enqueues to a disabled queue → make it deliver inline (like backfill) OR a **publish webhook** from Divine → gateway (push, low-latency).
- [ ] **Moderation propagation hook:** Divine takedown/label → gateway sends AP `Delete`/`Update` to servers we delivered to (`objects` + `followers` give the target list). "Federation isn't retractable" — this is the fix.
- [ ] **Harden inbound signature verify** (currently failing on Loops' sigs; permissive masks it) → set `INBOX_REQUIRE_SIGNATURE=true` once fixed.
- [ ] **Remove debug endpoints** (`/ap/debug/backfill`, `/ap/debug/probe`, token-gated) before real launch.
- [ ] **keycast RSA** (replace single-key), CSAM hash-matching, instance blocklists, profile-update propagation, NodeInfo on the gateway.
- [ ] **Tear down staging worker / re-attach the queue consumer to prod.**

## Deployed — staging (2026-05-30)
**Live on `workers.dev`, verified end-to-end with NO keycast** (`SIGNER_MODE=local`):
- URL: `https://divine-activity-pub-staging.protestnet.workers.dev` (config: `wrangler.staging.toml`; no `divine.video` route).
- CF resources provisioned: **D1** `divine-activity-pub` (`73a1d29f-a37a-4a36-aac5-0e92df73255f`), **KV** `AP_CACHE` (`d5d913…dc7`), **Queue** `ap-delivery-queue`. Migrations 001+002 applied remote (tables: actors/followers/objects/inbox_seen/local_keys).
- ✅ `GET /ap/users/lelepons` → valid `Person` AS2 with a **real RSA `publicKeyPem` minted by the local signer + stored in D1**.
- ✅ `GET /ap/users/lelepons/outbox` → `OrderedCollection`, 14 moderation-gated `Create{Note}` items, `Document` attachments → real `media.divine.video` URLs. Sourced live from name-server NIP-05 + FunnelCake.
- **Single-key signer + WebFinger added & live** (`SIGNER_MODE=single`, one shared RSA key via `SINGLE_SIGNING_KEY_PKCS8`/`SINGLE_SIGNING_PUBLIC_PEM` secrets — MVP, no keycast): both `lelepons` and `kingbach` actors serve the same key (fp `9311fb54…`); `GET /.well-known/webfinger` resolves with correct subject echo + 404 for unknown. **Handle: `@lelepons@divine-activity-pub-staging.protestnet.workers.dev` is now followable from Mastodon.**
- **Not yet:** live video *delivery* (staging has no cron — follow→Accept handshake works on demand; pushing a post needs cron enabled or a manual trigger); prod `divine.video` route (waits on per-user keys/keycast + name-server deploy).
- Known: outbox `blurhash`/`width`/`height` null (videos endpoint omits extended imeta — enrich via `/api/videos/{id}` if needed); actor `url` uses a non-resolving per-user subdomain on the workers.dev host (correct on `divine.video`).

## Build status (2026-05-30)
**Phases 1–3 implemented + unit-tested** (not yet deployed / no e2e federation test / keycast RSA stubbed):
- **A (name-server)** — WebFinger + NodeInfo built in `divine-name-server` (`src/routes/webfinger.ts`), 8/8 tests pass. Uncommitted.
- **C (gateway)** — CF Worker built in this repo (`src/*.mjs`, `migrations/001-initial.sql`), 48/48 tests pass. Plain `.mjs` mirroring `divine-moderation-service` (no TS). Keycast RSA behind an injectable interface (real HTTP client + in-memory WebCrypto fake for tests).
- **B (keycast RSA)** — in flight separately; gateway stubs its interface.

**Remaining to go live:** wire real keycast endpoints, provision D1/Queue ids, deploy, and run the end-to-end Mastodon federation test. Out of scope still: inbound AP→Nostr mapping, CSAM hash-matching, blocklist/abuse handling.

## Phased plan

### Phase 0 — Unblock + scaffold  *(do first)*
- [x] Name-server data source confirmed = **D1 `usernames`** (resolved in research).
- [ ] **Verify prod D1 binding** is live on the deployed name-server (deploy check, not code).
- [x] **Source schema locked** — use FunnelCake REST `VideoStats` (normalized fields), kinds **34236** (short) + **34235** (horizontal), both NIP-71. No raw relay needed. (wire-format.md §4.)
- [ ] **Confirm `/ap/*` routing** to the new gateway through the divine.video edge (else use `ap.divine.video`).
- [ ] Scaffold `divine-activity-pub` **CF Worker** from `divine-moderation-service`'s skeleton (Hono/itty router, `wrangler.toml` with D1 + Queues + cron, migrations).
- **Depends on / parallel with:** keycast RSA workstream (handed off).

### Phase 1 — Naming & discovery (Workstream A, parallel)  → *Mastodon can resolve the handle*
- [ ] `divine-name-server`: `GET /.well-known/webfinger?resource=acct:{user}@divine.video` → JRD with `subject`, `aliases`, `rel=self` `application/activity+json` → `https://divine.video/ap/users/{user}`. Read `usernames` (D1). Mirror Loops' JRD shape (see wire-format.md).
- [ ] `divine-name-server`: `GET /.well-known/nodeinfo` + `/nodeinfo/2.1` → software `divine`, `protocols:["activitypub"]`, `usage.users.total` = `countActiveUsernames()` (already exists). **This makes Divine *counted* on the fediverse.**
- **Acceptance:** `webfinger` for a real Divine username returns a valid JRD; FediDB-style nodeinfo parse succeeds.

### Phase 2 — Read-only projection (C1+C2)  → *Mastodon can render a profile + videos*
- [ ] `GET /ap/users/{username}` → AP `Person` actor (profile from FunnelCake `GET /api/users/{pubkey}`; `publicKeyPem` from **keycast**; `endpoints.sharedInbox`). Per wire-format.md §1.
- [ ] `GET /ap/users/{username}/outbox` → `OrderedCollection` of `Create{Note}` from FunnelCake `GET /api/users/{pubkey}/videos` (kinds 34236/34235; wire-format.md §3–4), **gated by `/check-result/{sha256}`** (require `moderated:true`, not blocked/quarantined). Cache/upsert into `objects`.
- [ ] `application/activity+json` content negotiation + correct `@context`.
- **Acceptance:** fetching the actor + outbox with `Accept: application/activity+json` returns valid AS2; a Mastodon "look up @user@divine.video" shows the profile and recent videos render.

### Phase 3 — Follow + delivery (C3+C4)  → *it federates* 🎉
- [ ] `POST /ap/users/{username}/inbox` (+ shared `/ap/inbox`): **verify inbound HTTP Signature** (fetch remote actor's key), handle `Follow` → store follower, send signed `Accept`.
- [ ] Delivery worker: poll `GET /api/v2/videos?sort=recent` → for each new gated video by a Divine actor with followers → enqueue `Create{Note}` to each follower inbox (prefer `sharedInbox`) → **HTTP-signed via keycast RSA sign endpoint** → POST with retries/backoff (`deliveries` table).
- [ ] Handle `Undo{Follow}`.
- **Acceptance:** from a **controlled Mastodon test instance**, follow `@user@divine.video`, publish a Divine video, and see it arrive in the Mastodon timeline. (Also: this is when we can capture a **byte-exact Loops `Note`** by following a Loops account — closes that wire-format.md TODO.)

### Phase 4 — Hardening + inbound mapping
- [ ] Moderation: ensure the gate is enforced on every emit path; add **CSAM hash-matching** before public outbound (pre-launch requirement, RESEARCH.md).
- [ ] **Federation hygiene:** instance blocklist subscriptions + abuse-report (`Flag`) handling — the anti-mostr requirement.
- [ ] `Like`/`Announce`/`Reply`/`Comment` inbound → **map to Nostr** via surrogate identities for remote AP actors (custodial keys). The hard, deferred piece (RESEARCH.md). Design separately before building.

## Open decisions to confirm before Phase 2
1. ~~Gateway runtime~~ **DECIDED: CF Worker** (D1 + Queues + cron), per `divine-moderation-service`. Hard parts confirmed viable on Workers (keycast signing / WebCrypto verify / Queues fan-out / D1 state / cron trigger).
2. **Actor host** — `divine.video/ap/*` (preferred, same-origin) vs `ap.divine.video` (needs split-domain WebFinger cooperation).
3. ~~Relay trigger~~ **RESOLVED** — source via FunnelCake REST poll (public, normalized), not a relay subscription. Tune the poll interval / consider a webhook from the publish path later.

## Workstream handoffs (agent prompts)
All three build prompts are written in **[agent-prompts.md](./agent-prompts.md)**:
- **keycast (B, RSA signing)** — delivered. Provides per-actor RSA keygen, public PEM, RSA-SHA256 sign.
- **divine-name-server (A)** — WebFinger + NodeInfo over D1 `usernames`. Ready to run.
- **divine-activity-pub (C, the gateway)** — CF Worker; Phase 2 (read-only actor+outbox) then Phase 3 (inbox+delivery). Ready to run (A and B can run in parallel first).
