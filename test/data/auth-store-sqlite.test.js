// SQLite-specific auth-store behavior: on-disk persistence, the one-time legacy
// auth-store.json → SQLite migration (user-data safety), and the exportStore /
// importStore round-trip used for the admin backup and migration. The auth-store's
// functional behavior (register/login/sessions/reset) is covered in auth-store.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { openDb, dbPathFor } from '../../lib/data/db.js';
import { redactUser } from '../../lib/data/auth-redaction.js';

const tempDirs = [];
const openStores = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-authsqlite-'));
  tempDirs.push(d);
  return d;
}
function storeAt(dir) {
  const s = createAuthStore(dir);
  openStores.push(s);
  return s;
}
afterEach(() => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* already closed */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Register + verify a user; returns { ok, token, user }.
function verifyUser(store, email, password = 'CorrectHorse9!') {
  const start = store.startRegistration(email, password);
  return store.completeRegistration(email, start.code);
}

// Drop a legacy auth-store.json where createAuthStore will look for it.
function seedLegacyJson(dir, data) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'auth-store.json'), JSON.stringify(data));
}

const EMPTY = { sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {} };

test('persists users to disk across a close + reopen', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  verifyUser(s1, 'persist@example.com');
  s1.close();

  const s2 = storeAt(dir);
  assert.ok(s2.findUserByEmail('persist@example.com'), 'the user survived a restart');
});

test('imports a legacy auth-store.json on first open, preserving unknown fields', () => {
  const dir = tempDir();
  const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
  seedLegacyJson(dir, {
    users: [{
      id: 'u_legacy', email: 'old@example.com', passwordSalt: 'salt', passwordHash: 'hash',
      plan: 'pro', createdAt: '2024-01-01T00:00:00.000Z', stripeCustomerId: 'cus_1',
      referralSource: 'twitter', // unknown key → must survive via extra_json
    }],
    sessions: { tok_legacy: { userId: 'u_legacy', exp: future } },
    mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {},
  });

  const store = storeAt(dir);
  assert.equal(store.getUserCount(), 1);
  const u = store.findUserByEmail('old@example.com');
  assert.equal(u.plan, 'pro');
  assert.equal(u.stripeCustomerId, 'cus_1');
  assert.equal(u.referralSource, 'twitter', 'unknown legacy field preserved through the migration');
  assert.equal(store.validateSession('tok_legacy')?.id, 'u_legacy', 'the legacy session was imported');
  assert.ok(
    !Object.keys(store.exportStore().sessions).includes('tok_legacy'),
    'and hashed on the way in — the legacy JSON holds raw tokens, the DB must not'
  );
});

test('the legacy import is one-time — a restart never clobbers live SQLite data', () => {
  const dir = tempDir();
  seedLegacyJson(dir, {
    users: [{ id: 'u_legacy', email: 'old@example.com', plan: 'free', createdAt: '2024-01-01T00:00:00.000Z' }],
    ...EMPTY,
  });

  const s1 = storeAt(dir);
  assert.equal(s1.getUserCount(), 1);
  verifyUser(s1, 'new@example.com'); // mutate SQLite after the import
  assert.equal(s1.getUserCount(), 2);
  s1.close();

  // The auth-store.json is still on disk. Reopening must NOT re-import it (a re-import
  // REPLACES all state and would drop the post-migration user).
  const s2 = storeAt(dir);
  assert.equal(s2.getUserCount(), 2, 'the legacy JSON did not re-import over live data');
  assert.ok(s2.findUserByEmail('new@example.com'), 'the post-migration user survived the restart');
});

test('a legacy JSON that appears after the first boot is ignored', () => {
  const dir = tempDir();
  const s1 = storeAt(dir); // fresh DB, no JSON → migration is marked done
  verifyUser(s1, 'live@example.com');
  s1.close();

  // Someone drops a stale JSON next to the DB later.
  seedLegacyJson(dir, {
    users: [{ id: 'u_stale', email: 'stale@example.com', plan: 'pro', createdAt: '2020-01-01T00:00:00.000Z' }],
    ...EMPTY,
  });
  const s2 = storeAt(dir);
  assert.ok(s2.findUserByEmail('live@example.com'), 'live data is intact');
  assert.equal(s2.findUserByEmail('stale@example.com'), null, 'the later-appearing JSON was not imported');
});

