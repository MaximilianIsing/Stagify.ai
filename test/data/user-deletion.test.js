// GDPR erasure across the whole data layer.
//
// WHAT THIS COVERS
// This database has NO foreign keys (deliberately — see lib/data/db.js), so nothing
// cascades: every table keyed to a user has to be named in USER_ID_TABLES or its rows
// outlive the account. The orphans that matters most are `sessions` — a live bearer
// token for an account that no longer exists — and `memories`, which is chat content
// keyed to an id nothing can resolve back to a person to honour a second request.
//
// SQLite is only half of it. The data directory also holds the CSV logs and the
// frozen legacy JSON stores each table was imported from — auth-store.json still has
// the address, the scrypt hash and every session digest, memories.json still has the
// chat content, email_opened.json is keyed by the address itself. Those files are
// never written again, which is exactly why they are easy to forget.
//
// The drift guards at the bottom are what keep this working: one introspects the REAL
// schema, the other discovers every path the app resolves inside the data dir. The
// second one replaced a guard that grepped for /'([a-z_]+\.csv)'/ — a shape that could
// only ever find .csv files, so it structurally could not notice that the JSON stores
// were uncovered, and it passed green the whole time they were.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createMemory } from '../../lib/data/memory.js';
import { createApiKeys } from '../../lib/data/api-keys.js';
import { createApiBilling } from '../../lib/data/api-billing.js';
import { getDb, closeDb } from '../../lib/data/db.js';
import { resolveDataDir } from '../../lib/data/data-dir.js';
import {
  createUserDeletion,
  USER_ID_TABLES,
  USER_EMAIL_TABLES,
  NOT_USER_KEYED,
  LOG_REDACTIONS,
  JSON_REDACTIONS,
  NOT_PERSONAL_DATA_FILES,
  BLOB_KEYED_TABLES,
  NOT_BLOB_KEYED,
} from '../../lib/data/user-deletion.js';
import { R2_PREFIXES, keyForRender, keyForRef } from '../../lib/data/object-keys.js';
import { REDACTED } from '../../lib/data/csv-redaction.js';

const dirs = [];
const stores = [];

/** A data dir with the auth + memory schemas created, plus a log dir. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-erasure-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  stores.push(authStore);
  const memory = createMemory({ __dirname: dir, DEBUG_MODE: false });
  const logDir = path.join(dir, 'data'); // resolveDataDir(dir) — the CSVs live beside the db
  fs.mkdirSync(logDir, { recursive: true });
  const { deleteUser } = createUserDeletion({ baseDir: dir, getDataLogDir: () => logDir });
  return { dir, authStore, memory, logDir, deleteUser, db: getDb(dir) };
}

afterEach(() => {
  while (stores.length) { try { stores.pop().close(); } catch { /* already closed */ } }
  while (dirs.length) {
    const d = dirs.pop();
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* windows handle */ }
  }
});

/** Register + verify an account, returning { user, token }. */
function makeUser(authStore, email = 'gone@example.com') {
  const start = authStore.startRegistration(email, 'CorrectHorse9!');
  const done = authStore.completeRegistration(email, start.code);
  assert.ok(done.ok, 'fixture user must register');
  return done;
}

// ---- the erasure itself ---------------------------------------------------

