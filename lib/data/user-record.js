// The users-table <-> user-object mapping, split out of auth-store.js (which is at
// its line cap) along with the types that describe both sides. Pure: no I/O, no
// connection — auth-store.js owns the statements that read and write the rows.
import { applyGrantExpiry } from './pro-grants.js';

// Keys the code knows how to query/mutate. Anything else on a legacy user object
// is preserved verbatim in extra_json so a migration can never silently drop data.
export const KNOWN_USER_KEYS = new Set([
  'id', 'email', 'passwordSalt', 'passwordHash', 'googleSub', 'plan',
  'usageDay', 'usageCount', 'createdAt', 'stripeCustomerId',
  'stripeSubscriptionId', 'proPassGrantedAt',
]);

/**
 * A user as the rest of the app sees it: the known columns in camelCase, plus any
 * other key round-tripped through extra_json (trial lifecycle, enterprise stamp, …),
 * which is why the shape stays open.
 * @typedef {{ id: string, email: string, [key: string]: any }} UserRecord
 */

/**
 * A raw `users` row.
 * @typedef {{ id: string, email: string, password_salt: string | null, password_hash: string | null,
 *   google_sub: string | null, plan: string, usage_day: string | null, usage_count: number,
 *   created_at: string | null, stripe_customer_id: string | null, stripe_subscription_id: string | null,
 *   pro_pass_granted_at: string | null, extra_json: string | null }} UserRow
 */

/**
 * The JSON-shaped store importStore() accepts: an exportStore() payload or the legacy
 * auth-store.json. Every part is optional and every entry is checked before use.
 * @typedef {{
 *   users?: UserRecord[],
 *   sessions?: Record<string, { userId?: string, exp?: number } | null>,
 *   mobileIpUsage?: Record<string, { day?: string, count?: number } | null>,
 *   passwordResetTokens?: Record<string, { userId?: string, exp?: number } | null>,
 *   pendingRegistrations?: Record<string, { passwordSalt?: string, passwordHash?: string,
 *     codeSalt?: string, codeHash?: string, attempts?: number, exp?: number } | null>,
 * }} AuthStoreSnapshot
 */

/** @param {UserRecord} user */
export function userToParams(user) {
  /** @type {Record<string, unknown>} */
  const extra = {};
  for (const k of Object.keys(user)) {
    if (!KNOWN_USER_KEYS.has(k)) extra[k] = user[k];
  }
  return {
    id: user.id,
    email: user.email,
    password_salt: user.passwordSalt ?? null,
    password_hash: user.passwordHash ?? null,
    google_sub: user.googleSub ?? null,
    plan: user.plan ?? 'free',
    usage_day: user.usageDay ?? null,
    usage_count: Number.isFinite(user.usageCount) ? user.usageCount : 0,
    created_at: user.createdAt ?? null,
    stripe_customer_id: user.stripeCustomerId ?? null,
    stripe_subscription_id: user.stripeSubscriptionId ?? null,
    pro_pass_granted_at: user.proPassGrantedAt ?? null,
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

/** @param {UserRow | undefined} row @returns {UserRecord | null} */
export function rowToUser(row) {
  if (!row) return null;
  const extra = row.extra_json ? safeParse(row.extra_json) : {};
  // Known columns win over anything in extra_json.
  /** @type {UserRecord} */
  const user = {
    ...extra,
    id: row.id,
    email: row.email,
    plan: row.plan,
    usageDay: row.usage_day, // may be null (matches the old shape)
    usageCount: row.usage_count,
    createdAt: row.created_at,
  };
  if (row.password_salt != null) user.passwordSalt = row.password_salt;
  if (row.password_hash != null) user.passwordHash = row.password_hash;
  if (row.google_sub != null) user.googleSub = row.google_sub;
  if (row.stripe_customer_id != null) user.stripeCustomerId = row.stripe_customer_id;
  if (row.stripe_subscription_id != null) user.stripeSubscriptionId = row.stripe_subscription_id;
  if (row.pro_pass_granted_at != null) user.proPassGrantedAt = row.pro_pass_granted_at;
  // Lapsed admin comp grants read as free everywhere — see lib/data/pro-grants.js.
  return applyGrantExpiry(user);
}

/** @param {string} s @returns {Record<string, unknown>} */
function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}
