# Divine (Nostr) ⇄ ActivityPub — Research

Status: **active research**, last updated 2026-05-30.
Repo `divine-activity-pub` is currently **empty** — this doc is the starting point.

## Goal

Make Divine (a Nostr-based video platform) interoperate with the **ActivityPub / fediverse**, so that:

1. Divine users are **counted and visible** on ActivityPub.
2. We control our own AP **infrastructure** (not dependent on unmoderated third-party bridges).
3. Divine video events are **published** in a format consumable by **Loops** ([joinloops.org](https://joinloops.org/)) and other AP video apps (Pixelfed, PeerTube, Mastodon).
4. Content can **eventually** be mapped back from ActivityPub into Nostr/Divine.

**Out of scope:** `divine-sky` / ATProtocol publishing — separate track.

## Key insight: naming and content/delivery decouple

The driving requirement: a Divine user `@user.divine.video` should become the fediverse handle **`@user@divine.video`**.

A fediverse handle's domain is determined **only by who answers WebFinger** for that `acct:`:
- `GET https://divine.video/.well-known/webfinger?resource=acct:user@divine.video` → returns an **actor URL**.
- That actor URL (the actual actor doc + `inbox`/`outbox`/content) **can live on a different host.**

So owning `@user@divine.video` requires WebFinger on `divine.video`; the actor server can be separate as long as it cooperates with discovery.
This is the same split-domain identity pattern Bridgy Fed documents.

→ The system splits into two independently-sourceable layers:

| Layer | Must be ours? | Options |
|---|---|---|
| **Naming** — WebFinger responder @ `divine.video` | ✅ yes (this is what owns the handle) | thin endpoint we control |
| **Content/delivery** — actor, outbox, inbox, delivery, moderation | ✅ ours | native AP projection over Divine's existing Nostr/CDN/moderation systems |

**Caveat:** Mastodon does a **bidirectional WebFinger check**. If WebFinger on `divine.video` points to an actor on `ap.divine.video`, the actor host must also answer WebFinger for `acct:user@ap.divine.video` and return `subject: acct:user@divine.video` plus the same actor URL. Split-domain handles are valid, but both hosts must cooperate.

**Implication:** split-domain identity is useful architecture, but **Bridgy Fed is reference material, not a backend** for us. Divine needs video, moderation control, and `@user@divine.video`; Bridgy's current Nostr path does not meet that bar.

## Confirmed live infrastructure on `divine.video` (probed 2026-05-30)

We already operate the `divine.video/.well-known/` identity surface:

- ✅ **NIP-05 live:** `GET https://divine.video/.well-known/nostr.json?name=<user>` returns NIP-05 JSON (`{"names":{...}}`, keyed by `?name=`). Confirmed via `?name=_` → `{"names":{}}` (valid shape, `_` root unset). **This is the username→Nostr-pubkey registry.**
- ✅ **did:plc / atproto handle** support exists in the name-server/router path (out of scope here).
- ❌ **WebFinger NOT present:** `/.well-known/webfinger?resource=acct:_@divine.video` → **404**. AP naming layer unbuilt.
- ❌ **NodeInfo NOT present:** `/.well-known/nodeinfo` → **404**. AP instance/user-count layer unbuilt.

**Implication:** owning `@user@divine.video` = **add WebFinger to the existing well-known service**, backed by the **same username→pubkey table NIP-05 already uses**, returning an AP actor URL. Being **counted** also needs NodeInfo (`/.well-known/nodeinfo` + `/nodeinfo/2.1`) with real user/post counts.

### `divine-name-server` internals (read 2026-05-30)

- **Stack:** Cloudflare Worker (Hono). Serves NIP-05 at `src/routes/nip05.ts`. `wrangler.toml` already routes `/.well-known/*` for the relevant hosts.
- **Data (source):** D1 table `usernames` (`name`, `pubkey`, `relays`, `status` ∈ active/reserved/revoked/burned, `username_canonical`, `username_display`); one active username per pubkey; also synced to Fastly KV. `countActiveUsernames()` exists in `src/db/queries.ts`.
- **Identity scheme:** hybrid — subdomain `username.divine.video` (+ `_@username.divine.video` NIP-05) **and** root `name@divine.video` (`?name=`). Claimed via **NIP-98** signed request (`src/routes/username.ts`).
- **Where WebFinger/NodeInfo go:** new small routes mounted in `src/index.ts` alongside the existing NIP-05 route.
- **⚠️ prod/source drift:** earlier ops metadata suggested deployed binding drift while source declares D1 + Fastly KV. **Before building, confirm where prod username→pubkey data actually resolves from**.

### User counting (divine-brain, 2026-05-30)

- **On ActivityPub today: effectively 0** — Divine has no AP presence at all (zero AP code, no WebFinger, no NodeInfo).
- **Overall users: no clean count available** — no `v_users` gold view; `v_customer_recent` = **43 rows** (accounts, not end-users); name-server request volume is only a weak activity signal. Counting needs a proper source: distinct active `pubkey` in the `usernames` table for NodeInfo `usage.users.total`.
- **No prior AP/fediverse discussion** found in company knowledge (Slack/Drive/GitHub searches empty) → fresh initiative, no prior decisions to honor (possible ingestion gap, low confidence).

## Bridge / prior-art landscape

| Option | Nostr | AP | ATProto | Hosted by | Verdict for us |
|---|---|---|---|---|---|
| **mostr.pub** | ✅ | ✅ | ❌ | 3rd party | ❌ **Rejected** — no moderation, widely **defederated/blocked** by AP instances. Reputation poison. |
| **Bridgy Fed** (fed.brid.gy) | ⚠️ text-oriented, not launched for Nostr | ✅ | ✅ | A New Social (snarfed) | **Wrong tool for us.** Useful as split-domain/mapping reference, not as Divine's backend. |
| **fedybridge** (repo) | ❓ | ✅ | ✅ | external (not in our repos) | Reference only if we need mapping examples. |
| **Our `divine-activity-pub`** (Divine AP Gateway, B2) | source | ✅ (to build) | ❌ | **us** | ✅ **Chosen** — native AP projection of Nostr; only path to `@user@divine.video` + moderation control. |

### Notes
- **mostr is out** as infra: unmoderated, blocked by well-run instances → our users would be invisible to the exact audiences (good Loops/Pixelfed/Mastodon servers) we want.
- **Bridgy Fed Nostr status:** repo `snarfed/bridgy-fed` contains `nostr.py`, `nostr_hub.py`, `nostr.brid.gy.as2.json` (a real bridge-actor doc), and a `Protocol` base-class abstraction + `granary` for format conversion. README still lists Nostr as "under consideration" (issues #446/#447). `nostr.brid.gy` **301-redirects to `fed.brid.gy`** → subdomain reserved, not standing up as an independent launched service. **Conclusion: code present, not officially live.** Worth studying its Nostr↔AS2 mapping as reference.

## Loops — target consumer (RESOLVED 2026-05-30)

- Federated short-video app from the **Pixelfed team** (ActivityPub, *not* ATProto).
- **✅ Loops federates over ActivityPub — live since 2025-10-14** (beta). [blog.joinloops.org/loops-joins-the-fediverse](https://blog.joinloops.org/loops-joins-the-fediverse/)
- **Real instance domain is `loops.video`** (live-verified 2026-05-30): `/nodeinfo/2.1` → software `loops` **v1.0.0-beta.12**, `protocols:["activitypub"]`, **`usage.users.total: 41,687` at probe time**; WebFinger live (`acct:loops@loops.video` → actor `https://loops.video/ap/users/79166405735485440`), per-user actors expose `rel=self` ActivityPub JSON, shared inbox, FEP-3b86 follow-intent templates, and avatars on `loopsusercontent.com`. `joinloops.org` is the marketing/docs host — probes there 404. Self-hostable instances supported.
- **🎯 Wire format: `Note` objects with a video *attachment* — NOT `Video` objects** — chosen deliberately "for maximum compatibility" so content renders on Mastodon/Pixelfed/PeerTube too. They federate multiple encodings, thumbnails, captions, content warnings.
- AP surface: instance actor + per-user actors, **shared inbox**, WebFinger for users and instance. Federated: **Follow, Like, Comment (`Comment`/`CommentReply` objects), Announce**. HTTP-signed.
- Beta caveats: "some federation edge cases," transcoding/perf still improving.
- REST API also exists ([docs.joinloops.org](https://docs.joinloops.org/), OpenAPI v1.0.0, Bearer auth, `POST /v1/studio/upload`) — a fallback per-account path, but **federation is the right integration** now that it's live.

**→ Outbound decision:** deliver Divine videos via **AP federation** as **`Note` + video attachment**, mirroring Loops' own convention. Get the exact wire shape at build time from a real Loops post or `loops-server` source if public outboxes stay sparse.

## Local repo landscape (`/Users/rabble/code/divine`, 69 repos)

- `divine-activity-pub` → **empty** (this repo).
- **No** `mostr` / `fedybridge` / `bridgy` repo locally → those are external.
- Nostr infra: `divine-relay-manager`, `divine-relay-sync`, `flutter_embedded_nostr_relay`, `nostr_sdk`, `nostrvine`, `divine-signer`, `divine-name-server`.
- ATProto track (out of scope): `divine-sky`, `divine-atproto-web`, `rsky`.
- `divine-web-loop-counts` → Vine-style **"loop" play-counts** (naming overlap; *not* Loops-the-app).
- Web/app: `divine-web`, `divine-mobile`, `divine-router`, `divine-connect`.

## Synthesis — answers to the four questions (2026-05-30)

1. **User counting on AP** → **~0 today.** No AP presence exists. Implement WebFinger for discoverability and NodeInfo for instance/user counts. Use distinct active `pubkey` in `usernames` as the first `usage.users.total` metric.
2. **Own server/instance?** → **We build the "Divine AP Gateway"** — a native AP projection of Nostr, not a third-party video server and not a bridge (mostr/Bridgy Fed out). Nostr stays the single source of truth; AP is a published projection. We already own the naming layer (`divine-name-server`). See decision below.
3. **Publish for Loops** → Loops federates over AP (live, `loops.video`). Deliver Divine videos as **AP `Note` + video attachment** (Loops' own max-compat convention) — renders on Loops + Mastodon + Pixelfed + PeerTube.
4. **Map AP back into Nostr/Divine** → not first ship. Inbound Follow/Like/Comment/Announce needs a separate surrogate-identity/proxy design.

### Moderation stack (read 2026-05-30) — supports B2

Divine already runs real content moderation, which is why **B2 is viable**:

- **Active:** `divine-moderation-service` (CF Queue → **Sightengine** visual classification, 3–4 frames/6s video → verdicts in D1 + quarantine flags in KV + NIP-56 kind-1984 events) + `divine-moderation-api`. Thresholds: SAFE `<0.6` / REVIEW `0.6–0.8` / QUARANTINE `≥0.8`.
- **Extra signals:** `divine-ai-detector` (AI-watermark ONNX), `divine-inquisitor` (C2PA provenance). `osprey` = rules engine, **not yet wired into video moderation**.
- **Data model:** keyed on **`sha256` (video hash)**, not Nostr event id (optional `uploadedBy` pubkey + `nostrEventId`).
- **✅ Queryable verdict (the federation hook):** `GET /check-result/{sha256}` (public, no auth) → `{ moderated, blocked, quarantined, action, … }`.

**⚠️ Two design consequences for federation:**
1. **Moderation is reactive, not a publish-time gate** — content is served from CDN before moderation completes; quarantine enforced at serve-time (Blossom → HTTP 451). **Federation is NOT retractable**, so the **gateway must gate at the AP boundary**: before emitting a video, wait for `moderated:true` and require not `blocked`/`quarantined` (likely hold `REVIEW` too). Hook exists; just enforce it.
2. **No CSAM hash-matching (PhotoDNA/NCMEC) yet** — only Sightengine visual scoring. Highest-stakes federation risk; flag as a pre-launch requirement before opening outbound.

### Architecture — decision: B2 Divine AP Gateway

Build a **native ActivityPub projection of Divine's Nostr data**. Do not run PeerTube/Loops/Pixelfed as a second product. Nostr stays the source of truth; ActivityPub is a public gateway.

Why this stays KISS: the gateway **hosts nothing new** — it projects systems we already run:

| Layer | Already exists | Gateway adds |
|---|---|---|
| Identity | `divine-name-server` (usernames→pubkey) | WebFinger → actor |
| Content | `relay.divine.video` (kind 34236) | read → project as AP `Note`+attachment |
| Video files/thumbs | Blossom/Fastly CDN | attachment `url` **points at existing CDN URL** — no hosting/transcoding |
| Moderation | `/check-result/{sha256}` | gate before emit |

What we build:

1. `divine-name-server`: WebFinger for `acct:user@divine.video` and NodeInfo counts.
2. `divine-activity-pub`: actors, outbox, inbox, HTTP signatures, delivery, NodeInfo if not served by name-server.
3. Outbound projection: Nostr kind 34236 → moderation gate → AP `Note` + video attachment.

The risk is not protocol complexity; it is **federation hygiene**. mostr is the cautionary example: same gateway idea, no adequate moderation. Non-negotiable edges over mostr: `/check-result` gate, `@user@divine.video` handles, blocklists, and abuse-report handling.

Gateway shape:
```
OUTBOUND  Nostr kind-34236 event (on relay.divine.video)
  → gateway resolves sha256, queries GET /check-result/{sha256}
  → GATE: require moderated:true AND not blocked/quarantined (hold REVIEW)
  → project as AP actor (@user@divine.video) + Note w/ video attachment (url → Divine CDN)
  → HTTP-signed delivery to followers' inboxes; served from outbox
INBOUND   remote inbox activity (Follow/Like/Announce/Reply)
  → map back to Nostr (HARD — see below)
NAMING    WebFinger on divine.video → actor URL; if actor host differs, it also serves WebFinger
```

**⚠️ Inbound (AP → Nostr) is the genuinely hard, unsolved piece.** A remote actor `@alice@mastodon.social` has no Nostr keypair, so inbound follows/likes/comments require minting **surrogate Nostr identities** (or a proxy scheme), and the gateway becomes **custodial of per-user AP signing keys**. Treat as a hard separate design; **outbound (Nostr→AP) ships first.**

Outstanding before coding: confirm prod data source for name-server, decide whether NodeInfo lives on `divine.video` or the gateway host, capture exact Loops attachment JSON, and design the outbound projection + moderation gate.

## Open questions / next steps

**Resolved this session:** ✅ Loops federates (`loops.video`, `Note`+attachment) · ✅ Bridgy Fed mapping read (reference only, rejected as backend) · ✅ identity scheme mapped (`divine-name-server`, NIP-98) · ✅ Divine video kind is 34236 · ✅ AP user count ≈ 0.

**Still open:**
- [ ] **Confirm prod data source** for `divine-name-server` (source has D1/KV; verify deployed bindings before adding WebFinger/NodeInfo).
- [ ] **Place NodeInfo:** serve it from `divine.video` or the gateway host; count distinct active `pubkey` in `usernames`.
- [~] **Wire format → see [wire-format.md](./wire-format.md).** Actor captured live (`/ap/users/1`); attachment shape is authoritative from Pixelfed `MediaService::activitypub()` (`type:"Document"` + `mediaType` MIME, never `"Video"`); kind-34236 `imeta`→attachment mapping done. **Still need** a byte-level real Loops `Note` — outbox is **auth-gated** (header only), so capture one via a Mastodon inbox we control. (Actor IDs: dansup=`1`; newer users use snowflakes, e.g. `…/ap/users/79166405735485440`.)
- [ ] **Design outbound gateway:** WebFinger, actors, outbox, Note rendering, HTTP signatures, delivery, moderation gate.
- [ ] **Design inbound separately:** AP Follow/Like/Comment/Announce → Nostr needs surrogate identity/proxy design.

## Decisions log

- **2026-05-30** — mostr.pub rejected as infrastructure (no moderation, defederated).
- **2026-05-30** — Clarified: owning `@user@divine.video` requires WebFinger on `divine.video`; if actors live on another host, that host must also pass Mastodon's WebFinger consistency check.
- **2026-05-30** — Bridgy Fed **rejected as backend**: useful reference, but its Nostr path is not ready for Divine video + custom-domain needs. Both turnkey bridges now out.
- **2026-05-30** — **Settled:** naming layer = WebFinger on `divine-name-server` (our handles). Outbound to Loops = `Note`+video-attachment via AP federation.
- **2026-05-30** — **Decision: B2 Divine AP Gateway** — native AP projection of existing Nostr/CDN/moderation systems. Gateway must **gate on moderation before federation**. Inbound AP→Nostr remains a separate hard design.
- **2026-05-30** — Loops federation confirmed live (`loops.video`, since 2025-10-14); format is `Note`+attachment, not `Video`.