test('deleting a user removes the account row AND everything keyed to it', () => {
  const { authStore, memory, deleteUser, db } = setup();
  const { user, token } = makeUser(authStore);
  memory.saveMemories(user.id, [{ id: 'm1', text: 'lives in Berlin' }]);
  authStore.startPasswordReset(user.email);
  // A second account must survive untouched.
  const other = makeUser(authStore, 'stays@example.com');
  memory.saveMemories(other.user.id, [{ id: 'm2', text: 'someone else' }]);

  const countFor = (table, column, id) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;

  assert.equal(countFor('sessions', 'user_id', user.id), 1, 'precondition: a live session');
  assert.equal(countFor('password_reset_tokens', 'user_id', user.id), 1, 'precondition: a reset token');
  assert.equal(countFor('memories', 'user_id', user.id), 1, 'precondition: memories');

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true);
  assert.equal(res.email, 'gone@example.com');

  for (const { table, column } of USER_ID_TABLES) {
    assert.equal(countFor(table, column, user.id), 0, `${table} must have no rows left for the user`);
  }
  // The session token is dead, not merely unreferenced.
  assert.equal(authStore.validateSession(token), null, 'a deleted account cannot still authenticate');
  assert.equal(authStore.findUserByEmail('gone@example.com'), null);

  // The bystander is intact.
  assert.equal(countFor('memories', 'user_id', other.user.id), 1, 'another user keeps their memories');
  assert.ok(authStore.findUserByEmail('stays@example.com'), 'another user keeps their account');
});

test('erasure kills the API keys and the credit rows, so an erased account cannot still call', () => {
  const { authStore, deleteUser, db, dir } = setup();
  const { user } = makeUser(authStore);
  const other = makeUser(authStore, 'stays@example.com');

  const keys = createApiKeys(dir);
  const billing = createApiBilling(dir);
  const mine = keys.mintKey({ userId: user.id, name: 'CI' });
  const theirs = keys.mintKey({ userId: other.user.id, name: 'theirs' });
  billing.creditPurchase({ userId: user.id, credits: 10, sessionId: 'cs_erase' });
  billing.creditPurchase({ userId: other.user.id, credits: 4, sessionId: 'cs_keep' });
  const spent = billing.claimAndDebit({
    keyId: mine.record.id, userId: user.id, idempotencyKey: 'i', fingerprint: 'f', cost: 1,
  });
  assert.equal(spent.ok, true, 'precondition: the account has spent a credit');

  assert.equal(deleteUser({ userId: user.id }).ok, true);

  // The credential is gone, not merely orphaned — this is the row that would otherwise
  // keep an erased account authenticating against /api/v1/*.
  assert.equal(keys.findByKey(mine.key), null, 'a live API key outlived the account');
  assert.equal(billing.getBalance(user.id).balance, 0);
  assert.equal(billing.listLedger(user.id).length, 0, 'the per-request activity trail is gone too');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM api_requests WHERE user_id = ?').get(user.id).n,
    0,
  );

  // The bystander keeps everything.
  assert.ok(keys.findByKey(theirs.key), "another account's key must survive");
  assert.equal(billing.getBalance(other.user.id).balance, 4);
});

test('an unverified signup can be erased by address alone', () => {
  // `pending_registrations` holds a scrypt hash + the address before any `users` row
  // exists. Without this path the only way that credential leaves disk is if someone
  // happens to retry the signup — an erasure request for the address would answer
  // NOT_FOUND while the data sat there.
  const { authStore, deleteUser, db } = setup();
  authStore.startRegistration('unverified@example.com', 'CorrectHorse9!');
  const pending = () =>
    db.prepare('SELECT COUNT(*) AS n FROM pending_registrations WHERE email = ?').get('unverified@example.com').n;
  assert.equal(pending(), 1, 'precondition: the hash is on disk');

  const res = deleteUser({ email: 'Unverified@Example.com' });
  assert.equal(res.ok, true);
  assert.equal(res.userId, '', 'there was never an account id');
  assert.equal(pending(), 0, 'the unverified credential is gone');
});

test('erasing an account also clears a pending registration for its address', () => {
  const { authStore, deleteUser, db } = setup();
  const { user } = makeUser(authStore, 'reuse@example.com');
  // The front door cannot produce this state (startRegistration on a verified
  // address deliberately creates nothing, to stay non-enumerating), but a legacy
  // import or a hand-edited row can — and it would be a live credential for an
  // address that is supposed to be erased.
  db.prepare(
    'INSERT INTO pending_registrations (email, password_salt, password_hash, code_salt, code_hash, attempts, exp) VALUES (?,?,?,?,?,0,?)',
  ).run('reuse@example.com', 's', 'h', 'cs', 'ch', Date.now() + 60_000);

  deleteUser({ userId: user.id });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pending_registrations WHERE email = ?').get('reuse@example.com').n,
    0,
    'an unverified credential for the erased address must not survive',
  );
});

