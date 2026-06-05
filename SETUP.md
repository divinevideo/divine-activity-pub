# SETUP — running the Divine ActivityPub Gateway without keycast / prod

This is the runbook to stand up `divine-activity-pub` for local dev / staging
end-to-end **without keycast and without production infrastructure**, using the
built-in local signer (`SIGNER_MODE=local`). For the design, see
[`README.md`](./README.md), [`RESEARCH.md`](./RESEARCH.md),
[`wire-format.md`](./wire-format.md), [`PLAN.md`](./PLAN.md).

> ⚠️ **Local signer is dev/staging only.** With `SIGNER_MODE=local` the gateway
> mints and **stores per-actor RSA private keys in its own D1** (`local_keys`)
> and signs locally. This is fine for local runs and smoke tests so you don't
> need keycast. **Production MUST set `SIGNER_MODE=keycast`** so the gateway
> never holds a private key — see [§Switch to keycast](#switch-to-keycast).

---

## 0. Prerequisites

```bash
npm install            # installs wrangler + vitest pool
npx wrangler login     # one-time, for any cloud commands below
npm test               # 54 tests, all local, no network — sanity check first
```

---

## 1. Create the Cloud resources (run these yourself; nothing is created for you)

These commands create real Cloudflare resources and print **ids you must paste
into `wrangler.toml`**. The `wrangler.toml` ships with placeholder ids so the
local vitest pool works; replace them before `wrangler dev`/`deploy`.

```bash
# D1 — the name MUST match `database_name` in wrangler.toml ("divine-activity-pub").
wrangler d1 create divine-activity-pub
#   → prints: database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#   PASTE into  [[d1_databases]] database_id  in wrangler.toml

# Delivery queue (name MUST match the producer/consumer `queue` in wrangler.toml).
wrangler queues create ap-delivery-queue

# KV cache namespace.
wrangler kv namespace create AP_CACHE
#   → prints: id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
#   PASTE into  [[kv_namespaces]] id  in wrangler.toml
```

`wrangler.toml` bindings to update with the returned ids:

| Binding | wrangler.toml field | Created by |
|---|---|---|
| `AP_DB` (D1) | `[[d1_databases]] database_id` | `wrangler d1 create divine-activity-pub` |
| `AP_CACHE` (KV) | `[[kv_namespaces]] id` | `wrangler kv namespace create AP_CACHE` |
| `DELIVERY_QUEUE` (Queue) | `[[queues.producers]] queue` / `[[queues.consumers]] queue` | `wrangler queues create ap-delivery-queue` |

> Note: Queues require a Workers Paid plan. For a pure read-only smoke test
> (actor + outbox) you can skip the queue and just exercise the GET routes.

---

## 2. Apply migrations

```bash
# Local (creates a local SQLite-backed D1 under .wrangler/ for `wrangler dev`):
wrangler d1 migrations apply divine-activity-pub --local

# Remote (the real D1) — only when you intend to run remotely / deploy:
wrangler d1 migrations apply divine-activity-pub --remote
```

Migrations applied: `001-initial.sql` (actors/followers/objects/inbox_seen),
`002-local-keys.sql` (the local signer's `local_keys`). The Worker also calls
`initSchema()` at runtime (`CREATE TABLE IF NOT EXISTS …`), so tables exist even
before migrations are applied — migrations are the durable record.

---

## 3. Run locally

```bash
wrangler dev          # serves on http://localhost:8787 by default
```

Resolve username → pubkey via the live name-server (NIP-05) by default
(`NAME_SERVER_BASE_URL=https://divine.video`), or seed an actor row directly into
the local D1 for an offline run:

```bash
wrangler d1 execute divine-activity-pub --local \
  --command "INSERT INTO actors (username, nostr_pubkey, ap_actor_url) \
             VALUES ('alice','<hexpubkey>','http://localhost:8787/ap/users/alice')"
```

### curl the read routes (AS2 content negotiation)

```bash
# Actor — note the Accept header; without it the route redirects to the html profile.
curl -s http://localhost:8787/ap/users/alice \
  -H 'Accept: application/activity+json' | jq .

# Outbox — OrderedCollection of Create{Note}, moderation-gated.
curl -s http://localhost:8787/ap/users/alice/outbox \
  -H 'Accept: application/activity+json' | jq .

# Health.
curl -s http://localhost:8787/health | jq .
```

The actor's `publicKey.publicKeyPem` is minted by the local signer on first GET
and persisted in `local_keys`; it is stable across restarts.

---

## 4. Real federation smoke test (no keycast, no prod)

You can federate from a throwaway Mastodon account against a `*.workers.dev`
host or `wrangler dev --remote`, with `SIGNER_MODE=local`.

```bash
# Deploy to a workers.dev subdomain for an externally reachable actor host.
# (Set workers_dev = true in wrangler.toml for this throwaway host, or use:)
wrangler dev --remote      # exposes a temporary public *.workers.dev URL
```

**Important about handles.** A real `@user@divine.video` handle needs the
name-server **WebFinger** (Workstream A) on `divine.video` plus `/ap/*` routing
to this gateway. For a pure-gateway smoke test you don't have that, so **use the
workers.dev host directly as the actor domain** and follow
`@<user>@<your-worker>.workers.dev`. The gateway now serves its OWN WebFinger
(`GET /.well-known/webfinger?resource=acct:<user>@<host>`) so this host is
self-discoverable:

- WebFinger resolves `<user>` via the NIP-05 client and returns `rel=self` →
  `https://<AP_DOMAIN>/ap/users/<user>`. Set `AP_DOMAIN` to your `<host>` so the
  actor URL points back at the same host Mastodon is talking to.
- Confirm discovery: `curl 'https://<host>/.well-known/webfinger?resource=acct:<user>@<host>'`
  → a `application/jrd+json` doc (404 if the username doesn't resolve).
- The gateway serves the actor at `https://<host>/ap/users/<user>` with `Accept:
  application/activity+json`.
- Then from Mastodon search `@<user>@<host>`, follow, and:
  1. publish/seed a SAFE video for that actor (or let the cron poll FunnelCake),
  2. the delivery cron enqueues a `Create{Note}`,
  3. the queue consumer signs it and POSTs it to your inbox,
  4. it appears in the Mastodon timeline — signature verifies because the actor
     doc exposes the matching `publicKeyPem`.

This is exactly the path the integration tests assert offline
(`src/integration.test.mjs`): GET actor → signed Follow → signed Accept → signed
`Create{Note}`, all verified with the gateway's own crypto.

---

## 5. Environment variables

Set in `wrangler.toml [vars]` (or `--var` for `wrangler dev`):

| Var | Default | Meaning |
|---|---|---|
| `SIGNER_MODE` | `local` | `local` (per-actor keys in D1 — dev/staging), `single` (one shared key from env — MVP), or `keycast` (remote signing — **prod**) |
| `AP_DOMAIN` | `divine.video` | actor host; the base of every dereferenceable `id`. For a workers.dev smoke test, set this to your `<host>` (e.g. `my-worker.workers.dev`) so ids match where the actor actually resolves |
| `FUNNELCAKE_BASE_URL` | `https://api.divine.video` | video + profile source (public REST) |
| `MODERATION_BASE_URL` | `https://moderation-api.divine.video` | `/check-result/{sha256}` gate |
| `NAME_SERVER_BASE_URL` | `https://divine.video` | NIP-05 username→pubkey (also used by WebFinger) |
| `KEYCAST_BASE_URL` | `https://keycast.divine.video` | only used when `SIGNER_MODE=keycast` |
| `SINGLE_SIGNING_PUBLIC_PEM` | — | (`SIGNER_MODE=single`) SPKI public key as **PEM text**; published as every actor's `publicKeyPem` |
| `OUTBOX_MAX_ITEMS` | `40` | caps videos per outbox (bounds per-request `/check-result` calls) |
| `DELIVERY_POLL_LIMIT` | `50` | recent-video firehose page size per cron tick |

Secrets:

```bash
wrangler secret put KEYCAST_API_TOKEN         # SIGNER_MODE=keycast: keycast bearer
wrangler secret put SINGLE_SIGNING_KEY_PKCS8  # SIGNER_MODE=single: see below
```

---

## Single shared key (`SIGNER_MODE=single`)

One RSA keypair signs for **every** actor. Each actor doc still publishes this
same public key under its own `#main-key`/`owner` — valid and verifies fine.

> ⚠️ **MVP only.** A single shared key means one compromised key can impersonate
> **every** user (blast radius = all actors). Use it to get federation working
> fast; migrate to `SIGNER_MODE=keycast` (per-actor, custodied) for production.

Exact env contract — two values, two distinct string formats:

| Env name | Kind | Format (be precise) |
|---|---|---|
| `SINGLE_SIGNING_KEY_PKCS8` | **secret** | RSA **private** key, PKCS8 **DER encoded as base64** — the base64 body ONLY: no `-----BEGIN PRIVATE KEY-----` header/footer, no newlines. I.e. `base64(DER)`. |
| `SINGLE_SIGNING_PUBLIC_PEM` | **var** (or secret) | RSA **public** key, SPKI **PEM text** — the full `-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----` block. |

Generate the pair (node — prints both in the exact formats above):

```bash
node -e 'const c=require("crypto");const{privateKey,publicKey}=c.generateKeyPairSync("rsa",{modulusLength:2048});\
console.log("SINGLE_SIGNING_KEY_PKCS8 (secret, base64 PKCS8 DER, one line):");\
console.log(privateKey.export({type:"pkcs8",format:"der"}).toString("base64"));\
console.log("\nSINGLE_SIGNING_PUBLIC_PEM (var, SPKI PEM text):");\
console.log(publicKey.export({type:"spki",format:"pem"}).toString())'
```

Or with openssl:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out single.pem
# SINGLE_SIGNING_KEY_PKCS8 — base64 of the PKCS8 DER, single line:
openssl pkcs8 -topk8 -nocrypt -in single.pem -outform DER | base64 | tr -d '\n'; echo
# SINGLE_SIGNING_PUBLIC_PEM — SPKI PEM text:
openssl pkey -in single.pem -pubout
```

Provision:

```bash
# Private key as a secret (paste the one-line base64 when prompted):
wrangler secret put SINGLE_SIGNING_KEY_PKCS8
# Public PEM as a [vars] entry in wrangler.toml (uncomment SINGLE_SIGNING_PUBLIC_PEM
# and paste the PEM with \n escapes), then set SIGNER_MODE = "single".
```

If either value is missing/blank in `single` mode the signer **fails closed**
(throws a clear error) rather than emitting unsigned output.

---

## Switch to keycast

When keycast (Workstream B) is available and for **production**:

1. Set `SIGNER_MODE = "keycast"` in `wrangler.toml [vars]`.
2. Set `KEYCAST_BASE_URL` to the keycast host (default `https://keycast.divine.video`).
3. `wrangler secret put KEYCAST_API_TOKEN`.

Nothing else changes. The gateway calls keycast `GET /api/ap/keys/{actor}` for
the actor's public PEM and `POST /api/ap/sign {actor, signing_string}` for
signatures; **no private key is ever stored in the gateway**. The `local_keys`
table is unused in this mode (you may leave it; it is dev/staging only).

> Reminder: production must NOT run `SIGNER_MODE=local`. Local mode persists
> private keys in D1, which is acceptable only for dev/staging smoke tests.
