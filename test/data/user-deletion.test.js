// GDPR erasure across the whole data layer.
//
// WHAT THIS COVERS
// This database has NO foreign keys (deliberately — see lib/data/db.js), so nothing
// cascades: every table keyed to a user has to be named in USER_ID_TABLES or its rows
// outlive the account. The orphans that matters most are `sessions` — a live bearer
// token for an account that no longer exists — and `memories`, which is chat content
// keyed to an id nothing can resolve back to a person to honour a second request.
//
// The last test is the one that keeps this working: it introspects the REAL schema
// and fails if any table grows a user-keyed column that erasure does not cover. The
// coverage list is easy to write once and easy to forget forever.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createMemory } from '../../lib/data/memory.js';
import { getDb, closeDb } from '../../lib/data/db.js';
import {
  createUserDeletion,
  USER_ID_TABLES,
  USER_EMAIL_TABLES,
  NOT_USER_KEYED,
  LOG_REDACTIONS,
} from '../../lib/data/user-deletion.js';
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

test('an unknown user and a missing identifier are refused, not silently "ok"', () => {
  const { deleteUser } = setup();
  assert.equal(deleteUser({ userId: 'nope' }).code, 'NOT_FOUND');
  assert.equal(deleteUser({ email: 'nobody@example.com' }).code, 'NOT_FOUND');
  assert.equal(deleteUser({}).code, 'NO_IDENTIFIER');
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

test('every CSV log the app writes is either redacted or exempted', () => {
  // Sources that name a CSV: the writers and the admin download routes.
  const sources = ['lib/services/logging.js', 'lib/services/email.js', 'routes/public.js', 'routes/admin.js'];
  const found = new Set();
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    for (const m of text.matchAll(/'([a-z_]+\.csv)'/g)) found.add(m[1]);
  }
  assert.ok(found.size >= 5, `sanity: expected to find the CSV logs, got ${[...found].join(', ')}`);

  const redacted = new Set(LOG_REDACTIONS.map((s) => s.file));
  for (const file of found) {
    assert.ok(
      redacted.has(file),
      `${file} is written by the app but lib/data/user-deletion.js#LOG_REDACTIONS does not redact it — ` +
        'a new log means new personal data that survives an erasure request.',
    );
  }
});

test('the coverage lists name real tables and real columns', () => {
  const { db } = setup();
  for (const { table, column } of [...USER_ID_TABLES, ...USER_EMAIL_TABLES]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length > 0, `USER_*_TABLES names "${table}", which does not exist`);
    assert.ok(columns.includes(column), `"${table}" has no column "${column}"`);
  }
});
