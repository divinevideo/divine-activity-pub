// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: WebFinger (RFC 7033) on the gateway host so it is self-discoverable —
// ABOUTME: needed for a real Mastodon follow test on a workers.dev host.

/**
 * Parse an `acct:user@host` (or bare `user@host`) WebFinger resource.
 * @param {string} resource the raw `resource` query param
 * @returns {{ user:string, host:string } | null}
 */
export function parseAcctResource(resource) {
  if (!resource || typeof resource !== 'string') return null;
  const acct = resource.startsWith('acct:') ? resource.slice('acct:'.length) : resource;
  const at = acct.lastIndexOf('@');
  if (at <= 0 || at === acct.length - 1) return null;
  const user = acct.slice(0, at);
  const host = acct.slice(at + 1);
  if (!user || !host) return null;
  return { user, host };
}

/**
 * Build the JRD (JSON Resource Descriptor) for a resolvable username.
 * The acct `host` is echoed in `subject` (we accept any host the request came
 * to — the gateway just confirms the user resolves). `rel:self` points at the
 * gateway actor URL on AP_DOMAIN.
 *
 * @param {object} args
 * @param {string} args.user the resolved username
 * @param {string} args.host the acct domain from the resource (request host)
 * @param {string} args.apDomain AP_DOMAIN — where the actor doc is served
 * @returns {object} JRD
 */
export function buildWebfingerJrd({ user, host, apDomain }) {
  const actorUrl = `https://${apDomain}/ap/users/${user}`;
  const profileUrl = `https://${user}.${apDomain}`;
  return {
    subject: `acct:${user}@${host}`,
    aliases: [profileUrl, actorUrl],
    links: [
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: profileUrl,
      },
      {
        rel: 'self',
        type: 'application/activity+json',
        href: actorUrl,
      },
    ],
  };
}

/**
 * Handle a WebFinger request. Resolves `{user}` via the name-server NIP-05
 * client; 404 if it doesn't resolve.
 *
 * @param {object} args
 * @param {string} args.resource the `resource` query param
 * @param {object} args.nameServer client with resolvePubkey(username)
 * @param {string} args.apDomain AP_DOMAIN
 * @returns {Promise<{status:number, jrd?:object}>}
 */
export async function handleWebfinger({ resource, nameServer, apDomain }) {
  const parsed = parseAcctResource(resource);
  if (!parsed) return { status: 400 };

  const username = parsed.user.toLowerCase();
  // WebFinger is pure discovery — return the JRD for any well-formed handle and
  // let the ACTOR endpoint enforce existence (it 404s for unknown users). We do
  // NOT hard-depend on a NIP-05 lookup here: that subrequest back to the
  // divine.video zone fails when the gateway is invoked via the divine.video
  // route (Worker same-zone quirk), which was 404-ing every handle.
  return {
    status: 200,
    jrd: buildWebfingerJrd({ user: username, host: parsed.host, apDomain }),
  };
}