test('exportStore / importStore round-trips all state', () => {
  const a = storeAt(tempDir());
  const reg = verifyUser(a, 'rt@example.com');
  const snap = a.exportStore();
  assert.ok(snap.users.some((x) => x.email === 'rt@example.com'));

  const b = storeAt(tempDir());
  b.importStore(snap);
  assert.equal(b.getUserCount(), a.getUserCount());
  assert.equal(b.findUserByEmail('rt@example.com').id, reg.user.id);
  assert.equal(b.validateSession(reg.token)?.email, 'rt@example.com', 'the session round-tripped');
  assert.deepEqual(b.exportStore(), snap, 'the full export is identical after a round-trip');
});

// ---- exportRedacted — what GET /authstore is allowed to serve ---------------
// exportStore() is a backup payload and carries every credential in the system.
// exportRedacted() is the browser-facing view; these tests are the line between
// them. If one starts failing, do not "fix" it by widening the export.

test('exportRedacted omits every credential: hashes, session tokens, reset tokens, pendings', () => {
  const s = storeAt(tempDir());
  const reg = verifyUser(s, 'secret@example.com');
  const reset = s.startPasswordReset('secret@example.com');
  s.startRegistration('pending@example.com', 'CorrectHorse9!'); // leaves a pending row

  const full = s.exportStore();
  const redacted = s.exportRedacted();
  const wire = JSON.stringify(redacted);

  // The full export really does carry the secrets — otherwise this test proves nothing.
  const stored = full.users.find((u) => u.email === 'secret@example.com');
  assert.ok(stored.passwordHash && stored.passwordSalt, 'precondition: exportStore carries credentials');
  assert.ok(Object.keys(full.sessions).length, 'precondition: exportStore carries live sessions');
  assert.ok(reset.token, 'precondition: a reset token exists');

  // None of it survives redaction.
  assert.ok(!wire.includes(stored.passwordHash), 'no password hash on the wire');
  assert.ok(!wire.includes(stored.passwordSalt), 'no password salt on the wire');
  assert.ok(!wire.includes(reg.token), 'no live session token on the wire');
  assert.ok(!wire.includes(reset.token), 'no password-reset token on the wire');
  assert.deepEqual(Object.keys(redacted), ['users'], 'sessions/resets/pendings are dropped wholesale');
  assert.ok(!wire.includes('pending@example.com'), 'unverified signups are not exposed either');

  const user = redacted.users.find((u) => u.email === 'secret@example.com');
  assert.ok(user, 'the account itself is still listed');
  assert.equal(user.passwordHash, undefined);
  assert.equal(user.passwordSalt, undefined);
});

test('exportRedacted keeps the fields the dashboard renders', () => {
  const s = storeAt(tempDir());
  verifyUser(s, 'shown@example.com');
  const [u] = s.exportRedacted().users;
  for (const k of ['id', 'email', 'plan', 'createdAt']) {
    assert.ok(u[k] !== undefined, `${k} is still available to the admin UI`);
  }
});

test('exportRedacted is an allowlist — a new extra_json field does NOT leak by default', () => {
  const s = storeAt(tempDir());
  // extra_json is a catch-all; rowToUser spreads it. A denylist implementation
  // would pass this straight through to the browser.
  s.importStore({
    ...EMPTY,
    users: [{
      id: 'u_x', email: 'x@example.com', plan: 'free', createdAt: '2024-01-01T00:00:00.000Z',
      oauthRefreshToken: 'super-secret-value',
    }],
  });
  const wire = JSON.stringify(s.exportRedacted());
  assert.ok(!wire.includes('super-secret-value'), 'unknown extra_json fields stay server-side');
});

test('importStore replaces all prior state (transactional, not a merge)', () => {
  const s = storeAt(tempDir());
  s.importStore({ ...EMPTY, users: [{ id: 'u_a', email: 'a@x.com', plan: 'free', createdAt: '2024-01-01T00:00:00.000Z' }] });
  assert.ok(s.findUserByEmail('a@x.com'));

  s.importStore({ ...EMPTY, users: [{ id: 'u_b', email: 'b@x.com', plan: 'pro', createdAt: '2024-01-01T00:00:00.000Z' }] });
  assert.equal(s.getUserCount(), 1, 'replace, not merge');
  assert.equal(s.findUserByEmail('a@x.com'), null, 'the prior user was removed');
  assert.equal(s.findUserByEmail('b@x.com').plan, 'pro');
});

