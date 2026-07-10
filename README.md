# Divine ActivityPub

A Cloudflare Worker that projects Divine's (Nostr) videos into the fediverse.
Divine users appear as `@user@divine.video` ActivityPub actors, so Mastodon,
Pixelfed, and Loops can follow them and receive their videos. **Nostr stays the
source of truth** — this Worker is a moderated read-projection plus inbox
gateway. It hosts NO video; attachment URLs point at Divine's existing CDN.

For the full design see [`RESEARCH.md`](./RESEARCH.md) (decision/architecture),
[`wire-format.md`](./wire-format.md) (exact actor/Note/Document shapes), and
[`PLAN.md`](./PLAN.md) (phases, data model, acceptance). This is **Workstream C**
of [`agent-prompts.md`](./agent-prompts.md).

## Status

Early / MVP, but live. Phase 2 (read-only projection) and Phase 3 (follow +
delivery) are implemented and running behind `divine.video/ap/*`. Some pieces are
provisional:

- **Signing runs in `single` mode in the deployed config** (`SIGNER_MODE = "single"`
  in `wrangler.toml`): one RSA keypair, from env, shared by every actor. The blast
  radius is every user, so this is an MVP-only setting — production must move to
  `keycast`. The in-code default when `SIGNER_MODE` is unset is `local`.
- **The delivery Queue consumer is temporarily attached to the staging worker**,
  so the `[[queues.consumers]]` block in `wrangler.toml` is commented out here.
  The producer (cron → enqueue) is live; the consumer signs and POSTs.
- Inbound `Like`/`Announce`/`Reply`/`Create` → Nostr mapping, CSAM
  hash-matching, and instance blocklists are not yet built (see below).

## Features

- `GET /ap/users/{username}` → AS2 `Person` actor (wire-format.md §1). Profile
  from FunnelCake; `publicKeyPem` from the active signer; `endpoints.sharedInbox`.
- `GET /ap/users/{username}/outbox` → `OrderedCollection` of `Create{Note}`,
  each with a `Document` video attachment (§2–4), **moderation-gated**, capped
  at `OUTBOX_MAX_ITEMS`.
- `GET /ap/users/{username}/followers` and `/following` → minimal collections
  (counts only; items omitted by design).
- `POST /ap/users/{username}/inbox` and shared `POST /ap/inbox`:
  - Verify inbound HTTP Signature (draft-cavage, RSASSA-PKCS1-v1_5 + SHA-256)
    and `Digest`; dedup via `inbox_seen`.
  - `Follow` → store follower in D1 and send a signed `Accept`.
  - `Undo{Follow}` → remove follower.
- Cron (`scheduled`, every 5 min) polls FunnelCake
  `GET /api/v2/videos?sort=recent`, gates each new video, and **enqueues one
  Queue message per unique follower inbox** (dedup by `sharedInbox`). The Queue
  consumer builds the `Create{Note}`, signs it, and POSTs it — relying on Queue
  retries for failures. Deliveries are NEVER fanned out inline (subrequest/CPU
  caps).
- `GET /.well-known/webfinger` — makes this host self-discoverable (e.g. on a
  workers.dev host) so a Mastodon `@user@<host>` lookup resolves without the
  name-server. Resolves the username via NIP-05; 404 if unknown.
- `GET /health` → liveness JSON. `GET /ap/debug/probe` and
  `POST /ap/debug/backfill` are token-gated operational endpoints (require
  `DEBUG_TOKEN`) for diagnosing FunnelCake reachability and re-running a
  follower's catalogue backfill.

Reads require an ActivityStreams `Accept` header; a browser request to a
`/ap/users/{username}` path is redirected (302) to the HTML profile.

### Out of scope (clear TODOs in code)

- Inbound `Like`/`Announce`/`Reply`/`Create` → Nostr mapping (needs surrogate
  identities + custodial keys). See `src/inbox.mjs` `classifyActivity`.
- CSAM hash-matching (PhotoDNA/NCMEC) — a pre-launch requirement.
- Instance blocklist subscriptions and `Flag` abuse-report handling.
- NodeInfo lives in **`divine-name-server`** (Workstream A). WebFinger is served
  there for `divine.video`; this Worker also serves its own WebFinger so a
  standalone host stays discoverable.

## Architecture

Nostr is authoritative. This gateway is a one-way read-projection of Divine's
video events into ActivityStreams 2.0, plus an inbox for follow bookkeeping:

```
Fediverse (Mastodon / Pixelfed / Loops)
    │  Follow / Undo            ▲  Create{Note} + Document
    ▼                           │
┌─────────────────────────────────────────────┐
│  divine-activity-pub (Cloudflare Worker)     │
│   fetch:      actor / outbox / inbox / wf    │
│   scheduled:  poll firehose → enqueue        │
│   queue:      sign + POST each delivery      │
└─────────────────────────────────────────────┘
    │ reads             │ verdicts        │ sign / keys
    ▼                   ▼                 ▼
 FunnelCake        moderation-api      signer (keycast / single / local)
 (videos+profiles) (federation gate)
    ▲
    │ username → pubkey (NIP-05)
 divine-name-server (router / name KV)
```

