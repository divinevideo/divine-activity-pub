-- Divine ActivityPub Gateway — local signer key storage (SIGNER_MODE=local).
-- Mirrored as CREATE TABLE IF NOT EXISTS in src/db.mjs (initSchema).
--
-- ⚠️ DEV/STAGING ONLY: this table holds per-actor RSA PRIVATE keys (PKCS8,
-- base64). In production set SIGNER_MODE=keycast so the gateway never stores a
-- private key — keycast custodies them and signs remotely.
CREATE TABLE IF NOT EXISTS local_keys (
  actor         TEXT PRIMARY KEY,   -- the AP actor URL the key belongs to
  public_pem    TEXT NOT NULL,      -- SPKI public key, PEM
  private_pkcs8 TEXT NOT NULL,      -- PKCS8 private key, base64 (dev/staging only)
  created_at    INTEGER NOT NULL    -- epoch millis
);