test('an account can be erased by email as well as by id', () => {
  const { authStore, deleteUser } = setup();
  makeUser(authStore, 'byemail@example.com');
  const res = deleteUser({ email: 'ByEmail@Example.com  ' });
  assert.equal(res.ok, true, 'the lookup normalises case and whitespace like the login path');
  assert.equal(authStore.findUserByEmail('byemail@example.com'), null);
});

// routes/admin.js forwards BOTH fields straight from the dashboard body, so this is
// the shape a real erasure request arrives in. The lookup used to be a ternary —
// `userId ? findById : findByEmail` — so a stale id (the account was recreated) or a
// typo meant the address was never tried and the operator got NOT_FOUND while every
// row, CSV cell and legacy-JSON entry survived. Exactly the wrong answer to give
// someone processing a right-to-erasure request.
test('a stale id does not stop the erasure when a valid email came with it', () => {
  const { authStore, deleteUser } = setup();
  makeUser(authStore, 'both@example.com');
  const res = deleteUser({ userId: 'stale-id-that-matches-nothing', email: 'Both@Example.com' });
  assert.equal(res.ok, true, 'the email must be tried when the id resolves to nothing');
  assert.equal(res.email, 'both@example.com');
  assert.equal(authStore.findUserByEmail('both@example.com'), null, 'the account must actually be gone');
});

test('an unknown user and a missing identifier are refused, not silently "ok"', () => {
  const { deleteUser } = setup();
  assert.equal(deleteUser({ userId: 'nope' }).code, 'NOT_FOUND');
  assert.equal(deleteUser({ email: 'nobody@example.com' }).code, 'NOT_FOUND');
  assert.equal(deleteUser({}).code, 'NO_IDENTIFIER');
  // Both wrong is still NOT_FOUND — the fallback must not invent a subject.
  assert.equal(deleteUser({ userId: 'nope', email: 'nobody@example.com' }).code, 'NOT_FOUND');
});

