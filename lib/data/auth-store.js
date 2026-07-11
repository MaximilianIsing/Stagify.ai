import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDataDir, getDb, closeDb } from './db.js';

// Free plan daily generation cap, per UTC day. Enforced server-side before any paid
// AI call (see freeGenerationStatus / recordFreeGeneration). Pro accounts are uncapped.
const FREE_DAILY_LIMIT = 50;
const SESSION_DAYS = 30;
const REGISTRATION_CODE_EXPIRY_MS = 15 * 60 * 1000;
const MAX_REGISTRATION_VERIFY_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Pure helpers (unchanged from the JSON implementation — no storage involved).
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  const h = crypto.scryptSync(password, salt, 64);
  return h.toString('hex');
}
function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function newRegistrationCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function hashVerificationCode(code, salt) {
  return crypto.createHmac('sha256', salt).update(String(code)).digest('hex');
}
function validateRegistrationInput(email, password) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: false, error: 'Invalid email address' };
  }
  if (String(password || '').length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }
  return { ok: true, email: e };
}
function utcDayString() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT UNIQUE NOT NULL,
  password_salt          TEXT,
  password_hash          TEXT,
  google_sub             TEXT,
  plan                   TEXT NOT NULL DEFAULT 'free',
  usage_day              TEXT,
  usage_count            INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  pro_pass_granted_at    TEXT,
  extra_json             TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_sub  ON users(google_sub);
