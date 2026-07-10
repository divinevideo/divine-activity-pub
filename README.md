# divine-activity-pub — Divine ActivityPub Gateway

A Cloudflare Worker that projects Divine's (Nostr) videos into the fediverse.
Divine users appear as `@user@divine.video` ActivityPub actors so Mastodon /
Pixelfed / Loops can follow them and receive their videos. **Nostr stays the
source of truth** — this Worker is a moderated read-projection + inbox gateway.
It hosts NO video; attachment URLs point at Divine's existing CDN.

See [`RESEARCH.md`](./RESEARCH.md) (decision/architecture),
[`wire-format.md`](./wire-format.md) (exact actor/Note/Document shapes) and
[`PLAN.md`](./PLAN.md) (phases, data model, acceptance) for the full design.
This is **Workstream C** of [`agent-prompts.md`](./agent-prompts.md).

## What's implemented

Phase 2 (read-only projection) + Phase 3 (follow + delivery):

- `GET /ap/users/{username}` → AS2 `Person` actor (wire-format.md §1). Profile
  from FunnelCake; `publicKeyPem` from keycast; `endpoints.sharedInbox`.
- `GET /ap/users/{username}/outbox` → `OrderedCollection` of `Create{Note}`,
  each with a `Document` video attachment (§2–4), **moderation-gated**.
- `GET /ap/users/{username}/followers` and `/following` → minimal collections.
- `POST /ap/users/{username}/inbox` and shared `POST /ap/inbox`:
  - Verify inbound HTTP Signature (draft-cavage, RSASSA-PKCS1-v1_5 + SHA-256)
    and `Digest`; dedup via `inbox_seen`.
  - `Follow` → store follower in D1 + send a signed `Accept`.
  - `Undo{Follow}` → remove follower.
- Cron (`scheduled`) polls FunnelCake `GET /api/v2/videos?sort=recent`, gates
  each new video, and **enqueues one Queue message per unique follower inbox**
  (dedup by `sharedInbox`). The Queue consumer builds the `Create{Note}`, signs
  it via keycast, and POSTs it — relying on Queue retries for failures.
  Deliveries are NEVER fanned out inline (subrequest/CPU caps).

### Out of scope (clear TODOs in code)

- Inbound `Like`/`Announce`/`Reply`/`Create` → Nostr mapping (needs surrogate
  identities + custodial keys). See `src/inbox.mjs` `classifyActivity`.
- CSAM hash-matching (PhotoDNA/NCMEC) — pre-launch requirement.
- Instance blocklist subscriptions + `Flag` abuse-report handling.
- WebFinger + NodeInfo live in **`divine-name-server`** (Workstream A), not here.

## Module layout

| File | Purpose |
|---|---|
| `src/index.mjs` | Worker entry: `fetch` routes, `scheduled` cron, `queue` consumer; wires env → clients → pure builders. |
| `src/as2.mjs` | Pure AS2 builders: `buildActor`, `buildNote`, `buildCreate`, `buildOutbox`, `actorUrls`, contexts. |
| `src/http-signature.mjs` | draft-cavage signatures: one shared `buildSigningString`, `verifySignature` (WebCrypto), `buildSignedRequest`. |
| `src/keycast.mjs` | `KeycastClient` interface + real HTTP impl + in-memory WebCrypto fake (tests). |
| `src/signer-local.mjs` | `LocalKeycastClient` — same interface, mints+stores per-actor RSA keys in D1 `local_keys` and signs locally. **Dev/staging only** (`SIGNER_MODE=local`). |
| `src/signer-single.mjs` | `SingleKeySigner` — same interface, ONE RSA keypair (from env) shared by all actors. **MVP only** (`SIGNER_MODE=single`); blast radius = every user. |
| `src/webfinger.mjs` | WebFinger (RFC 7033) on the gateway host: `parseAcctResource`, `buildWebfingerJrd`, `handleWebfinger` (resolves via NIP-05; 404 if unknown). |
| `src/clients.mjs` | FunnelCake / moderation / name-server (NIP-05) clients + `verdictAllowsFederation` gate. |
| `src/inbox.mjs` | Pure inbound helpers: `classifyActivity`, `buildAccept`, `extractFollowerEndpoints`. |
| `src/delivery.mjs` | `buildDeliveryMessages` (one-per-unique-inbox) + `deliverMessage` (sign+POST). |
| `src/db.mjs` | D1 access (`actors`/`followers`/`objects`/`inbox_seen`/`local_keys`) + `initSchema`. |
| `migrations/001-initial.sql`, `002-local-keys.sql` | D1 schema (mirrored by `initSchema`). |

**Signer selection** (`SIGNER_MODE`): `local` (default) builds the
`LocalKeycastClient` so the gateway runs end-to-end **without keycast** (per-actor
keys in D1 — dev/staging only); `single` builds the `SingleKeySigner` (one shared
RSA key from env — MVP only, blast radius = all users); `keycast` builds the real
HTTP client (keys custodied remotely — **required in production**). The gateway
also serves its own **WebFinger** (`/.well-known/webfinger`) so a workers.dev host
is self-discoverable for a Mastodon follow test. To run it without keycast or
prod, see **[`SETUP.md`](./SETUP.md)**.

## wrangler bindings

| Binding | Type | Use |
|---|---|---|
| `AP_DB` | D1 | gateway state (`actors`/`followers`/`objects`/`inbox_seen`) |
| `AP_CACHE` | KV | optional short-lived caches |
| `DELIVERY_QUEUE` | Queue (producer) | one message per follower inbox |
| `ap-delivery-queue` | Queue (consumer) | signs + POSTs each `Create{Note}` |
| cron `*/5 * * * *` | trigger | poll firehose → enqueue deliveries |

Vars: `AP_DOMAIN`, `FUNNELCAKE_BASE_URL`, `MODERATION_BASE_URL`,
`NAME_SERVER_BASE_URL`, `KEYCAST_BASE_URL`, `DELIVERY_POLL_LIMIT`.
Secret: `KEYCAST_API_TOKEN`.

## Dependency endpoints

- **keycast (Workstream B)**: `GET /api/ap/keys/{actor}` → `{ publicKeyPem }`;
  `POST /api/ap/sign {actor, signing_string}` → `{ signature }` (base64 RSA-SHA256).
- **name-server (Workstream A)**: NIP-05 `GET /.well-known/nostr.json?name={user}`
  → username→pubkey; plus WebFinger/NodeInfo (built there, not here).
- **FunnelCake**: `GET /api/users/{pubkey}`, `GET /api/users/{pubkey}/videos`,
  `GET /api/v2/videos?sort=recent` (public).
- **moderation**: `GET /check-result/{sha256}` → `{ moderated, blocked, quarantined, action }`.

## Develop / test / deploy

```bash
npm install
npm test          # vitest run (Workers pool; local D1/Queues; no network)
npm run dev       # wrangler dev
# Before deploy: create real D1 + Queue + KV and paste their ids into wrangler.toml
#   wrangler d1 create divine-activity-pub
#   wrangler queues create ap-delivery-queue
#   wrangler d1 migrations apply divine-activity-pub
# npm run deploy  # (do NOT deploy from CI without the real bindings)
```

Tests use injected fakes for every client (FunnelCake / moderation / keycast /
fetch), so **no test touches the network or a real inbox**. The keycast fake
generates a real RSA-2048 key via WebCrypto and signs locally.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