test('an account with a live Stripe subscription is refused unless forced', () => {
  const { authStore, deleteUser, db } = setup();
  const { user } = makeUser(authStore, 'paying@example.com');
  db.prepare('UPDATE users SET stripe_subscription_id = ? WHERE id = ?').run('sub_123', user.id);

  const refused = deleteUser({ userId: user.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ACTIVE_SUBSCRIPTION', 'erasing would leave the card being charged with no account');
  assert.ok(authStore.findUserByEmail('paying@example.com'), 'nothing was deleted');

  const forced = deleteUser({ userId: user.id, force: true });
  assert.equal(forced.ok, true, 'force is the escape hatch once Stripe has been cancelled out of band');
  assert.equal(authStore.findUserByEmail('paying@example.com'), null);
});

test('a failure part-way through rolls the whole erasure back', () => {
  // Half an erasure is the exact state that produces the orphans this module exists
  // to prevent. `users` is deleted LAST, so aborting on it proves the earlier
  // deletes were inside the transaction and came back.
  const { authStore, memory, deleteUser, db } = setup();
  const { user } = makeUser(authStore, 'atomic@example.com');
  memory.saveMemories(user.id, [{ id: 'm1', text: 'still here' }]);
  const countFor = (table, column, id) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;

  db.exec("CREATE TRIGGER erasure_boom BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try {
    assert.throws(() => deleteUser({ userId: user.id }), /boom/, 'a hard DB failure must be loud, not swallowed');
    assert.equal(countFor('memories', 'user_id', user.id), 1, 'memories rolled back');
    assert.equal(countFor('sessions', 'user_id', user.id), 1, 'the session rolled back');
    assert.ok(authStore.findUserByEmail('atomic@example.com'), 'the account is still fully present');
  } finally {
    db.exec('DROP TRIGGER erasure_boom');
  }
});

// ---- the CSV logs ---------------------------------------------------------

test('the CSV logs lose that person\'s identifying cells, keeping every row', () => {
  const { authStore, deleteUser, logDir } = setup();
  const { user } = makeUser(authStore, 'logged@example.com');

  fs.writeFileSync(
    path.join(logDir, 'prompt_logs.csv'),
    'timestamp,roomType,email,ipAddress\n' +
      't1,living,logged@example.com,1.2.3.4\n' +
      't2,bedroom,other@example.com,5.6.7.8\n',
  );
  fs.writeFileSync(
    path.join(logDir, 'chat_logs.csv'),
    'timestamp,userId,userMessage,ipAddress,userAgent\n' + `t1,${user.id},hello,1.2.3.4,Chrome\n`,
  );

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true);

  const prompt = fs.readFileSync(path.join(logDir, 'prompt_logs.csv'), 'utf8');
  assert.ok(!prompt.includes('logged@example.com'), 'the address is gone');
  assert.ok(!prompt.includes('1.2.3.4'), 'so is the IP recorded with it');
  assert.ok(prompt.includes('other@example.com'), 'other people are untouched');
  assert.equal(prompt.trimEnd().split('\n').length, 3, 'row count unchanged — "Rooms Staged" must not move');
  assert.ok(prompt.includes(REDACTED));

  const chat = fs.readFileSync(path.join(logDir, 'chat_logs.csv'), 'utf8');
  assert.ok(!chat.includes(user.id), 'the user id is gone from the chat log too');

  // The report tells the operator what happened, per file.
  const promptReport = res.logs.find((l) => l.file.endsWith('prompt_logs.csv'));
  assert.equal(promptReport.matched, 1);
  assert.equal(res.logs.find((l) => l.file.endsWith('contact_logs.csv')).present, false, 'absent logs are reported, not an error');
});

test('a log that cannot be rewritten does not roll back or throw the erasure', () => {
  const { authStore, deleteUser, logDir } = setup();
  const { user } = makeUser(authStore, 'partial@example.com');
  // A directory where a CSV is expected: reading it throws EISDIR.
  fs.mkdirSync(path.join(logDir, 'prompt_logs.csv'));

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true, 'the account is still erased — the rows are the part that must be atomic');
  assert.equal(authStore.findUserByEmail('partial@example.com'), null);
  const failed = res.logs.find((l) => l.file.endsWith('prompt_logs.csv'));
  assert.ok(failed.error, 'the operator is told which file still holds an identifier');
});

// ---- the frozen legacy JSON stores ----------------------------------------

/** Write a JSON store into the data dir the way its owner would have left it. */
function seedStore(logDir, file, doc) {
  const full = path.join(logDir, file);
  fs.writeFileSync(full, JSON.stringify(doc, null, 2));
  return full;
}