// ---- tokens at rest ---------------------------------------------------------
// Session and reset tokens are bearer credentials: a raw one read out of the DB
// file (a stolen /data volume, a Litestream restore, the frozen auth-store.json)
// is an account takeover with no cracking step. Only digests may be stored.

const sha256 = (s) => `sha256$${crypto.createHash('sha256').update(s).digest('hex')}`;

test('session and reset tokens are stored hashed, never in the clear', () => {
  const s = storeAt(tempDir());
  const reg = verifyUser(s, 'atrest@example.com');
  const reset = s.startPasswordReset('atrest@example.com');

  const snap = s.exportStore();
  const sessionKeys = Object.keys(snap.sessions);
  const resetKeys = Object.keys(snap.passwordResetTokens);
  assert.equal(sessionKeys.length, 1, 'precondition: the signup left a live session');
  assert.equal(resetKeys.length, 1, 'precondition: a reset token was issued');

  assert.ok(!sessionKeys.includes(reg.token), 'the raw session token is not a stored key');
  assert.ok(!resetKeys.includes(reset.token), 'the raw reset token is not a stored key');
  assert.equal(sessionKeys[0], sha256(reg.token), 'the session row is keyed by the digest');
  assert.equal(resetKeys[0], sha256(reset.token), 'the reset row is keyed by the digest');

  // Nothing about the surface behavior changes — both tokens still work.
  assert.equal(s.validateSession(reg.token)?.email, 'atrest@example.com');
  assert.equal(s.completePasswordReset(reset.token, 'BrandNewPass9!').ok, true);
  assert.equal(s.login('atrest@example.com', 'BrandNewPass9!').ok, true);
});

test('a forged digest is not a session — only the raw token authenticates', () => {
  const s = storeAt(tempDir());
  const reg = verifyUser(s, 'forge@example.com');
  // Someone who read the DB holds the stored value. Presenting it must fail: the
  // lookup hashes what it is given, so the digest hashes to something else.
  assert.equal(s.validateSession(sha256(reg.token)), null, 'the stored value is not replayable');
  assert.equal(s.validateSession(reg.token)?.email, 'forge@example.com', 'the real token still works');
});

test('logout and expiry still find the row through the hash', () => {
  const s = storeAt(tempDir());
  const reg = verifyUser(s, 'bye@example.com');
  s.logout(reg.token);
  assert.equal(s.validateSession(reg.token), null, 'logout deleted the hashed row');
  assert.equal(Object.keys(s.exportStore().sessions).length, 0, 'no orphan row left behind');
});

test('tokens written before hashing are migrated on open, without signing anyone out', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  const reg = verifyUser(s1, 'preexisting@example.com');
  const reset = s1.startPasswordReset('preexisting@example.com');
  s1.close();

  // Rewrite both rows the way the pre-hashing code stored them: raw token as the
  // primary key. This is what a live production DB looks like at deploy time.
  const raw = openDb(dbPathFor(dir));
  raw.prepare('UPDATE sessions SET token = ?').run(reg.token);
  raw.prepare('UPDATE password_reset_tokens SET token = ?').run(reset.token);
  raw.close();

  const s2 = storeAt(dir); // opening runs the migration
  const snap = s2.exportStore();
  assert.equal(Object.keys(snap.sessions)[0], sha256(reg.token), 'the session row was hashed in place');
  assert.equal(Object.keys(snap.passwordResetTokens)[0], sha256(reset.token), 'the reset row too');
  assert.equal(
    s2.validateSession(reg.token)?.email,
    'preexisting@example.com',
    'the cookie the user already holds still works — nobody is signed out by the migration'
  );
  assert.equal(s2.completePasswordReset(reset.token, 'AnotherPass9!').ok, true, 'an in-flight reset link still works');
});

test('the migration is idempotent — reopening does not double-hash', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  const reg = verifyUser(s1, 'twice@example.com');
  const first = s1.exportStore().sessions;
  s1.close();

  const s2 = storeAt(dir); // migration runs again over already-hashed rows
  assert.deepEqual(s2.exportStore().sessions, first, 'already-hashed rows were left alone');
  assert.equal(s2.validateSession(reg.token)?.email, 'twice@example.com', 'the session survived a second open');
});

// ── indexes on the non-token lookups (session-tokens.js) ─────────────────────
//
// `sessions` and `password_reset_tokens` are keyed by token, so the PRIMARY KEY
// covers every lookup that has one. The two that don't — by `user_id` (sign out
// everywhere, on every password reset) and by `exp` (the pruners) — need their own
// indexes or they read the whole table.