- **Read path**: the actor and outbox are built from FunnelCake profile and
  video data, normalized to AS2 by the pure builders in `src/as2.mjs`. Every
  video is checked against moderation before it is federated
  (`verdictAllowsFederation`); blocked/quarantined items are dropped.
- **Follow path**: inbound activities land on the inbox, are signature-verified,
  classified (`src/inbox.mjs`), and `Follow`/`Undo{Follow}` update the D1
  `followers` table. A signed `Accept` is returned for each `Follow`.
- **Delivery path**: the cron trigger polls the new-video firehose, gates it,
  and produces one Queue message per unique follower inbox. The Queue consumer
  signs and POSTs each `Create{Note}`; transient failures rely on Queue retries.
- **Identity resolution**: the router that fronts `divine.video` owns the name
  KV, resolves `username → pubkey`, and passes it as `X-Nostr-Pubkey` so the
  gateway can warm its actor cache for users it has never seen (a same-zone
  NIP-05 subrequest from inside the `divine.video` zone would otherwise fail).

Actors are served same-origin as WebFinger (the `/ap/*` prefix on `divine.video`
routes to this Worker) to satisfy Mastodon's bidirectional WebFinger check — see
`RESEARCH.md`.

### Module layout

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

## Getting started

```bash
npm install
npm test          # vitest run (Workers pool; local D1/Queues; no network)
npm run dev       # wrangler dev
npm run tail      # wrangler tail (stream logs from the deployed worker)
```

Tests inject fakes for every client (FunnelCake / moderation / signer / fetch),
so **no test touches the network or a real inbox**. The signer fake generates a
real RSA-2048 key via WebCrypto and signs locally.

To run the gateway locally without keycast or production dependencies, see
[`SETUP.md`](./SETUP.md). The default signer (`SIGNER_MODE=local`) mints per-actor
keys in D1, so the gateway runs end-to-end with no external signing service.

## Configuration

Bindings (`wrangler.toml`):

| Binding | Type | Use |
|---|---|---|
| `AP_DB` | D1 | gateway state (`actors`/`followers`/`objects`/`inbox_seen`/`local_keys`) |
| `AP_CACHE` | KV | optional short-lived caches (username↔pubkey, actor docs) |
| `DELIVERY_QUEUE` | Queue (producer) | one message per follower inbox |
| `ap-delivery-queue` | Queue (consumer) | signs + POSTs each `Create{Note}` — currently attached to the staging worker; the consumer block is commented out here |
| cron `*/5 * * * *` | trigger | poll firehose → enqueue deliveries |

Signer selection (`SIGNER_MODE`):

- `local` — `LocalKeycastClient`; mints + stores per-actor RSA keys in D1 and
  signs locally. Runs without keycast. **Dev/staging only.** This is the in-code
  default when `SIGNER_MODE` is unset.
- `single` — `SingleKeySigner`; ONE RSA keypair shared by all actors, from env
  (`SINGLE_SIGNING_KEY_PKCS8` secret + `SINGLE_SIGNING_PUBLIC_PEM` var). **MVP
  only** — blast radius = every user. This is the value in the current
  `wrangler.toml`.
- `keycast` — real HTTP keycast; keys custodied remotely, gateway holds none.
  **Required in production.**

Vars: `AP_DOMAIN`, `FUNNELCAKE_BASE_URL`, `FUNNELCAKE_FALLBACK_URL`,
`MODERATION_BASE_URL`, `NAME_SERVER_BASE_URL`, `KEYCAST_BASE_URL`,
`DELIVERY_POLL_LIMIT`, `OUTBOX_MAX_ITEMS`, `SIGNER_MODE`, and (for `single`)
`SINGLE_SIGNING_PUBLIC_PEM`. `DEBUG_TOKEN` gates the `/ap/debug/*` endpoints.

Secrets (`wrangler secret put <NAME>`): `KEYCAST_API_TOKEN` (for keycast mode);
`SINGLE_SIGNING_KEY_PKCS8` (for single mode — RSA private key, PKCS8 DER as
base64, body only). See `src/signer-single.mjs` / `SETUP.md` for the exact
generate command.

### Dependency endpoints

- **keycast (Workstream B)**: `GET /api/ap/keys/{actor}` → `{ publicKeyPem }`;
  `POST /api/ap/sign {actor, signing_string}` → `{ signature }` (base64 RSA-SHA256).
- **name-server (Workstream A)**: NIP-05 `GET /.well-known/nostr.json?name={user}`
  → username→pubkey; plus WebFinger/NodeInfo (built there).
- **FunnelCake**: `GET /api/users/{pubkey}` (profile),
  `GET /api/v2/users/{pubkey}/videos` (per-actor catalogue),
  `GET /api/v2/videos?sort=recent` (new-video firehose).
- **moderation**: `GET /check-result/{sha256}` →
  `{ moderated, blocked, quarantined, action }`.

## Deployment

The Worker deploys to Cloudflare with wrangler. Before the first deploy, create
the real D1 database, Queue, and KV namespace and paste their ids into
`wrangler.toml`:

```bash
wrangler d1 create divine-activity-pub
wrangler queues create ap-delivery-queue
wrangler d1 migrations apply divine-activity-pub
npm run deploy    # do NOT deploy from CI without the real bindings
```

Production must set `SIGNER_MODE = "keycast"` and provide `KEYCAST_API_TOKEN`.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