test('the frozen auth-store.json fallback loses the address and every credential', () => {
  // auth-store.js imports this file once and then only ever reads it, so an erasure
  // that stops at SQLite leaves the whole account sitting here: address, scrypt hash,
  // and session digests that would come back live if the fallback were replayed.
  const { authStore, deleteUser, logDir } = setup();
  const { user } = makeUser(authStore, 'legacy@example.com');
  const file = seedStore(logDir, 'auth-store.json', {
    users: [
      {
        id: user.id,
        email: 'legacy@example.com',
        passwordSalt: 'salt-of-the-erased',
        passwordHash: 'scrypt-of-the-erased',
        googleSub: 'google-sub-of-the-erased',
        stripeCustomerId: 'cus_oftheerased',
        plan: 'pro',
        usageCount: 7,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      { id: 'u_bystander', email: 'stays@example.com', passwordHash: 'scrypt-of-the-bystander', plan: 'free' },
    ],
    sessions: {
      digestoftheerased: { userId: user.id, exp: 1 },
      digestofthebystander: { userId: 'u_bystander', exp: 2 },
    },
    passwordResetTokens: { resetoftheerased: { userId: user.id, exp: 3 } },
    pendingRegistrations: { 'legacy@example.com': { passwordHash: 'pending-scrypt-of-the-erased' } },
    mobileIpUsage: { '1.2.3.4': { day: '2026-01-01', count: 3 } },
  });

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true);

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('legacy@example.com'), 'the address is gone from the fallback');
  assert.ok(!raw.includes('scrypt-of-the-erased'), 'so is the password hash');
  assert.ok(!raw.includes('salt-of-the-erased'));
  assert.ok(!raw.includes('google-sub-of-the-erased'));
  assert.ok(!raw.includes('cus_oftheerased'));
  assert.ok(!raw.includes('pending-scrypt-of-the-erased'), 'and the unverified signup credential');
  assert.ok(!raw.includes('digestoftheerased'), 'a session digest is a live bearer token — it is dropped, not blanked');
  assert.ok(!raw.includes('resetoftheerased'));

  const doc = JSON.parse(raw);
  assert.equal(doc.users.length, 2, 'the record is redacted in place, not dropped');
  const erased = doc.users.find((u) => u.id === user.id);
  assert.equal(erased.email, `${REDACTED}:${user.id}`, 'unique per id, because users.email is UNIQUE NOT NULL');
  assert.equal(erased.plan, 'pro', 'non-identifying fields survive the redaction');
  assert.equal(erased.usageCount, 7);
  for (const key of ['passwordSalt', 'passwordHash', 'googleSub', 'stripeCustomerId']) {
    assert.ok(!(key in erased), `${key} has no anonymised form — it is deleted outright`);
  }

  // Everyone else is untouched.
  assert.equal(doc.users.find((u) => u.id === 'u_bystander').email, 'stays@example.com');
  assert.deepEqual(Object.keys(doc.sessions), ['digestofthebystander']);
  assert.deepEqual(doc.passwordResetTokens, {});
  assert.deepEqual(doc.pendingRegistrations, {});
  assert.deepEqual(doc.mobileIpUsage, { '1.2.3.4': { day: '2026-01-01', count: 3 } }, 'keyed by IP, not by account');

  const report = res.logs.find((l) => l.file.endsWith('auth-store.json'));
  assert.ok(report.matched >= 4, `the operator is told what changed, got ${report.matched}`);
});

test('erasing by address alone still reaches the legacy sessions of that account', () => {
  // No `users` row exists (an unverified signup), so the erasure carries no id — the
  // legacy users[] entry is the only thing that can supply one, and without it the
  // session/reset maps keyed to that id would be unreachable.
  const { authStore, deleteUser, logDir } = setup();
  authStore.startRegistration('ghost@example.com', 'CorrectHorse9!');
  const file = seedStore(logDir, 'auth-store.json', {
    users: [{ id: 'u_ghost', email: 'ghost@example.com', passwordHash: 'scrypt-of-the-ghost' }],
    sessions: { digestoftheghost: { userId: 'u_ghost', exp: 1 } },
  });

  const res = deleteUser({ email: 'Ghost@Example.com' });
  assert.equal(res.ok, true);
  assert.equal(res.userId, '', 'there was never an account id');

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('ghost@example.com'));
  assert.ok(!raw.includes('scrypt-of-the-ghost'));
  assert.ok(!raw.includes('digestoftheghost'), 'the id came from the users[] entry matched by address');
});

