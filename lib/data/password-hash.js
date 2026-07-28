// Password hashing: the stored format, the verifier, and the upgrade path.
//
// The digest used to be written as bare hex — `scryptSync(password, salt, 64)`
// stringified — which records the OUTPUT but not how it was produced. Raising the
// scrypt cost then has no safe move: every stored hash is indistinguishable from
// one made with the new parameters, so old and new can't coexist, nothing can tell
// which rows are still weak, and the only migration is forcing a password reset on
// everyone.
//
// So the parameters travel WITH the digest, modular-crypt style:
//
//   scrypt$N=16384,r=8,p=1,keylen=64$<hex digest>
//
// Verification reads the cost out of the row it is checking, so a store can hold a
// mix of parameters while accounts migrate. Bare-hex rows written before this are
// still valid and are read as the Node defaults they were made with (see
// LEGACY_PARAMS) — nobody is signed out by the change.
//
// WHY IN THE VALUE, NOT A COLUMN: the hash and its cost are one fact, and the
// places a hash travels through — `exportStore`/`importStore`, the frozen
// `auth-store.json` fallback, an R2 restore, the `pending_registrations` row that
// carries a hash for 15 minutes before it becomes a user — would each need to carry
// and re-join a parallel column. A self-describing string cannot desync from itself.
//
// See `security.md` for the operational procedure for raising the cost.

import crypto from 'crypto';

export const PASSWORD_HASH_ALGORITHM = 'scrypt';

/**
 * The parameters new hashes are written with. **This is the knob** — raise `N`
 * (always a power of two; the cost is linear in it) and every subsequent write
 * uses it, while existing rows keep verifying under their own parameters and are
 * re-hashed the next time their owner signs in (see `needsRehash`).
 *
 * Left at Node's own defaults deliberately: N=16384 with r=8 is ~16 MB and ~100 ms
 * per hash on the Render instance. Logins are unauthenticated, so the work factor
 * is also a self-inflicted DoS budget — the memory cost is paid per in-flight
 * attempt, and `RL_AUTH` (40 per 15 min per IP) is the only thing bounding how many
 * of those there are. Raise both together, or not at all.
 */
export const PASSWORD_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

/**
 * What a bare-hex row was made with: `crypto.scryptSync(password, salt, 64)`, i.e.
 * Node's defaults. Recorded here so the legacy rows are readable rather than
 * guessed at — do not "clean this up" while any untagged hash can still exist.
 */
export const LEGACY_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

/**
 * scrypt needs ~128 * N * r bytes, and Node's default `maxmem` is 32 MB — so the
 * first attempt to raise N past 16384 would fail with an opaque "memory limit
 * exceeded" rather than simply costing more. Ask for double the requirement so the
 * knob works as documented.
 *
 * @param {{N: number, r: number}} params
 * @returns {number}
 */
function maxmemFor(params) {
  return 256 * params.N * params.r;
}

/**
 * Compute a raw scrypt digest (hex, no envelope).
 *
 * @param {string} password
 * @param {string} salt
 * @param {{N: number, r: number, p: number, keylen: number}} [params]
 * @returns {string}
 */
function scryptHex(password, salt, params = PASSWORD_PARAMS) {
  const { N, r, p, keylen } = params;
  return crypto
    .scryptSync(String(password ?? ''), String(salt ?? ''), keylen, { N, r, p, maxmem: maxmemFor({ N, r }) })
    .toString('hex');
}

/**
 * Hash a password into its stored form, tagged with the parameters used.
 *
 * @param {string} password
 * @param {string} salt Per-user salt (see the store's `newSalt`).
 * @param {{N: number, r: number, p: number, keylen: number}} [params]
 * @returns {string} e.g. `scrypt$N=16384,r=8,p=1,keylen=64$<hex>`
 */
export function hashPassword(password, salt, params = PASSWORD_PARAMS) {
  const { N, r, p, keylen } = params;
  const digest = scryptHex(password, salt, params);
  return `${PASSWORD_HASH_ALGORITHM}$N=${N},r=${r},p=${p},keylen=${keylen}$${digest}`;
}

