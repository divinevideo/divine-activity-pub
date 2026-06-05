// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: HTTP clients for FunnelCake (videos/profiles), moderation (/check-result),
// ABOUTME: name-server NIP-05 (username<->pubkey), plus the moderation gate predicate.

/**
 * FunnelCake REST client (public, no auth). Returns imeta-normalized fields.
 * @param {object} opts
 * @param {string} opts.baseUrl e.g. https://api.divine.video
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createFunnelcakeClient({ baseUrl, fallbackBaseUrl, fetchImpl = fetch }) {
  // The videos endpoint intermittently 503s for the worker's egress on the primary
  // host. Try primary (with retries), then fail over to the backup host.
  const hosts = [baseUrl, fallbackBaseUrl].filter(Boolean);
  async function getJson(path) {
    let last = 0;
    for (const host of hosts) {
      for (let attempt = 0; attempt < 3; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(`${host}${path}`, { headers: { Accept: 'application/json' } });
        if (res.ok) return res.json();
        last = res.status;
        if (res.status < 500) throw new Error(`funnelcake ${res.status} ${path}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw new Error(`funnelcake ${last} ${path} (all hosts exhausted)`);
  }
  return {
    // GET /api/users/{pubkey} -> { pubkey, profile:{name,display_name,about,picture,nip05,...}, stats:{video_count,...} }.
    // Flatten so callers can read name/about/picture/video_count at the top level.
    async getProfile(pubkey) {
      const body = await getJson(`/api/users/${encodeURIComponent(pubkey)}`);
      const p = body.profile || body;
      return {
        ...p,
        pubkey: body.pubkey || pubkey,
        video_count: body.stats?.video_count ?? body.video_count ?? p.video_count ?? 0,
      };
    },
    // GET /api/users/{pubkey}/videos -> { data, pagination, next_cursor } (kinds 34236/34235)
    async getUserVideos(pubkey, limit = 24) {
      // Cursor-paginate the v2 endpoint to gather up to `limit` videos. The API
      // returns { data, pagination:{ next_cursor:"o:100", has_more } }, capped at
      // 100/page — so the full back-catalogue needs to follow the cursor.
      const pk = encodeURIComponent(pubkey);
      const out = [];
      let cursor = null;
      let guard = 0;
      while (out.length < limit && guard < 50) {
        guard += 1;
        const page = Math.min(100, limit - out.length);
        const q = `limit=${page}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        // eslint-disable-next-line no-await-in-loop
        const body = await getJson(`/api/v2/users/${pk}/videos?${q}`);
        const data = Array.isArray(body) ? body : (body.data || body.videos || []);
        out.push(...data);
        const pg = (body && body.pagination) || {};
        cursor = pg.next_cursor;
        if (!pg.has_more || !cursor || data.length === 0) break;
      }
      return out;
    },
    // GET /api/v2/videos?sort=recent -> new-video firehose (delivery trigger)
    async getRecentVideos(limit = 50) {
      const body = await getJson(`/api/v2/videos?sort=recent&limit=${limit}`);
      return Array.isArray(body) ? body : (body.data || body.videos || []);
    },
  };
}

/**
 * Moderation verdict client. GET /check-result/{sha256} (public, no auth).
 * @param {object} opts
 * @param {string} opts.baseUrl e.g. https://moderation-api.divine.video
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createModerationClient({ baseUrl, fetchImpl = fetch }) {
  return {
    async checkResult(sha256) {
      const res = await fetchImpl(`${baseUrl}/check-result/${encodeURIComponent(sha256)}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) return { moderated: false };
      if (!res.ok) throw new Error(`moderation ${res.status} for ${sha256}`);
      return res.json();
    },
  };
}

/**
 * Decide whether a moderation verdict permits federation. Fail CLOSED:
 * require moderated===true AND not blocked AND not quarantined. "Not yet
 * moderated" and REVIEW both fail — federation is not retractable.
 * @param {object|null} verdict
 * @returns {boolean}
 */
export function verdictAllowsFederation(verdict) {
  // PERMISSIVE (MVP): federate everything EXCEPT content explicitly flagged bad.
  // Most Divine videos are un-moderated (moderated:false/status:"unknown"); a
  // fail-closed gate drops them all. Revisit before scale (CSAM hash-matching).
  if (!verdict) return true;
  if (verdict.blocked === true || verdict.quarantined === true) return false;
  const action = String(verdict.action || '').toUpperCase();
  if (['QUARANTINE', 'BLOCKED', 'PERMANENT_BAN', 'REMOVE'].includes(action)) return false;
  return true;
}

/**
 * Build a per-video gate predicate backed by a moderation client.
 * Videos with no sha256 cannot be verified -> fail closed (skip).
 * @param {{checkResult:(sha:string)=>Promise<object>}} moderation
 * @returns {(video:object)=>Promise<boolean>}
 */
export function makeModerationGate(moderation) {
  return async function gate(video) {
    const sha = video.sha256 || video.sha;
    if (!sha) return false;
    let verdict;
    try {
      verdict = await moderation.checkResult(sha);
    } catch {
      return false; // fail closed on lookup error
    }
    return verdictAllowsFederation(verdict);
  };
}

/**
 * Build a moderation gate that caches POSITIVE (federation-allowed) verdicts in
 * KV. Caching only the allow result is safe: a video that flips from allowed to
 * blocked is handled at serve-time elsewhere (federation is reactive), and we
 * never cache a "deny" so an un-moderated video keeps getting re-checked until
 * it passes. This bounds repeated /check-result subrequests on hot outboxes.
 *
 * @param {{checkResult:(sha:string)=>Promise<object>}} moderation
 * @param {{get:Function, put:Function}} [kv] Workers KV namespace (optional)
 * @param {number} [ttlSeconds]
 * @returns {(video:object)=>Promise<boolean>}
 */
export function makeCachedModerationGate(moderation, kv, ttlSeconds = 3600) {
  const base = makeModerationGate(moderation);
  if (!kv) return base;
  return async function gate(video) {
    const sha = video.sha256 || video.sha;
    if (!sha) return false;
    const key = `gate:${sha}`;
    try {
      if (await kv.get(key)) return true;
    } catch { /* cache miss/unavailable -> fall through */ }
    const ok = await base(video);
    if (ok) {
      try { await kv.put(key, '1', { expirationTtl: ttlSeconds }); } catch { /* best effort */ }
    }
    return ok;
  };
}

/**
 * Name-server client: resolve a Divine username <-> Nostr pubkey via the live
 * NIP-05 endpoint (GET /.well-known/nostr.json?name={user}).
 * @param {object} opts
 * @param {string} opts.baseUrl e.g. https://divine.video
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createNameServerClient({ baseUrl, fetchImpl = fetch }) {
  return {
    /** username -> hex pubkey (or null if unknown). Retries 5xx (the divine.video
     *  edge throttles the Worker's egress with 503, which would 404 WebFinger). */
    async resolvePubkey(username) {
      const u = String(username).toLowerCase();
      for (let attempt = 0; attempt < 4; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(
          `${baseUrl}/.well-known/nostr.json?name=${encodeURIComponent(u)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (res.ok) {
          // eslint-disable-next-line no-await-in-loop
          const body = await res.json();
          const names = body && body.names ? body.names : {};
          return names[u] || names[username] || null;
        }
        if (res.status < 500) return null; // clean 4xx -> genuinely unknown
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      return null;
    },
  };
}