test('the frozen memories.json fallback loses that user\'s bucket', () => {
  const { authStore, memory, deleteUser, logDir } = setup();
  const { user } = makeUser(authStore, 'remembered@example.com');
  memory.saveMemories(user.id, [{ id: 'm1', content: 'lives in Berlin' }]);
  // The real file on disk has keys that are the id JSON-stringified a second time —
  // that is what the old writer produced, and a plain key === userId comparison walks
  // straight past it, leaving the content behind.
  const file = seedStore(logDir, 'memories.json', {
    [JSON.stringify(user.id)]: [{ id: 'm1', content: 'lives in Berlin', userMessage: 'remember where I live' }],
    u_bystander: [{ id: 'm2', content: 'someone else entirely' }],
  });

  deleteUser({ userId: user.id });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('lives in Berlin'), 'the chat content is gone');
  assert.ok(!raw.includes(user.id), 'and so is the id that keyed it');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['u_bystander'], 'nobody else lost their memories');
});

test('the email-open map loses the address it is keyed by', () => {
  const { authStore, deleteUser, logDir } = setup();
  makeUser(authStore, 'opened@example.com');
  const file = seedStore(logDir, 'email_opened.json', {
    'Opened@Example.com': '2026-01-01T00:00:00.000Z',
    'other@example.com': '2026-01-02T00:00:00.000Z',
  });

  deleteUser({ email: 'opened@example.com' });

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(doc), ['other@example.com'], 'the key is the address, so the entry goes');
});

test('a JSON store that is absent or holds nobody is a no-op, not an error', () => {
  const { authStore, deleteUser, logDir } = setup();
  const { user } = makeUser(authStore, 'nofiles@example.com');
  // memories.json exists but names someone else: it must come out byte-identical.
  const untouched = seedStore(logDir, 'memories.json', { u_bystander: [{ id: 'm1', content: 'not theirs' }] });
  const before = fs.readFileSync(untouched, 'utf8');

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true);

  for (const spec of JSON_REDACTIONS) {
    const report = res.logs.find((l) => l.file.endsWith(spec.file));
    assert.ok(report, `${spec.file} is reported even when it does not exist`);
    assert.ok(!report.error, `${spec.file}: a missing store is a no-op, not a failure`);
    assert.equal(report.matched, 0);
  }
  assert.equal(res.logs.find((l) => l.file.endsWith('auth-store.json')).present, false);
  assert.ok(!fs.existsSync(path.join(logDir, 'auth-store.json')), 'a missing store is not created');
  assert.equal(fs.readFileSync(untouched, 'utf8'), before, 'a store with no match is not rewritten at all');
});

test('an unreadable JSON store is reported, not thrown, like the CSVs', () => {
  const { authStore, deleteUser, logDir } = setup();
  const { user } = makeUser(authStore, 'broken@example.com');
  fs.writeFileSync(path.join(logDir, 'memories.json'), '{ not json');
  fs.mkdirSync(path.join(logDir, 'auth-store.json')); // reading a directory throws EISDIR

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true, 'the rows are the part that must be atomic');
  assert.equal(res.logs.find((l) => l.file.endsWith('memories.json')).reason, 'not parseable as JSON');
  assert.ok(res.logs.find((l) => l.file.endsWith('auth-store.json')).error, 'the operator is told which file to check');
});

// ---- drift guards ---------------------------------------------------------

test('every user-keyed table in the real schema is covered by erasure', () => {
  const { db } = setup();
  const covered = new Set([...USER_ID_TABLES, ...USER_EMAIL_TABLES].map((t) => t.table));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  assert.ok(tables.length >= 6, 'sanity: the schemas under test were created');

  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const looksUserKeyed =
      columns.includes('user_id') || (table === 'users' && columns.includes('id')) || columns.includes('email');
    if (!looksUserKeyed) continue;
    assert.ok(
      covered.has(table) || Object.hasOwn(NOT_USER_KEYED, table),
      `Table "${table}" holds a user identifier but lib/data/user-deletion.js neither erases it ` +
        '(add it to USER_ID_TABLES / USER_EMAIL_TABLES) nor explains why it is exempt (add it to NOT_USER_KEYED). ' +
        'There are no foreign keys in this database, so an unlisted table outlives the account.',
    );
  }
});