/** The named (non-auto) indexes on a table, sorted. */
const namedIndexes = (db, table) =>
  db.prepare(`PRAGMA index_list(${table})`).all()
    .map((r) => r.name)
    .filter((n) => n.startsWith('idx_'))
    .sort();

test('the non-token session/reset lookups are indexed rather than full scans', () => {
  const dir = tempDir();
  storeAt(dir);
  const raw = openDb(dbPathFor(dir));
  // Assert the PLAN, not the schema: an index the planner declines to use is no
  // index at all, and "SCAN" vs "SEARCH … USING INDEX" is exactly that difference.
  const planFor = (sql, arg) =>
    raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(arg).map((r) => r.detail).join(' | ');

  for (const [sql, arg] of [
    ['DELETE FROM sessions WHERE user_id = ?', 'u_1'],
    ['DELETE FROM sessions WHERE exp < ?', 1],
    ['DELETE FROM password_reset_tokens WHERE user_id = ?', 'u_1'],
    ['DELETE FROM password_reset_tokens WHERE exp < ?', 1],
  ]) {
    const detail = planFor(sql, arg);
    assert.match(detail, /USING (COVERING )?INDEX idx_/, `${sql} → ${detail}`);
    assert.doesNotMatch(detail, /\bSCAN\b/, `${sql} must not read the whole table → ${detail}`);
  }
  raw.close();
});

test('an existing database gains the indexes on the next open, without touching rows', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  const reg = verifyUser(s1, 'indexed@example.com');
  s1.close();

  // Emulate a database written before these indexes existed — which is every
  // deployed copy. The claim under test is that opening IS the whole migration.
  const before = openDb(dbPathFor(dir));
  for (const name of ['idx_sessions_user', 'idx_sessions_exp', 'idx_resets_user', 'idx_resets_exp']) {
    before.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  assert.deepEqual(namedIndexes(before, 'sessions'), [], 'starting from the pre-index schema');
  before.close();

  const s2 = storeAt(dir);
  const after = openDb(dbPathFor(dir));
  assert.deepEqual(namedIndexes(after, 'sessions'), ['idx_sessions_exp', 'idx_sessions_user']);
  assert.deepEqual(namedIndexes(after, 'password_reset_tokens'), ['idx_resets_exp', 'idx_resets_user']);
  after.close();
  assert.equal(
    s2.validateSession(reg.token)?.email,
    'indexed@example.com',
    'building an index signs nobody out',
  );
});

// users(email) has NO named index, on purpose. `email TEXT UNIQUE NOT NULL` already
// builds one (sqlite_autoindex_users_2), and the planner picks THAT for
// `WHERE email = ?` whether or not a second exists — so the old idx_users_email was
// never read from and only cost another B-tree write on every insert and every
// whole-row upsert. These two tests pin both halves: the lookup is still indexed,
// and the redundant index does not come back.
test('an email lookup is still index-driven with no named index on the column', () => {
  const dir = tempDir();
  storeAt(dir);
  const raw = openDb(dbPathFor(dir));

  const detail = raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE email = ?')
    .all('a@b.com').map((r) => r.detail).join(' | ');
  assert.match(detail, /USING (COVERING )?INDEX/, `email lookup must use an index → ${detail}`);
  assert.doesNotMatch(detail, /\bSCAN\b/, `email lookup must not scan the table → ${detail}`);
  // Specifically the UNIQUE constraint's own index, which is the whole argument.
  assert.match(detail, /sqlite_autoindex_users/, `expected the UNIQUE autoindex → ${detail}`);

  raw.close();
});

test('the redundant users(email) index is gone, and stays gone on an existing database', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  s1.close();

  // Emulate a database created before the drop: re-add the index by hand, then
  // reopen. CREATE INDEX IF NOT EXISTS would have left it in place forever, which is
  // why the schema carries an explicit idempotent DROP.
  const raw = openDb(dbPathFor(dir));
  raw.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  assert.ok(namedIndexes(raw, 'users').includes('idx_users_email'), 'precondition: the old index exists');
  raw.close();

  const s2 = storeAt(dir);
  s2.close();
  const reopened = openDb(dbPathFor(dir));
  assert.ok(
    !namedIndexes(reopened, 'users').includes('idx_users_email'),
    'reopening must drop the redundant index, not preserve it',
  );
  // The other three are load-bearing and must survive that DROP.
  const remaining = namedIndexes(reopened, 'users');
  for (const keep of ['idx_users_google_sub', 'idx_users_stripe_cust', 'idx_users_stripe_sub']) {
    assert.ok(remaining.includes(keep), `${keep} must survive → ${remaining.join(', ')}`);
  }
  reopened.close();
});