CREATE INDEX IF NOT EXISTS idx_users_stripe_sub  ON users(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_cust ON users(stripe_customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exp     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_ip_usage (
  ip    TEXT PRIMARY KEY,
  day   TEXT,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token   TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exp     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_registrations (
  email         TEXT PRIMARY KEY,
  password_salt TEXT,
  password_hash TEXT,
  code_salt     TEXT,
  code_hash     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  exp           INTEGER NOT NULL
);
`;

// Keys the code knows how to query/mutate. Anything else on a legacy user object
// is preserved verbatim in extra_json so a migration can never silently drop data.
const KNOWN_USER_KEYS = new Set([
  'id', 'email', 'passwordSalt', 'passwordHash', 'googleSub', 'plan',
  'usageDay', 'usageCount', 'createdAt', 'stripeCustomerId',
  'stripeSubscriptionId', 'proPassGrantedAt',
]);

function userToParams(user) {
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

function rowToUser(row) {
  if (!row) return null;
  const extra = row.extra_json ? safeParse(row.extra_json) : {};
  // Known columns win over anything in extra_json.
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
  return user;
}

function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Legacy JSON reader — used ONCE to import an existing auth-store.json.
// This is the only code that touches the old file, and it only ever READS it.
// ---------------------------------------------------------------------------
function loadLegacyJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      users: Array.isArray(data.users) ? data.users : [],
      sessions: data.sessions && typeof data.sessions === 'object' ? data.sessions : {},
      mobileIpUsage: data.mobileIpUsage && typeof data.mobileIpUsage === 'object' ? data.mobileIpUsage : {},
      passwordResetTokens:
        data.passwordResetTokens && typeof data.passwordResetTokens === 'object' ? data.passwordResetTokens : {},
      pendingRegistrations:
        data.pendingRegistrations && typeof data.pendingRegistrations === 'object' ? data.pendingRegistrations : {},
    };
  } catch {
    return null;
  }
}

export function createAuthStore(baseDir) {
  const dataDir = resolveDataDir(baseDir);
  const dbPath = path.join(dataDir, 'auth-store.db');
  const legacyJsonPath = path.join(dataDir, 'auth-store.json');
  const db = getDb(baseDir); // shared connection to the single app database
  db.exec(SCHEMA);

  // ---- prepared statements -------------------------------------------------
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByGoogleSub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
    userByStripeSub: db.prepare('SELECT * FROM users WHERE stripe_subscription_id = ?'),
    userByStripeCust: db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
    allUsers: db.prepare('SELECT * FROM users'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    upsertUser: db.prepare(`
      INSERT INTO users
        (id, email, password_salt, password_hash, google_sub, plan, usage_day, usage_count,
         created_at, stripe_customer_id, stripe_subscription_id, pro_pass_granted_at, extra_json)
      VALUES
        (@id, @email, @password_salt, @password_hash, @google_sub, @plan, @usage_day, @usage_count,
         @created_at, @stripe_customer_id, @stripe_subscription_id, @pro_pass_granted_at, @extra_json)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, password_salt=excluded.password_salt, password_hash=excluded.password_hash,
        google_sub=excluded.google_sub, plan=excluded.plan, usage_day=excluded.usage_day,
        usage_count=excluded.usage_count, created_at=excluded.created_at,
        stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
        pro_pass_granted_at=excluded.pro_pass_granted_at, extra_json=excluded.extra_json
    `),

    getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    insSession: db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, exp) VALUES (?, ?, ?)'),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    delExpiredSessions: db.prepare('DELETE FROM sessions WHERE exp < ?'),

    getMobile: db.prepare('SELECT * FROM mobile_ip_usage WHERE ip = ?'),
    upsertMobile: db.prepare('INSERT OR REPLACE INTO mobile_ip_usage (ip, day, count) VALUES (?, ?, ?)'),
    delStaleMobile: db.prepare('DELETE FROM mobile_ip_usage WHERE day IS NULL OR day <> ?'),

    getReset: db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?'),
    insReset: db.prepare('INSERT OR REPLACE INTO password_reset_tokens (token, user_id, exp) VALUES (?, ?, ?)'),
    delReset: db.prepare('DELETE FROM password_reset_tokens WHERE token = ?'),
    delExpiredResets: db.prepare('DELETE FROM password_reset_tokens WHERE exp < ?'),
    delResetsForUser: db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?'),

    getPending: db.prepare('SELECT * FROM pending_registrations WHERE email = ?'),
    upsertPending: db.prepare(`
      INSERT INTO pending_registrations (email, password_salt, password_hash, code_salt, code_hash, attempts, exp)
      VALUES (@email, @password_salt, @password_hash, @code_salt, @code_hash, @attempts, @exp)
      ON CONFLICT(email) DO UPDATE SET
        password_salt=excluded.password_salt, password_hash=excluded.password_hash,
        code_salt=excluded.code_salt, code_hash=excluded.code_hash,
        attempts=excluded.attempts, exp=excluded.exp
    `),
    delPending: db.prepare('DELETE FROM pending_registrations WHERE email = ?'),
    delExpiredPending: db.prepare('DELETE FROM pending_registrations WHERE exp < ?'),

    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),

    delAllUsers: db.prepare('DELETE FROM users'),
    delAllSessions: db.prepare('DELETE FROM sessions'),
    delAllMobile: db.prepare('DELETE FROM mobile_ip_usage'),
    delAllResets: db.prepare('DELETE FROM password_reset_tokens'),
    delAllPending: db.prepare('DELETE FROM pending_registrations'),
  };

  function saveUser(user) {
    q.upsertUser.run(userToParams(user));
  }
  function findUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return rowToUser(q.userByEmail.get(e));
  }
  function findUserById(id) {
    return rowToUser(q.userById.get(id));
  }
  function newSession(userId) {
    const token = newToken();
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    q.insSession.run(token, userId, exp);
    return token;
  }

  // ---- export / import (JSON-shaped) --------------------------------------
  // exportStore() reconstructs the exact shape the old auth-store.json used, so
  // the admin backup endpoint serves LIVE data and a rollback re-import is 1:1.
  function exportStore() {
    const users = q.allUsers.all().map(rowToUser);
    const sessions = {};
    for (const r of db.prepare('SELECT * FROM sessions').all()) {
      sessions[r.token] = { userId: r.user_id, exp: r.exp };
    }
    const mobileIpUsage = {};
    for (const r of db.prepare('SELECT * FROM mobile_ip_usage').all()) {
      mobileIpUsage[r.ip] = { day: r.day, count: r.count };
    }
    const passwordResetTokens = {};
    for (const r of db.prepare('SELECT * FROM password_reset_tokens').all()) {
      passwordResetTokens[r.token] = { userId: r.user_id, exp: r.exp };
    }
    const pendingRegistrations = {};
    for (const r of db.prepare('SELECT * FROM pending_registrations').all()) {
      pendingRegistrations[r.email] = {
        passwordSalt: r.password_salt,
        passwordHash: r.password_hash,
        codeSalt: r.code_salt,
        codeHash: r.code_hash,
        attempts: r.attempts,
        exp: r.exp,
      };
    }
    return { users, sessions, mobileIpUsage, passwordResetTokens, pendingRegistrations };
  }

  // importStore() REPLACES all state from a JSON-shaped object, transactionally.
  // Used by the one-time legacy migration and by tests. Never partial.
  const importStore = db.transaction((store) => {
    q.delAllUsers.run();
    q.delAllSessions.run();
    q.delAllMobile.run();
    q.delAllResets.run();
    q.delAllPending.run();
    for (const u of store.users || []) {
      if (u && u.id && u.email) saveUser(u);
    }
    for (const [token, s] of Object.entries(store.sessions || {})) {
      if (s && s.userId != null) q.insSession.run(token, s.userId, s.exp ?? 0);
    }
    for (const [ip, e] of Object.entries(store.mobileIpUsage || {})) {
      if (e) q.upsertMobile.run(ip, e.day ?? null, e.count ?? 0);
    }
    for (const [token, e] of Object.entries(store.passwordResetTokens || {})) {
      if (e && e.userId != null) q.insReset.run(token, e.userId, e.exp ?? 0);
    }
    for (const [email, p] of Object.entries(store.pendingRegistrations || {})) {
      if (p) {
        q.upsertPending.run({
          email,
          password_salt: p.passwordSalt ?? null,
          password_hash: p.passwordHash ?? null,
          code_salt: p.codeSalt ?? null,
          code_hash: p.codeHash ?? null,
          attempts: p.attempts ?? 0,
          exp: p.exp ?? 0,
        });
      }
    }
  });

  // ---- one-time migration from legacy auth-store.json ----------------------
  // Runs only if we've never imported AND the DB has no users yet. The meta flag
  // guarantees it never re-runs (so a later restart can't clobber live SQLite
  // data with a now-stale JSON file). The JSON file is only ever read, never
  // written or deleted — it stays put as a rollback fallback.
  function maybeImportLegacyJson() {
    if (q.getMeta.get('imported_from_json')) return;
    if (q.userCount.get().n > 0) {
      q.setMeta.run('imported_from_json', `skipped-nonempty@${Date.now()}`);
      return;
    }
    const legacy = loadLegacyJson(legacyJsonPath);
    const rowCount = legacy
      ? legacy.users.length +
        Object.keys(legacy.sessions).length +
        Object.keys(legacy.mobileIpUsage).length +
        Object.keys(legacy.passwordResetTokens).length +
        Object.keys(legacy.pendingRegistrations).length
      : 0;
    if (legacy && rowCount > 0) {
      importStore(legacy);
      q.setMeta.run(
        'imported_from_json',
        `imported ${legacy.users.length} users@${new Date().toISOString()}`
      );
    } else {
      q.setMeta.run('imported_from_json', `nothing-to-import@${Date.now()}`);
    }
  }
  maybeImportLegacyJson();

  // ---- pruning (mirrors the old whole-store prune helpers) -----------------
  function prunePending() {
    q.delExpiredPending.run(Date.now());
  }
  function pruneResets() {
    q.delExpiredResets.run(Date.now());
  }
  function pruneMobileForToday() {
    q.delStaleMobile.run(utcDayString());
  }

  // -------------------------------------------------------------------------
  // Public API — identical signatures + return shapes to the JSON version.
  // -------------------------------------------------------------------------
  function startRegistration(email, password) {
    const validated = validateRegistrationInput(email, password);
    if (!validated.ok) return validated;
    const e = validated.email;
    prunePending();
    const dup = findUserByEmail(e);
    if (dup) {
      // Anti-enumeration: never tell the caller the email is already taken (that
      // turns sign-up into a yes/no oracle over every customer's email). Signal
      // the route to send an "account already exists" notice to the address
      // instead of a verification code, while the HTTP response stays byte-for-
      // byte identical to a fresh sign-up. The real mailbox owner learns via that
      // email (and is told to sign in / use Google / reset); a prober learns
      // nothing. We intentionally do NOT create a pending here, so the existing
      // account is never disturbed and no code is ever issued for it.
      return { ok: true, alreadyExists: true, toEmail: e };
    }
    const passwordSalt = newSalt();
    const passwordHash = hashPassword(password, passwordSalt);
    const codeSalt = newSalt();
    const code = newRegistrationCode();
    const codeHash = hashVerificationCode(code, codeSalt);
    q.upsertPending.run({
      email: e,
      password_salt: passwordSalt,
      password_hash: passwordHash,
      code_salt: codeSalt,
      code_hash: codeHash,
      attempts: 0,
      exp: Date.now() + REGISTRATION_CODE_EXPIRY_MS,
    });
    return { ok: true, code, toEmail: e };
  }

  function resendRegistrationCode(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Invalid email address' };
    }
    prunePending();
    const pending = q.getPending.get(e);
    if (!pending) {
      return {
        ok: false,
        error: 'No pending sign-up for this email. Start registration again.',
      };
    }
    const codeSalt = newSalt();
    const code = newRegistrationCode();
    q.upsertPending.run({
      email: e,
      password_salt: pending.password_salt,
      password_hash: pending.password_hash,
      code_salt: codeSalt,
      code_hash: hashVerificationCode(code, codeSalt),
      attempts: 0,
      exp: Date.now() + REGISTRATION_CODE_EXPIRY_MS,
    });
    return { ok: true, code, toEmail: e };
  }

  function completeRegistration(email, code) {
    const e = String(email || '').trim().toLowerCase();
    const rawCode = String(code || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Invalid email address' };
    }
    if (!/^\d{6}$/.test(rawCode)) {
      return { ok: false, error: 'Enter the 6-digit verification code from your email.' };
    }
    prunePending();
    const pending = q.getPending.get(e);
    if (!pending) {
      return {
        ok: false,
        error: 'Verification code expired or not found. Start registration again.',
      };
    }
    if (pending.attempts >= MAX_REGISTRATION_VERIFY_ATTEMPTS) {
      q.delPending.run(e);
      return { ok: false, error: 'Too many incorrect attempts. Start registration again.' };
    }
    const tryHash = hashVerificationCode(rawCode, pending.code_salt);
    const a = Buffer.from(tryHash, 'hex');
    const b = Buffer.from(pending.code_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const attempts = pending.attempts + 1;
      const remaining = MAX_REGISTRATION_VERIFY_ATTEMPTS - attempts;
      if (remaining <= 0) {
        q.delPending.run(e);
        return { ok: false, error: 'Too many incorrect attempts. Start registration again.' };
      }
      q.upsertPending.run({
        email: e,
        password_salt: pending.password_salt,
        password_hash: pending.password_hash,
        code_salt: pending.code_salt,
        code_hash: pending.code_hash,
        attempts,
        exp: pending.exp,
      });
      return {
        ok: false,
        error: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      };
    }
    if (findUserByEmail(e)) {
      q.delPending.run(e);
      return { ok: false, error: 'An account with this email already exists' };
    }
    const user = {
      id: `u_${crypto.randomBytes(12).toString('hex')}`,
      email: e,
      passwordSalt: pending.password_salt,
      passwordHash: pending.password_hash,
      plan: 'free',
      usageDay: null,
      usageCount: 0,
      createdAt: new Date().toISOString(),
    };
    const token = newToken();
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    db.transaction(() => {
      saveUser(user);
      q.delPending.run(e);
      q.insSession.run(token, user.id, exp);
    })();
    return { ok: true, token, user: publicUser(user) };
  }

  function login(email, password) {
    const user = findUserByEmail(email);
    if (!user) {
      return { ok: false, error: 'Invalid email or password' };
    }
    if (!user.passwordHash || !user.passwordSalt) {
      // A Google-only account (no local password). Return the SAME generic error
      // as "no such user" / "wrong password" so password login can't be used to
      // enumerate which emails exist — or which are Google-linked. Users who
      // signed up with Google are guided by the always-visible "Continue with
      // Google" button rather than by a per-account response.
      return { ok: false, error: 'Invalid email or password' };
    }
    const tryHash = hashPassword(password, user.passwordSalt);
    const a = Buffer.from(tryHash, 'hex');
    const b = Buffer.from(user.passwordHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'Invalid email or password' };
    }
    const token = newSession(user.id);
    return { ok: true, token, user: publicUser(user) };
  }

  function loginWithGoogle({ email, googleSub }) {
    const e = String(email || '').trim().toLowerCase();
    const sub = String(googleSub || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Invalid email address' };
    }
    if (!sub) {
      return { ok: false, error: 'Invalid Google account' };
    }
    let user = rowToUser(q.userByGoogleSub.get(sub));
    if (user) {
      const token = newSession(user.id);
      return { ok: true, token, user: publicUser(user) };
    }
    user = findUserByEmail(e);
    if (user) {
      if (user.googleSub && user.googleSub !== sub) {
        return { ok: false, error: 'This email is linked to a different Google account.' };
      }
      if (!user.googleSub) {
        user.googleSub = sub;
        saveUser(user);
      }
      const token = newSession(user.id);
      return { ok: true, token, user: publicUser(user) };
    }
    const newUser = {
      id: `u_${crypto.randomBytes(12).toString('hex')}`,
      email: e,
      googleSub: sub,
      plan: 'free',
      usageDay: null,
      usageCount: 0,
      createdAt: new Date().toISOString(),
    };
    const token = newToken();
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    db.transaction(() => {
      saveUser(newUser);
      q.insSession.run(token, newUser.id, exp);
    })();
    return { ok: true, token, user: publicUser(newUser) };
  }

  function publicUser(user) {
    const day = utcDayString();
    let used = 0;
    if (user.plan === 'free') {
      used = user.usageDay === day ? user.usageCount : 0;
    }
    return {
      id: user.id,
      email: user.email,
      plan: user.plan,
      dailyGenerationsUsed: used,
      dailyGenerationLimit: user.plan === 'pro' ? null : FREE_DAILY_LIMIT,
      canManageSubscription: user.plan === 'pro' && !!user.stripeCustomerId,
    };
  }

  function validateSession(token) {
    if (!token || typeof token !== 'string') return null;
    const s = q.getSession.get(token);
    if (!s || s.exp < Date.now()) {
      if (s) q.delSession.run(token);
      return null;
    }
    const user = findUserById(s.user_id);
    if (!user) {
      q.delSession.run(token);
      return null;
    }
    return user;
  }

  function logout(token) {
    q.delSession.run(token);
  }

  // Read-only view of a free user's daily usage vs. cap, used to enforce the limit
  // BEFORE spending on generation. Pro users are uncapped (allowed:true, limit:null).
  // This is a pre-check, not atomic with recordFreeGeneration; the per-IP generation
  // rate limiter bounds any concurrent-request slippage, acceptable for a cost backstop.
  function freeGenerationStatus(userId) {
    const user = findUserById(userId);
    if (!user || user.plan !== 'free') {
      return { allowed: true, used: 0, limit: null };
    }
    const day = utcDayString();
    const used = user.usageDay === day ? user.usageCount : 0;
    return { allowed: used < FREE_DAILY_LIMIT, used, limit: FREE_DAILY_LIMIT };
  }

  function recordFreeGeneration(userId) {
    const user = findUserById(userId);
    if (!user) return null;
    if (user.plan !== 'free') return publicUser(user);
    const day = utcDayString();
    if (user.usageDay !== day) {
      user.usageDay = day;
      user.usageCount = 0;
    }
    user.usageCount += 1;
    saveUser(user);
    return publicUser(user);
  }

  function recordMobileIpGeneration(ip) {
    const rawIp = String(ip || 'unknown').slice(0, 128);
    pruneMobileForToday();
    const day = utcDayString();
    const entry = q.getMobile.get(rawIp);
    const count = (entry && entry.day === day ? entry.count : 0) + 1;
    q.upsertMobile.run(rawIp, day, count);
    return { used: count, limit: FREE_DAILY_LIMIT };
  }

  function pruneSessions() {
    q.delExpiredSessions.run(Date.now());
  }

  function startPasswordReset(email) {
    pruneResets();
    const e = String(email || '').trim().toLowerCase();
    const user = e ? findUserByEmail(e) : null;
    if (!user) {
      return { ok: true };
    }
    const token = newToken();
    q.insReset.run(token, user.id, Date.now() + 60 * 60 * 1000);
    return { ok: true, token, toEmail: user.email };
  }

  function completePasswordReset(token, newPassword) {
    if (!token || typeof token !== 'string') {
      return { ok: false, error: 'Invalid or expired reset link. Request a new one.' };
    }
    if (String(newPassword || '').length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters' };
    }
    pruneResets();
    const entry = q.getReset.get(token);
    if (!entry || typeof entry.exp !== 'number' || entry.exp < Date.now()) {
      return { ok: false, error: 'Invalid or expired reset link. Request a new one.' };
    }
    const user = findUserById(entry.user_id);
    if (!user) {
      q.delReset.run(token);
      return { ok: false, error: 'Invalid reset link.' };
    }
    const salt = newSalt();
    user.passwordSalt = salt;
    user.passwordHash = hashPassword(newPassword, salt);
    db.transaction(() => {
      saveUser(user);
      q.delResetsForUser.run(user.id);
    })();
    return { ok: true };
  }

  function activateProFromStripeCheckout({ userId, email, stripeCustomerId, stripeSubscriptionId }) {
    let user = null;
    if (userId && typeof userId === 'string') {
      user = findUserById(userId);
    }
    if (!user && email) {
      user = findUserByEmail(String(email).trim().toLowerCase());
    }
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    user.plan = 'pro';
    if (stripeCustomerId) user.stripeCustomerId = String(stripeCustomerId);
    if (stripeSubscriptionId) user.stripeSubscriptionId = String(stripeSubscriptionId);
    saveUser(user);
    return { ok: true, userId: user.id, email: user.email };
  }

  function applyStripeSubscriptionState(subscription) {
    if (!subscription || typeof subscription !== 'object') {
      return { ok: false, reason: 'bad_payload' };
    }
    const subId = subscription.id;
    const customerRaw = subscription.customer;
    const customerId =
      typeof customerRaw === 'string' ? customerRaw : customerRaw && customerRaw.id ? customerRaw.id : null;
    const status = subscription.status;
    let user = subId ? rowToUser(q.userByStripeSub.get(subId)) : null;
    if (!user && customerId) {
      user = rowToUser(q.userByStripeCust.get(customerId));
    }
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    const proStatuses = ['active', 'trialing', 'past_due'];
    if (proStatuses.includes(status)) {
      user.plan = 'pro';
      user.stripeSubscriptionId = subId;
      if (customerId) user.stripeCustomerId = customerId;
    } else {
      user.plan = 'free';
      if (user.stripeSubscriptionId === subId) {
        user.stripeSubscriptionId = null;
      }
    }
    saveUser(user);
    return { ok: true, userId: user.id, plan: user.plan };
  }

  function grantProWithPass(userId) {
    const user = findUserById(userId);
    if (!user) {
      return { ok: false, error: 'User not found' };
    }
    user.plan = 'pro';
    user.proPassGrantedAt = new Date().toISOString();
    saveUser(user);
    return { ok: true, user: publicUser(user) };
  }

  return {
    startRegistration,
    resendRegistrationCode,
    completeRegistration,
    login,
    loginWithGoogle,
    validateSession,
    logout,
    publicUser,
    freeGenerationStatus,
    recordFreeGeneration,
    recordMobileIpGeneration,
    findUserByEmail,
    pruneSessions,
    activateProFromStripeCheckout,
    grantProWithPass,
    applyStripeSubscriptionState,
    startPasswordReset,
    completePasswordReset,
    FREE_DAILY_LIMIT,
    /** Absolute path to the SQLite database file. */
    getStoreFilePath: () => dbPath,
    getUserCount: () => q.userCount.get().n,
    /** Live snapshot in the legacy JSON shape — for admin backup + rollback. */
    exportStore,
    /** Replace all state from a JSON-shaped object (migration / restore / tests). */
    importStore,
    /** Close the shared DB handle (tests). */
    close: () => closeDb(baseDir),
  };
}