// Guard 3. The structural twin of the user_id scan above, for bytes that do not live in
// this database at all.
//
// The existing data-dir guard finds targets by scanning for `path.join(<dataDir>, …)`.
// Render bytes are in an R2 bucket, so that scan passes VACUOUSLY for them — it cannot
// see what it cannot find a path.join for. Without this guard, adding a table that
// points at object-store bytes would leave those bytes undeleted after an erasure and
// nothing in the suite would notice.
test('every table naming object-store bytes is tombstoned by erasure', () => {
  const { db } = setup();
  // Create a table shaped like one somebody might add later, so the scan has something
  // to find even before Phase C's real tables exist. If the scan cannot fail, it is not
  // a guard.
  db.exec('CREATE TABLE IF NOT EXISTS render_blobs (render_id TEXT, role TEXT, storage_key TEXT, user_id TEXT)');

  const covered = new Set(BLOB_KEYED_TABLES.map((t) => t.table));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  let scanned = 0;
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes('storage_key')) continue;
    scanned += 1;
    assert.ok(
      covered.has(table) || Object.hasOwn(NOT_BLOB_KEYED, table),
      `Table "${table}" holds a storage_key but lib/data/user-deletion.js neither tombstones it ` +
        '(add it to BLOB_KEYED_TABLES) nor explains why it is exempt (add it to NOT_BLOB_KEYED). ' +
        'Those bytes are in an object store, so the data-dir guard cannot see them — an unlisted ' +
        'table means an erased account whose room photographs stay in the bucket forever.',
    );
  }
  assert.ok(scanned >= 2, `sanity: the scan must actually find storage_key tables, saw ${scanned}`);
});

// Guard 4. Every object-key SHAPE the app can mint has to have its erasure story
// written down. BLOB_KEYED_TABLES covers "which rows name bytes"; this covers "which
// bytes can exist at all", which is the half that catches a key minted by a code path
// that forgot to record a row.
test('every object-key prefix the app can mint is classified', () => {
  const minted = [
    keyForRender({ renderId: '0123456789abcdef0123456789abcdef', role: 'after' }),
    keyForRender({ renderId: '0123456789abcdef0123456789abcdef', role: 'before' }),
    keyForRender({ renderId: '0123456789abcdef0123456789abcdef', role: 'thumb' }),
    keyForRef({ refHash: 'a'.repeat(64) }),
  ];
  const prefixes = new Set(Object.keys(R2_PREFIXES));
  for (const key of minted) {
    const prefix = [...prefixes].find((p) => key.startsWith(p));
    assert.ok(
      prefix,
      `The app can mint the object key "${key}" but R2_PREFIXES in lib/data/object-keys.js does not ` +
        'classify its prefix. Every shape of byte this app writes needs a written answer to "how does ' +
        'an erasure reach it".',
    );
    assert.ok(
      String(R2_PREFIXES[prefix]).length > 20,
      `R2_PREFIXES["${prefix}"] needs a real explanation, not a placeholder`,
    );
  }
  // ...and nothing may be classified that cannot actually be minted, or the map becomes
  // documentation of a layout that no longer exists.
  for (const prefix of prefixes) {
    assert.ok(minted.some((k) => k.startsWith(prefix)), `R2_PREFIXES lists "${prefix}" but nothing mints it`);
  }
});

/**
 * Strip JS comments so a guard that greps source cannot be satisfied by prose. This
 * repo has shipped a guard that passed with the fix deleted because the fix's own
 * explanatory comment named the token the scan looked for.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = ''; // '' | ' | " | `
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
      if (ch === quote) quote = '';
      out += ch; i += 1; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/** Every .js file under the app's server-side source. */
