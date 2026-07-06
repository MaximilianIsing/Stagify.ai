import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Free plan is unlimited (ad-supported). Set high so existing limit checks never fire.
const FREE_DAILY_LIMIT = 99999;
const SESSION_DAYS = 30;
const REGISTRATION_CODE_EXPIRY_MS = 15 * 60 * 1000;
const MAX_REGISTRATION_VERIFY_ATTEMPTS = 5;

function getStorePath(baseDir) {
  const logDir =
    process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(baseDir, 'data');
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      return path.join(baseDir, 'auth-store.json');
    }
  }
  return path.join(logDir, 'auth-store.json');
}

function loadStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { users: [], sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {} };
    }
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { users: [], sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {} };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = [];
    if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {};
    if (!data.mobileIpUsage || typeof data.mobileIpUsage !== 'object') data.mobileIpUsage = {};
    if (!data.passwordResetTokens || typeof data.passwordResetTokens !== 'object') {
      data.passwordResetTokens = {};
    }
    if (!data.pendingRegistrations || typeof data.pendingRegistrations !== 'object') {
      data.pendingRegistrations = {};
    }
    return data;
  } catch {
    return { users: [], sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {} };
  }
}

function saveStore(filePath, store) {
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}

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

export function createAuthStore(baseDir) {
  const filePath = getStorePath(baseDir);

  function read() {
    return loadStore(filePath);
  }

  function write(store) {
    saveStore(filePath, store);
  }

  function findUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    const store = read();
    return store.users.find((u) => u.email === e) || null;
  }

  function findUserById(id) {
    const store = read();
    return store.users.find((u) => u.id === id) || null;
  }

  function prunePendingRegistrations(store) {
    if (!store.pendingRegistrations) store.pendingRegistrations = {};
    const now = Date.now();
    for (const k of Object.keys(store.pendingRegistrations)) {
      const entry = store.pendingRegistrations[k];
      if (!entry || typeof entry.exp !== 'number' || entry.exp < now) {
        delete store.pendingRegistrations[k];
      }
    }
  }

  /** Stage email/password sign-up and return a one-time verification code to email. */
  function startRegistration(email, password) {
    const validated = validateRegistrationInput(email, password);
    if (!validated.ok) return validated;
    const e = validated.email;
    const store = read();
    prunePendingRegistrations(store);
    const dup = store.users.find((u) => u.email === e);
    if (dup) {
      if (dup.googleSub && !dup.passwordHash) {
        return {
          ok: false,
          error: 'An account with this email already exists. Sign in with Google.',
        };
      }
      return { ok: false, error: 'An account with this email already exists' };
    }
    const passwordSalt = newSalt();
    const passwordHash = hashPassword(password, passwordSalt);
    const codeSalt = newSalt();
    const code = newRegistrationCode();
    const codeHash = hashVerificationCode(code, codeSalt);
    store.pendingRegistrations[e] = {
      passwordSalt,
      passwordHash,
      codeSalt,
      codeHash,
      attempts: 0,
      exp: Date.now() + REGISTRATION_CODE_EXPIRY_MS,
    };
    write(store);
    return { ok: true, code, toEmail: e };
  }

  /** Resend a verification code for a pending registration. */
  function resendRegistrationCode(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Invalid email address' };
    }
    const store = read();
    prunePendingRegistrations(store);
    const pending = store.pendingRegistrations[e];
    if (!pending) {
      return {
        ok: false,
        error: 'No pending sign-up for this email. Start registration again.',
      };
    }
    const codeSalt = newSalt();
    const code = newRegistrationCode();
    pending.codeSalt = codeSalt;
    pending.codeHash = hashVerificationCode(code, codeSalt);
    pending.attempts = 0;
    pending.exp = Date.now() + REGISTRATION_CODE_EXPIRY_MS;
    write(store);
    return { ok: true, code, toEmail: e };
  }

  /** Verify email code and create the account. */
  function completeRegistration(email, code) {
    const e = String(email || '').trim().toLowerCase();
    const rawCode = String(code || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Invalid email address' };
    }
    if (!/^\d{6}$/.test(rawCode)) {
      return { ok: false, error: 'Enter the 6-digit verification code from your email.' };
    }
    const store = read();
    prunePendingRegistrations(store);
    const pending = store.pendingRegistrations[e];
    if (!pending) {
      return {
        ok: false,
        error: 'Verification code expired or not found. Start registration again.',
      };
    }
    if (pending.attempts >= MAX_REGISTRATION_VERIFY_ATTEMPTS) {
      delete store.pendingRegistrations[e];
      write(store);
      return {
        ok: false,
        error: 'Too many incorrect attempts. Start registration again.',
      };
    }
    const tryHash = hashVerificationCode(rawCode, pending.codeSalt);
    const a = Buffer.from(tryHash, 'hex');
    const b = Buffer.from(pending.codeHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      pending.attempts += 1;
      write(store);
      const remaining = MAX_REGISTRATION_VERIFY_ATTEMPTS - pending.attempts;
      if (remaining <= 0) {
        delete store.pendingRegistrations[e];
        write(store);
        return {
          ok: false,
          error: 'Too many incorrect attempts. Start registration again.',
        };
      }
      return {
        ok: false,
        error: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      };
    }
    if (store.users.find((u) => u.email === e)) {
      delete store.pendingRegistrations[e];
      write(store);
      return { ok: false, error: 'An account with this email already exists' };
    }
    const user = {
      id: `u_${crypto.randomBytes(12).toString('hex')}`,
      email: e,
      passwordSalt: pending.passwordSalt,
      passwordHash: pending.passwordHash,
      plan: 'free',
      usageDay: null,
      usageCount: 0,
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    delete store.pendingRegistrations[e];
    const token = newToken();
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    store.sessions[token] = { userId: user.id, exp };
    write(store);
    return { ok: true, token, user: publicUser(user) };
  }

  function login(email, password) {
    const user = findUserByEmail(email);
    if (!user) {
      return { ok: false, error: 'Invalid email or password' };
    }
    if (!user.passwordHash || !user.passwordSalt) {
      return {
        ok: false,
        error: 'This account uses Google sign-in. Use Continue with Google.',
      };
    }
    const tryHash = hashPassword(password, user.passwordSalt);
    const a = Buffer.from(tryHash, 'hex');
    const b = Buffer.from(user.passwordHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'Invalid email or password' };
    }
    const store = read();
    const token = newToken();
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    store.sessions[token] = { userId: user.id, exp };
    write(store);
    return { ok: true, token, user: publicUser(user) };
  }

  /** Create session after Google ID token verified server-side (email + sub from Google). */
  function loginWithGoogle({ email, googleSub }) {
    const e = String(email || '').trim().toLowerCase();
    const sub = String(googleSub || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Invalid email address' };
    }
    if (!sub) {
      return { ok: false, error: 'Invalid Google account' };
    }
    const store = read();
    let user = store.users.find((u) => u.googleSub === sub);
    if (user) {
      const token = newToken();
      const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      store.sessions[token] = { userId: user.id, exp };
      write(store);
      return { ok: true, token, user: publicUser(user) };
    }
    user = store.users.find((u) => u.email === e);
    if (user) {
      if (user.googleSub && user.googleSub !== sub) {
        return { ok: false, error: 'This email is linked to a different Google account.' };
      }
      if (!user.googleSub) {
        user.googleSub = sub;
      }
      const token = newToken();
      const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      store.sessions[token] = { userId: user.id, exp };
      write(store);
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
    store.users.push(newUser);
    const token = newToken();
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    store.sessions[token] = { userId: newUser.id, exp };
    write(store);
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
    const store = read();
    const s = store.sessions[token];
    if (!s || s.exp < Date.now()) {
      if (s) {
        delete store.sessions[token];
        write(store);
      }
      return null;
    }
    const user = findUserById(s.userId);
    if (!user) {
      delete store.sessions[token];
      write(store);
      return null;
    }
    return user;
  }

  function logout(token) {
    const store = read();
    if (store.sessions[token]) {
      delete store.sessions[token];
      write(store);
    }
  }

  /** After successful free-tier staging, bump usage */
  function recordFreeGeneration(userId) {
    const store = read();
    const user = store.users.find((u) => u.id === userId);
    if (!user) return null;
    if (user.plan !== 'free') return publicUser(user);
    const day = utcDayString();
    if (user.usageDay !== day) {
      user.usageDay = day;
      user.usageCount = 0;
    }
    user.usageCount += 1;
    write(store);
    return publicUser(user);
  }

  function canFreeUserGenerate(user) {
    if (!user || user.plan !== 'free') return { ok: true };
    const day = utcDayString();
    const count = user.usageDay === day ? user.usageCount : 0;
    if (count >= FREE_DAILY_LIMIT) {
      return { ok: false, used: count, limit: FREE_DAILY_LIMIT };
    }
    return { ok: true, used: count, limit: FREE_DAILY_LIMIT };
  }

  function pruneMobileIpUsage(store) {
    const day = utcDayString();
    if (!store.mobileIpUsage) store.mobileIpUsage = {};
    for (const k of Object.keys(store.mobileIpUsage)) {
      const e = store.mobileIpUsage[k];
      if (!e || e.day !== day) {
        delete store.mobileIpUsage[k];
      }
    }
  }

  /** Anonymous mobile clients (no session): same daily cap as free accounts, keyed by IP (UTC day). */
  function canMobileIpGenerate(ip) {
    const rawIp = String(ip || 'unknown').slice(0, 128);
    const store = read();
    pruneMobileIpUsage(store);
    const day = utcDayString();
    const entry = store.mobileIpUsage[rawIp];
    const count = entry && entry.day === day ? entry.count : 0;
    if (count >= FREE_DAILY_LIMIT) {
      return { ok: false, used: count, limit: FREE_DAILY_LIMIT };
    }
    return { ok: true, used: count, limit: FREE_DAILY_LIMIT };
  }

  function recordMobileIpGeneration(ip) {
    const rawIp = String(ip || 'unknown').slice(0, 128);
    const store = read();
    pruneMobileIpUsage(store);
    const day = utcDayString();
    let entry = store.mobileIpUsage[rawIp];
    if (!entry || entry.day !== day) {
      entry = { day, count: 0 };
    }
    entry.count += 1;
    store.mobileIpUsage[rawIp] = entry;
    write(store);
    return { used: entry.count, limit: FREE_DAILY_LIMIT };
  }

  function pruneSessions() {
    const store = read();
    const now = Date.now();
    let changed = false;
    for (const [t, s] of Object.entries(store.sessions)) {
      if (s.exp < now) {
        delete store.sessions[t];
        changed = true;
      }
    }
    if (changed) write(store);
  }

  function prunePasswordResetTokens(store) {
    if (!store.passwordResetTokens) store.passwordResetTokens = {};
    const now = Date.now();
    for (const k of Object.keys(store.passwordResetTokens)) {
      const e = store.passwordResetTokens[k];
      if (!e || typeof e.exp !== 'number' || e.exp < now) {
        delete store.passwordResetTokens[k];
      }
    }
  }

  /** Create a one-hour reset token if the user exists. */
  function startPasswordReset(email) {
    const store = read();
    prunePasswordResetTokens(store);
    const e = String(email || '').trim().toLowerCase();
    const user = e ? store.users.find((u) => u.email === e) : null;
    if (!user) {
      return { ok: true };
    }
    const token = newToken();
    store.passwordResetTokens[token] = { userId: user.id, exp: Date.now() + 60 * 60 * 1000 };
    write(store);
    return { ok: true, token, toEmail: user.email };
  }

  function completePasswordReset(token, newPassword) {
    if (!token || typeof token !== 'string') {
      return { ok: false, error: 'Invalid or expired reset link. Request a new one.' };
    }
    if (String(newPassword || '').length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters' };
    }
    const store = read();
    prunePasswordResetTokens(store);
    const entry = store.passwordResetTokens[token];
    if (!entry || typeof entry.exp !== 'number' || entry.exp < Date.now()) {
      return { ok: false, error: 'Invalid or expired reset link. Request a new one.' };
    }
    const user = store.users.find((u) => u.id === entry.userId);
    if (!user) {
      delete store.passwordResetTokens[token];
      write(store);
      return { ok: false, error: 'Invalid reset link.' };
    }
    const salt = newSalt();
    user.passwordSalt = salt;
    user.passwordHash = hashPassword(newPassword, salt);
    for (const t of Object.keys(store.passwordResetTokens)) {
      if (store.passwordResetTokens[t].userId === user.id) {
        delete store.passwordResetTokens[t];
      }
    }
    write(store);
    return { ok: true };
  }

  /**
   * After Stripe Checkout completes (subscription). Match client_reference_id to user id,
   * or fall back to customer email matching a Stagify account.
   */
  function activateProFromStripeCheckout({ userId, email, stripeCustomerId, stripeSubscriptionId }) {
    const store = read();
    let user = null;
    if (userId && typeof userId === 'string') {
      user = store.users.find((u) => u.id === userId) || null;
    }
    if (!user && email) {
      const e = String(email).trim().toLowerCase();
      user = store.users.find((u) => u.email === e) || null;
    }
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    user.plan = 'pro';
    if (stripeCustomerId) user.stripeCustomerId = String(stripeCustomerId);
    if (stripeSubscriptionId) user.stripeSubscriptionId = String(stripeSubscriptionId);
    write(store);
    return { ok: true, userId: user.id, email: user.email };
  }

  /** Keep plan in sync with Stripe subscription status (renewals, cancel, failed payment). */
  function applyStripeSubscriptionState(subscription) {
    if (!subscription || typeof subscription !== 'object') {
      return { ok: false, reason: 'bad_payload' };
    }
    const subId = subscription.id;
    const customerRaw = subscription.customer;
    const customerId =
      typeof customerRaw === 'string' ? customerRaw : customerRaw && customerRaw.id ? customerRaw.id : null;
    const status = subscription.status;
    const store = read();
    let user = store.users.find((u) => u.stripeSubscriptionId === subId);
    if (!user && customerId) {
      user = store.users.find((u) => u.stripeCustomerId === customerId);
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
    write(store);
    return { ok: true, userId: user.id, plan: user.plan };
  }

  /** One-off pro grant via secret URL (see /getpro + endpointkey.txt). Does not set Stripe ids. */
  function grantProWithPass(userId) {
    const store = read();
    const user = store.users.find((u) => u.id === userId);
    if (!user) {
      return { ok: false, error: 'User not found' };
    }
    user.plan = 'pro';
    user.proPassGrantedAt = new Date().toISOString();
    write(store);
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
    recordFreeGeneration,
    canFreeUserGenerate,
    canMobileIpGenerate,
    recordMobileIpGeneration,
    findUserByEmail,
    pruneSessions,
    activateProFromStripeCheckout,
    grantProWithPass,
    applyStripeSubscriptionState,
    startPasswordReset,
    completePasswordReset,
    FREE_DAILY_LIMIT,
    /** Absolute path to persisted JSON (for admin download endpoint). */
    getStoreFilePath: () => filePath,
    getUserCount: () => read().users.length,
  };
}