// ---- Trial state on the wire ------------------------------------------------
// `plan` collapses trialing / active / past_due into 'pro', so without these
// fields the dashboard could not tell a trial from a subscription, count the
// trials that were running, or say whether a trial user had used the product at
// all — the very question the lifecycle emails branch on. Widening an allowlist
// is exactly the change that leaks something, so the shape is pinned.

test('exportRedacted carries trial state, projected to a fixed shape', () => {
  const s = storeAt(tempDir());
  verifyUser(s, 'trial@example.com');
  const user = s.findUserByEmail('trial@example.com');
  s.beginTrial(user.id, '2026-07-25T00:00:00.000Z');
  s.markTrialEmailSent(user.id, 'welcome');
  s.recordStagingActivity(user.id);

  const row = s.exportRedacted().users.find((u) => u.email === 'trial@example.com');

  assert.equal(row.trialLifecycle.startAt, '2026-07-25T00:00:00.000Z');
  assert.deepEqual(
    Object.keys(row.trialLifecycle.sent).sort(),
    ['activation', 'canceled', 'ending', 'value', 'welcome'],
    'every lifecycle mail has a slot, so a never-sent one reads as null rather than being absent',
  );
  assert.ok(row.trialLifecycle.sent.welcome, 'the welcome send is timestamped');
  assert.equal(row.trialLifecycle.sent.ending, null, 'a mail that never went out is null, not missing');
  assert.equal(row.lifetimeStaged, 1);
  assert.ok(row.lastStagedAt, 'the activity timestamp the sweep reads is visible to the operator');
});

test('the trial bag is PROJECTED, so nothing else parked in it can ship', () => {
  // The bag lives in extra_json, which rowToUser spreads wholesale. Listing
  // `trialLifecycle` in the key allowlist would therefore auto-export any field a
  // future feature adds to it — the exact failure that allowlist exists to prevent.
  // Driven through the pure projector: the store has no public writer for an
  // arbitrary extra_json field, and this is the function that decides the shape.
  const safe = redactUser({
    id: 'u_1',
    email: 'bag@example.com',
    plan: 'pro',
    passwordHash: 'HASH_SHOULD_NEVER_SHIP',
    trialLifecycle: {
      startAt: '2026-07-25T00:00:00.000Z',
      secretToken: 'tok_should_never_ship',
      sent: { welcome: '2026-07-25T01:00:00.000Z', somethingNew: '2026-07-26T00:00:00.000Z' },
    },
  });

  const wire = JSON.stringify(safe);
  assert.ok(!wire.includes('tok_should_never_ship'), 'an unknown field in the bag stays server-side');
  assert.ok(!wire.includes('somethingNew'), 'an unknown sent-flag is not forwarded either');
  assert.ok(!wire.includes('HASH_SHOULD_NEVER_SHIP'), 'and the credential rule still holds');
  assert.equal(safe.trialLifecycle.startAt, '2026-07-25T00:00:00.000Z');
  assert.equal(safe.trialLifecycle.sent.welcome, '2026-07-25T01:00:00.000Z');
});

test('a malformed trial bag degrades to absent rather than throwing', () => {
  // extra_json is hand-editable and predates this shape.
  assert.equal('trialLifecycle' in redactUser({ id: 'a', trialLifecycle: 'nonsense' }), false);
  assert.equal('trialLifecycle' in redactUser({ id: 'a', trialLifecycle: null }), false);
  const noSent = redactUser({ id: 'a', trialLifecycle: { startAt: null } });
  assert.equal(noSent.trialLifecycle.startAt, null);
  assert.equal(noSent.trialLifecycle.sent.welcome, null, 'a bag with no sent map still reports every slot');
});

test('exportRedacted omits trialLifecycle entirely for an account that never trialed', () => {
  const s = storeAt(tempDir());
  verifyUser(s, 'free@example.com');
  const row = s.exportRedacted().users.find((u) => u.email === 'free@example.com');
  assert.equal('trialLifecycle' in row, false, 'absent stays absent, rather than becoming an empty shell');
});