function serverSourceFiles() {
  const files = [path.join(process.cwd(), 'server.js')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  for (const root of ['lib', 'routes']) walk(path.join(process.cwd(), root));
  return files;
}

/**
 * Every path the app resolves INSIDE the data directory — the set of things an
 * erasure has to have an answer for.
 *
 * Discovery is by construction, not by a hand-kept list: any `path.join(<a data
 * dir>, '<name>')` in the server source counts, whatever the extension, so a new
 * store, a new log or an extensionless directory is found the moment it is written.
 * The real data dir is folded in as ground truth when one exists (CI starts without
 * it — `/data/` is gitignored — so the source scan is what actually gates the build).
 */
function discoverDataDirTargets() {
  const found = new Set();
  for (const file of serverSourceFiles()) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/path\.join\(\s*([^,()]*(?:\([^()]*\))?[^,()]*)\s*,\s*'([^']+)'/g)) {
      if (!/dataDir|dataLogDir|logDir|hostedImagesDir/i.test(m[1])) continue;
      found.add(m[2]);
    }
  }
  const real = resolveDataDir(process.cwd());
  if (fs.existsSync(real)) {
    for (const entry of fs.readdirSync(real)) {
      if (/\.db-(wal|shm)$|\.redact-tmp$/.test(entry)) continue; // sqlite sidecars / our own tmp
      found.add(entry);
    }
  }
  return found;
}

test('every path the app resolves inside the data dir is redacted or exempted', () => {
  const found = discoverDataDirTargets();

  // Sanity: the scan has to actually see the data dir, and — the point of this
  // rewrite — it has to see things that are NOT .csv. The guard this replaced matched
  // /'([a-z_]+\.csv)'/, so it could not have failed these lines, which is exactly how
  // the JSON stores below stayed uncovered.
  assert.ok(found.size >= 12, `sanity: expected the data dir's contents, got ${[...found].sort().join(', ')}`);
  for (const expected of [
    'prompt_logs.csv',
    'chat_logs.csv',
    'auth-store.db',
    'auth-store.json',
    'memories.json',
    'email_opened.json',
    'enterprise-domains.json',
    'uptime.json',
    'hosted-images',
  ]) {
    assert.ok(found.has(expected), `sanity: discovery missed ${expected} — the scan, not the list, is the guard`);
  }

  const covered = new Set([...LOG_REDACTIONS, ...JSON_REDACTIONS].map((s) => s.file));
  for (const file of found) {
    assert.ok(
      covered.has(file) || Object.hasOwn(NOT_PERSONAL_DATA_FILES, file),
      `"${file}" lives in the data directory but lib/data/user-deletion.js neither erases it (add it to ` +
        'LOG_REDACTIONS or JSON_REDACTIONS) nor explains why it is exempt (add it to NOT_PERSONAL_DATA_FILES). ' +
        'A data file nobody classified is the next place a "complete" erasure leaves personal data on disk.',
    );
  }
});

test('the file coverage lists name real data files', () => {
  // A typo would otherwise pass the guard above while redacting nothing: the redaction
  // opens a path that does not exist, gets ENOENT, and reports a cheerful no-op.
  const found = discoverDataDirTargets();
  for (const file of [...LOG_REDACTIONS.map((s) => s.file), ...JSON_REDACTIONS.map((s) => s.file)]) {
    assert.ok(found.has(file), `"${file}" is redacted by user-deletion.js but the app never writes it — typo?`);
  }
  for (const file of Object.keys(NOT_PERSONAL_DATA_FILES)) {
    assert.ok(found.has(file), `"${file}" is exempted but no longer exists — drop the stale exemption`);
  }
  assert.equal(JSON_REDACTIONS.length, new Set(JSON_REDACTIONS.map((s) => s.file)).size, 'no duplicate entries');
});

test('the coverage lists name real tables and real columns', () => {
  const { db } = setup();
  for (const { table, column } of [...USER_ID_TABLES, ...USER_EMAIL_TABLES]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length > 0, `USER_*_TABLES names "${table}", which does not exist`);
    assert.ok(columns.includes(column), `"${table}" has no column "${column}"`);
  }
});