/**
 * Split a stored hash into its parameters and digest.
 *
 * An untagged value is a legacy bare-hex digest: it reads as `LEGACY_PARAMS`, with
 * `keylen` taken from the digest's own length so a row of any width still verifies.
 * `legacy: true` marks it for re-hashing.
 *
 * Returns `null` only for something that is neither — an empty, malformed, or
 * unknown-algorithm value, which must never be treated as a match.
 *
 * @param {unknown} stored
 * @returns {{algorithm: string, params: {N: number, r: number, p: number, keylen: number}, digest: string, legacy: boolean} | null}
 */
export function parsePasswordHash(stored) {
  const s = String(stored ?? '');
  if (!s) return null;

  if (!s.includes('$')) {
    if (!/^[0-9a-f]+$/i.test(s) || s.length % 2 !== 0) return null;
    return {
      algorithm: PASSWORD_HASH_ALGORITHM,
      params: { ...LEGACY_PARAMS, keylen: s.length / 2 },
      digest: s.toLowerCase(),
      legacy: true,
    };
  }

  const parts = s.split('$');
  if (parts.length !== 3) return null;
  const [algorithm, paramText, digest] = parts;
  if (algorithm !== PASSWORD_HASH_ALGORITHM) return null;
  if (!/^[0-9a-f]+$/i.test(digest) || digest.length % 2 !== 0) return null;

  /** @type {Record<string, number>} */
  const parsed = {};
  for (const pair of paramText.split(',')) {
    const [key, raw] = pair.split('=');
    const value = Number(raw);
    if (!key || !Number.isInteger(value) || value <= 0) return null;
    parsed[key] = value;
  }
  const { N, r, p, keylen } = parsed;
  if (!N || !r || !p || !keylen) return null;
  if (keylen !== digest.length / 2) return null; // the envelope must describe its own digest

  return { algorithm, params: { N, r, p, keylen }, digest: digest.toLowerCase(), legacy: false };
}

/** True when `params` differ from what new hashes are written with. */
function paramsMatchCurrent(params) {
  return (
    params.N === PASSWORD_PARAMS.N &&
    params.r === PASSWORD_PARAMS.r &&
    params.p === PASSWORD_PARAMS.p &&
    params.keylen === PASSWORD_PARAMS.keylen
  );
}

/**
 * Check a password against a stored hash, under the parameters that hash records.
 *
 * `needsRehash` is the upgrade path: it is true when the row verified but was
 * written with anything other than the current parameters (including the legacy
 * bare-hex form). The caller — which is the only place holding the plaintext — can
 * then re-hash and save. It is only ever true alongside `ok`, so a caller cannot
 * upgrade a row on a failed attempt.
 *
 * The comparison is constant-time over equal-length buffers; a length mismatch is
 * decided before that, which leaks only the stored keylen (not a secret).
 *
 * @param {string} password The attempted plaintext.
 * @param {string} salt The row's salt.
 * @param {unknown} stored The row's password hash.
 * @returns {{ok: boolean, needsRehash: boolean}}
 */
export function verifyPassword(password, salt, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return { ok: false, needsRehash: false };

  const attempt = Buffer.from(scryptHex(password, salt, parsed.params), 'hex');
  const expected = Buffer.from(parsed.digest, 'hex');
  if (attempt.length !== expected.length || !crypto.timingSafeEqual(attempt, expected)) {
    return { ok: false, needsRehash: false };
  }
  return { ok: true, needsRehash: parsed.legacy || !paramsMatchCurrent(parsed.params) };
}

/**
 * Burn one hash's worth of work and discard it.
 *
 * Login's miss paths (no such user, Google-only account) call this so they cost the
 * same wall-clock as a real check — otherwise the generic "Invalid email or
 * password" would still be a user-enumeration oracle by the clock. Always uses the
 * CURRENT parameters, which is what a freshly-written row costs.
 *
 * @param {string} password
 * @param {string} salt A throwaway salt.
 * @returns {void}
 */
export function burnPasswordHash(password, salt) {
  scryptHex(password, salt, PASSWORD_PARAMS);
}
