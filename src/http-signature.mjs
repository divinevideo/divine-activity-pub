// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: draft-cavage HTTP Signatures — ONE signing-string builder shared by
// ABOUTME: inbound verify and outbound sign; WebCrypto RSASSA-PKCS1-v1_5 + SHA-256.

/**
 * Build the draft-cavage signing string from an ordered list of header names.
 * The special pseudo-header `(request-target)` is rendered as
 * `<method-lowercase> <path>`. All other names map to the provided header value.
 * This is the single source of truth for both verify (inbound) and sign
 * (outbound) so the two can never drift.
 *
 * @param {object} args
 * @param {string[]} args.headerNames ordered, lowercased (e.g. ['(request-target)','host','date','digest'])
 * @param {string} args.method HTTP method (e.g. 'POST')
 * @param {string} args.path request target path (incl. query), e.g. '/ap/users/x/inbox'
 * @param {Record<string,string>} args.headers lowercased header name -> value
 * @returns {string}
 */
export function buildSigningString({ headerNames, method, path, headers }) {
  const lines = [];
  for (const name of headerNames) {
    const key = name.toLowerCase();
    if (key === '(request-target)') {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
    } else {
      const value = headers[key];
      if (value == null) {
        throw new Error(`signing string references missing header: ${key}`);
      }
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

/**
 * Parse a draft-cavage `Signature` header into its components.
 * Example: keyId="https://x/actor#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="base64=="
 * @param {string} header
 * @returns {{keyId:string, algorithm?:string, headers:string[], signature:string}}
 */
export function parseSignatureHeader(header) {
  if (!header || typeof header !== 'string') {
    throw new Error('missing Signature header');
  }
  const out = {};
  // Split on commas that separate key="value" pairs.
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(header)) !== null) {
    out[m[1]] = m[2];
  }
  if (!out.keyId || !out.signature) {
    throw new Error('Signature header missing keyId or signature');
  }
  const headers = (out.headers || 'date').split(/\s+/).filter(Boolean);
  return {
    keyId: out.keyId,
    algorithm: out.algorithm,
    headers,
    signature: out.signature,
  };
}

/** Compute the base64 `SHA-256=<digest>` value for a request body. */
export async function computeDigest(body) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `SHA-256=${base64FromBytes(new Uint8Array(hash))}`;
}

/** Import an RSA public key from PEM (SPKI) for RSASSA-PKCS1-v1_5 verify. */
export async function importPublicKeyPem(pem) {
  const der = pemToDer(pem, 'PUBLIC KEY');
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/**
 * Verify an inbound HTTP signature (draft-cavage, rsa-sha256).
 *
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.path
 * @param {Record<string,string>} args.headers lowercased header map (must include the signed headers + `signature`)
 * @param {string|Uint8Array} [args.body] raw body, to validate the Digest header
 * @param {(keyId:string)=>Promise<string>} args.fetchPublicKeyPem resolves keyId -> PEM (fetch remote actor)
 * @returns {Promise<{ok:boolean, reason?:string, keyId?:string}>}
 */
export async function verifySignature({ method, path, headers, body, fetchPublicKeyPem }) {
  let sig;
  try {
    sig = parseSignatureHeader(headers.signature || headers.authorization);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  if (sig.algorithm && sig.algorithm.toLowerCase() !== 'rsa-sha256' &&
      sig.algorithm.toLowerCase() !== 'hs2019') {
    return { ok: false, reason: `unsupported algorithm: ${sig.algorithm}` };
  }

  // If the signature covers `digest`, the body's digest must match the header.
  if (sig.headers.includes('digest')) {
    if (body == null) {
      return { ok: false, reason: 'digest signed but no body provided' };
    }
    const expected = await computeDigest(body);
    const provided = headers.digest || '';
    if (!digestMatches(provided, expected)) {
      return { ok: false, reason: 'digest mismatch', keyId: sig.keyId };
    }
  }

  let signingString;
  try {
    signingString = buildSigningString({
      headerNames: sig.headers,
      method,
      path,
      headers,
    });
  } catch (e) {
    return { ok: false, reason: e.message, keyId: sig.keyId };
  }

  let pem;
  try {
    pem = await fetchPublicKeyPem(sig.keyId);
  } catch (e) {
    return { ok: false, reason: `key fetch failed: ${e.message}`, keyId: sig.keyId };
  }
  if (!pem) return { ok: false, reason: 'no public key for keyId', keyId: sig.keyId };

  let key;
  try {
    key = await importPublicKeyPem(pem);
  } catch (e) {
    return { ok: false, reason: `bad public key: ${e.message}`, keyId: sig.keyId };
  }

  let signatureBytes;
  try {
    signatureBytes = bytesFromBase64(sig.signature);
  } catch (e) {
    return { ok: false, reason: 'bad base64 signature', keyId: sig.keyId };
  }

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signatureBytes,
    new TextEncoder().encode(signingString),
  );
  return ok ? { ok: true, keyId: sig.keyId } : { ok: false, reason: 'signature invalid', keyId: sig.keyId };
}

/**
 * Build the headers + signing string for an OUTBOUND signed POST. The actual
 * RSA signing is delegated to the keycast client (private key never leaves it).
 *
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.url full target URL
 * @param {string} args.body request body (JSON string)
 * @param {string} args.keyId publicKey.id of the Divine actor (goes into Signature header)
 * @param {(signingString:string)=>Promise<string>} args.sign returns base64 RSA-SHA256 sig
 * @returns {Promise<{headers:Record<string,string>, signingString:string}>}
 */
export async function buildSignedRequest({ method, url, body, keyId, sign }) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  const date = new Date().toUTCString();
  const digest = await computeDigest(body);
  const headerMap = {
    '(request-target)': '',
    host: u.host,
    date,
    digest,
    'content-type': 'application/activity+json',
  };
  const headerNames = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
  const signingString = buildSigningString({ headerNames, method, path, headers: headerMap });
  const signature = await sign(signingString);
  const headerList = headerNames.join(' ');
  return {
    headers: {
      Host: u.host,
      Date: date,
      Digest: digest,
      'Content-Type': 'application/activity+json',
      Signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="${headerList}",signature="${signature}"`,
    },
    signingString,
  };
}

// --- encoding helpers ---

function digestMatches(provided, expected) {
  // Compare case-insensitively on the algorithm token, exact on the base64 value.
  const norm = (s) => s.trim().replace(/^sha-256=/i, 'SHA-256=');
  return norm(provided) === norm(expected);
}

export function base64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function bytesFromBase64(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemToDer(pem, label) {
  const body = String(pem)
    .replace(new RegExp(`-----BEGIN ${label}-----`), '')
    .replace(new RegExp(`-----END ${label}-----`), '')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  return bytesFromBase64(body);
}
