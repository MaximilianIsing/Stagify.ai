// API keys — the account identity behind every `/api/v1/*` call.
//
// WHAT THIS REPLACES. Until now the only headless entry was
// POST /api/stage-by-endpoint-key, guarded by ONE shared secret that also opens
// /promptlogs, /authstore, every /api/admin/* route and POST /api/getpro. It named
// no account, could not be revoked for one caller, and metered nothing. A key here
// belongs to exactly one user, is revocable on its own, and cannot render without a
// prepaid balance.
//
// STORED AS A DIGEST, LIKE SESSIONS. An API key is a bearer credential: whoever holds
// the string is the account. Stored raw, anything that can read the database file — a
// stolen /data volume, a Litestream restore, a backup download — is a set of
// ready-to-use credentials with a balance attached. So the plaintext is returned ONCE,
// at creation, and only `sha256$<hex>` reaches disk. hashToken/TOKEN_HASH_PREFIX come
// from lib/data/session-tokens.js rather than being redefined here: that prefix is
// load-bearing for idempotent migration, and there must be exactly one definition of
// the at-rest format in the codebase.
//
// WHY NO CONSTANT-TIME COMPARE. `key_hash` is UNIQUE, so authentication is a single
// indexed digest lookup — there is no per-candidate comparison loop for a timing
// signal to leak from, and the input is 32 bytes of CSPRNG output, so there is no
// keyspace to walk anyway. That differs from lib/http/http-guards.js, which compares
// one submitted string against one known secret and therefore does need the guard.

import crypto from 'crypto';
import { getDb } from './db.js';
import { hashToken } from './session-tokens.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  extra_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
`;

// Live-key marker in the plaintext. Present so a leaked key is greppable in logs and
// recognisable in a support ticket — the same reason Stripe prefixes theirs.
const KEY_PREFIX = 'stg_live_';

// How much of the plaintext the dashboard may show. Enough to tell two keys apart in
// a list, far too little to authenticate with.
const DISPLAY_CHARS = 12;

// A ceiling on keys per account. Not a security boundary — it stops a scripted loop
// filling the table, and it is well above any real integration's needs.
export const MAX_KEYS_PER_USER = 25;

/** @param {string} [name] @returns {string} A trimmed, bounded display name. */
function cleanName(name) {
  return String(name ?? '').trim().slice(0, 60);
}

/**
 * Build the API-key store over the shared app database.
 * @param {string} baseDir - Server base dir (resolves to /data on Render, ./data locally).
 * @param {{ now?: () => number }} [opts] - Injectable clock (tests).
 * @returns {ReturnType<typeof build>} The key API.
 */
export function createApiKeys(baseDir, opts = {}) {
  const db = getDb(baseDir);
  db.exec(SCHEMA);
  return build(db, typeof opts.now === 'function' ? opts.now : () => Date.now());
}

/**
 * @param {any} db - The shared better-sqlite3 connection.
 * @param {() => number} now - Clock.
 */
function build(db, now) {
  const q = {
    insert: db.prepare(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at)
       VALUES (@id, @userId, @name, @keyHash, @keyPrefix, @createdAt)`,
    ),
    byHash: db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
    byId: db.prepare('SELECT * FROM api_keys WHERE id = ?'),
    forUser: db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'),
    countLive: db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL'),
    revoke: db.prepare('UPDATE api_keys SET revoked_at = @now WHERE id = @id AND revoked_at IS NULL'),
    touch: db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
    rename: db.prepare('UPDATE api_keys SET name = @name WHERE id = @id'),
  };

  /**
   * Public shape — never carries the key or its digest.
   * @param {any} row - An `api_keys` row.
   * @returns {{ id: string, name: string, prefix: string, createdAt: number, lastUsedAt: number | null, revokedAt: number | null } | null} The safe view.
   */
  function toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name ?? '',
      prefix: row.key_prefix ?? '',
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      revokedAt: row.revoked_at ?? null,
    };
  }

  /**
   * Mint a key. The plaintext is returned here and NEVER again — no route, no admin
   * view and no database read can recover it, which is the whole point.
   * @param {{ userId: string, name?: string }} input - Owner and display name.
   * @returns {{ ok: boolean, reason?: string, key?: string, record?: any }} The new key.
   */
  function mintKey(input) {
    if (q.countLive.get(input.userId).n >= MAX_KEYS_PER_USER) {
      return { ok: false, reason: 'too_many_keys' };
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const plaintext = KEY_PREFIX + secret;
    const id = 'ak_' + crypto.randomBytes(8).toString('hex');
    const record = {
      id,
      userId: input.userId,
      name: cleanName(input.name) || 'API key',
      keyHash: hashToken(plaintext),
      keyPrefix: plaintext.slice(0, DISPLAY_CHARS),
      createdAt: now(),
    };
    q.insert.run(record);
    return { ok: true, key: plaintext, record: toPublic(q.byId.get(id)) };
  }

  /**
   * Resolve a presented key to its row. Hashes what it is given, so the caller
   * never has to know the at-rest format.
   * @param {string} plaintext - The raw bearer key from the Authorization header.
   * @returns {any | null} The row (including `revoked_at`, which the caller checks), or null.
   */
  function findByKey(plaintext) {
    const s = String(plaintext ?? '');
    if (!s) return null;
    return q.byHash.get(hashToken(s)) ?? null;
  }

  /**
   * Every key an account holds, safe to serialize.
   * @param {string} userId - Account id.
   * @returns {any[]} Public key records, newest first.
   */
  function listForUser(userId) {
    return q.forUser.all(userId).map(toPublic);
  }

  /**
   * Revoke a key, scoped to its owner.
   *
   * A key belonging to somebody else answers exactly as a key that never existed, so
   * the route can 404 both and the endpoint is not an existence oracle for key ids.
   * @param {{ id: string, userId: string }} input - The key and the claimed owner.
   * @returns {{ ok: boolean, reason?: string }} The outcome.
   */
  function revoke(input) {
    const row = q.byId.get(input.id);
    if (!row || row.user_id !== input.userId) return { ok: false, reason: 'not_found' };
    if (q.revoke.run({ id: input.id, now: now() }).changes === 0) {
      return { ok: false, reason: 'already_revoked' };
    }
    return { ok: true };
  }

  /**
   * Rename a key, scoped to its owner.
   * @param {{ id: string, userId: string, name: string }} input - The key, owner and new name.
   * @returns {{ ok: boolean, reason?: string, record?: any }} The outcome.
   */
  function rename(input) {
    const row = q.byId.get(input.id);
    if (!row || row.user_id !== input.userId) return { ok: false, reason: 'not_found' };
    q.rename.run({ id: input.id, name: cleanName(input.name) || 'API key' });
    return { ok: true, record: toPublic(q.byId.get(input.id)) };
  }

  /**
   * Stamp last-used. Called on every authenticated request, so it is a bare UPDATE
   * with no read and no transaction.
   * @param {string} id - The key id.
   * @returns {void}
   */
  function touchLastUsed(id) {
    q.touch.run(now(), id);
  }

  /**
   * One key by id, owner-scoped. Public shape.
   * @param {{ id: string, userId: string }} input - The key and the claimed owner.
   * @returns {any | null} The record, or null.
   */
  function getForUser(input) {
    const row = q.byId.get(input.id);
    if (!row || row.user_id !== input.userId) return null;
    return toPublic(row);
  }

  return { mintKey, findByKey, listForUser, revoke, rename, touchLastUsed, getForUser };
}
