// Erasure of one account, everywhere its data lives.
//
// This database declares NO foreign keys (see the note in db.js), so nothing
// cascades on its own: deleting a `users` row on its own would leave that person's
// `sessions`, `password_reset_tokens` and `memories` rows behind — live session
// tokens for an account that no longer exists, and chat memories keyed to an id
// nothing can resolve. Every user-keyed table therefore has to be listed HERE, and
// `test/data/user-deletion.test.js` fails the build if a new one appears that this
// module does not cover. That guard is the point of the module: the list is easy to
// write once and easy to forget forever.
//
// Beyond SQLite, the data directory holds the same person twice over: the CSV logs
// carry their email/id, and the legacy JSON stores that SQLite was imported FROM are
// still sitting there as rollback fallbacks with the account exactly as it was on
// import day — address, password hash and session digests included. Both are covered
// here: every path the app resolves inside the data dir has to appear in
// LOG_REDACTIONS, JSON_REDACTIONS or NOT_PERSONAL_DATA_FILES, and the drift test
// enforces that, so a new data file cannot quietly become the next thing erasure
// forgets (which is exactly how the JSON stores below were missed).
//
// REDACT vs REMOVE, the rule this module applies to every flat-file record:
//   * a record with a non-identifying skeleton worth keeping is REDACTED in place —
//     the CSV rows (row counts feed the public "Rooms Staged" counter, see
//     csv-redaction.js) and the legacy `users[]` entries;
//   * a record that is keyed BY the identifier, or that IS the secret, is REMOVED —
//     a session/reset entry is keyed by its own token digest and a memories bucket by
//     the user id, so there is no cell left to blank, and keeping the husk would only
//     restore an orphan (or a live token) if the fallback were ever re-imported.
import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { BLOB_TOMBSTONE_SCHEMA } from './blob-tombstones.js';
import { GALLERY_SCHEMA } from './gallery-schema.js';
import { SCHEMA as API_KEYS_SCHEMA } from './api-keys.js';
import { SCHEMA as API_BILLING_SCHEMA } from './api-billing.js';
import { redactCsvFile, writeFileAtomic, REDACTED } from './csv-redaction.js';
import { logger } from '../logger.js';

/**
 * Tables keyed by the user's **id**, and the column holding it. Order matters only
 * for readability — the whole set runs in one transaction.
 * @type {{ table: string, column: string }[]}
 */
export const USER_ID_TABLES = [
  { table: 'sessions', column: 'user_id' },
  { table: 'password_reset_tokens', column: 'user_id' },
  { table: 'memories', column: 'user_id' },
  // The gallery. These rows name bytes in the object store, so they are ALSO in
  // BLOB_KEYED_TABLES — the tombstone pass reads their storage_key before these deletes
  // run, which is why the tombstone statements come first inside purgeRows.
  { table: 'render_blobs', column: 'user_id' },
  { table: 'render_refs', column: 'user_id' },
  { table: 'ref_objects', column: 'user_id' },
  { table: 'gallery_shares', column: 'user_id' },
  { table: 'staged_renders', column: 'user_id' },
  // The public API. api_keys holds live bearer credentials, so leaving them behind
  // would keep an erased account callable; the billing rows are OPERATIONAL records,
  // not statutory ones — Stripe holds the authoritative payment history under its own
  // retention, so nothing here is the company's books. Erasing them is therefore the
  // honest reading of "delete my data", and keeping them would mean keeping a
  // per-request activity trail of somebody who asked to be forgotten.
  { table: 'api_keys', column: 'user_id' },
  { table: 'api_requests', column: 'user_id' },
  { table: 'api_credit_ledger', column: 'user_id' },
  { table: 'api_credit_balances', column: 'user_id' },
  // The account row goes last so a failure part-way cannot leave the satellite rows
  // orphaned by a user row that is already gone (the transaction makes this belt and
  // braces, but the ordering is free).
  { table: 'users', column: 'id' },
];

/**
 * Tables keyed by the user's **email** rather than their id. `pending_registrations`
 * holds a password hash for an address that has not been verified yet, so an erasure
 * that skipped it would leave a credential behind for the address just erased.
 * @type {{ table: string, column: string }[]}
 */
export const USER_EMAIL_TABLES = [{ table: 'pending_registrations', column: 'email' }];

/**
 * Tables that mention people but are deliberately NOT touched by a user erasure,
 * with the reason. The drift test reads this, so a new table has to be classified
 * one way or the other rather than silently ignored.
 * @type {Record<string, string>}
 */
export const NOT_USER_KEYED = {
  mobile_ip_usage: 'keyed by IP for the free-tier quota, with no link to an account',
  enterprise_domains: 'a company record (its own billing relationship), not a user account',
  stripe_events: 'webhook event ids only — no personal data',
  uptime_state: 'service uptime history — no personal data',
  meta: 'migration bookkeeping — no personal data',
  blob_tombstones:
    "the erasure's OWN work queue. It holds opaque object keys (no user id — lib/data/object-keys.js keeps ids " +
    'out of the key layout precisely so this exemption is honest) for bytes whose rows are ALREADY deleted. ' +
    'Giving this table a user_id column would make the guard above demand that an erasure delete these rows, ' +
    'which would delete the record that the bytes still need deleting — the account would look erased while its ' +
    'room photographs stayed in the bucket forever.',
};

/**
 * Tables whose rows name bytes in the object store, and the column holding the key.
 *
 * Erasure does not delete these bytes inline — it cannot, because the rows go in a
 * synchronous transaction and an object-store delete is an async network call. It
 * tombstones them instead (see lib/data/blob-tombstones.js), inside the same
 * transaction, so the obligation commits atomically with the rows.
 *
 * The drift test reads this: any table that grows a `storage_key` column must appear
 * here or in {@link NOT_BLOB_KEYED}. Without it, adding a table that points at off-box
 * bytes would silently leave those bytes undeleted — and the existing data-dir guard
 * could never catch it, because it discovers targets by scanning for
 * `path.join(<dataDir>, …)` and bytes in a bucket are not on the data dir at all.
 *
 * @type {{ table: string, column: string, userColumn: string }[]}
 */
export const BLOB_KEYED_TABLES = [
  { table: 'render_blobs', column: 'storage_key', userColumn: 'user_id' },
  { table: 'ref_objects', column: 'storage_key', userColumn: 'user_id' },
];

/**
 * Tables carrying a `storage_key` that an erasure deliberately does NOT tombstone,
 * with the reason.
 * @type {Record<string, string>}
 */
export const NOT_BLOB_KEYED = {
  blob_tombstones:
    'the queue itself — its storage_key column IS the work order, not a reference to bytes an account still owns',
};

/**
 * CSV logs and which of their cells identify a person. Column names are resolved
 * against each file's own header at run time, so this survives the appended-column
 * convention the prompt log uses.
 * @type {{ file: string, matchOn: ('email'|'userId')[], redact: string[] }[]}
 */
export const LOG_REDACTIONS = [
  { file: 'prompt_logs.csv', matchOn: ['email'], redact: ['email', 'ipAddress'] },
  { file: 'contact_logs.csv', matchOn: ['email'], redact: ['email', 'ipAddress', 'userAgent'] },
  { file: 'email_open_logs.csv', matchOn: ['email'], redact: ['email', 'ipAddress', 'userAgent'] },
  { file: 'mask_logs.csv', matchOn: ['userId'], redact: ['userId', 'ipAddress', 'userAgent'] },
  { file: 'chat_logs.csv', matchOn: ['userId'], redact: ['userId', 'ipAddress', 'userAgent'] },
  { file: 'bug_reports.csv', matchOn: ['email', 'userId'], redact: ['email', 'userId', 'ipAddress', 'userAgent'] },
  // Turned-away requests (refused uploads, daily-cap hits, rate limits). Rows carry
  // whichever identity the request had, so an erasure has to reach them too; `kind`,
  // `code` and `detail` are non-identifying and stay, which keeps the drop-off
  // analytics intact after a deletion.
  { file: 'rejection_logs.csv', matchOn: ['email', 'userId'], redact: ['email', 'userId', 'ipAddress', 'userAgent'] },
];

/** Case/whitespace-insensitive address comparison, matching the login path. */
function sameEmail(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Some legacy memories keys are the user id JSON-stringified a second time — the old
 * writer produced `"\"u_1\""` — so the real file on disk holds quoted keys that a
 * plain `key === userId` comparison walks straight past.
 */
function unquote(key) {
  const s = String(key);
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * Delete every own key of `obj` the predicate accepts.
 * @param {any} obj - The map-shaped part of a legacy store (ignored unless it is a plain object).
 * @param {(key: string, value: any) => boolean} pred - True for entries to remove.
 * @returns {number} How many entries were removed.
 */
function dropEntries(obj, pred) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let removed = 0;
  for (const key of Object.keys(obj)) {
    if (!pred(key, obj[key])) continue;
    delete obj[key];
    removed += 1;
  }
  return removed;
}

/** Credential/linking fields that have no anonymised form — they are deleted outright. */
const LEGACY_USER_SECRETS = ['passwordSalt', 'passwordHash', 'googleSub', 'stripeCustomerId', 'stripeSubscriptionId'];

/**
 * `auth-store.json` — the frozen fallback the SQLite auth store was imported from
 * (auth-store.js only ever reads it). It holds the whole account: the address, the
 * scrypt hash, every live session digest and every reset token.
 *
 * @param {any} doc - The parsed document, mutated in place.
 * @param {{ userId: string, email: string }} subject - Who is being erased.
 * @returns {number} Entries changed.
 */
function scrubLegacyAuthStore(doc, subject) {
  let changed = 0;
  // Ids that identify the subject *in this file*. An erasure by address alone (an
  // unverified signup) arrives with no id, so the users[] entry supplies it — and
  // that is what lets the sessions/reset maps below be matched at all.
  const ids = new Set(subject.userId ? [subject.userId] : []);

  if (Array.isArray(doc.users)) {
    for (const u of doc.users) {
      if (!u || typeof u !== 'object') continue;
      if (!((u.id && ids.has(u.id)) || sameEmail(u.email, subject.email))) continue;
      if (u.id) ids.add(u.id);
      // The record stays, only the cells that name the person go — same call the CSV
      // rows get. The id is appended to the redaction because `users.email` is UNIQUE
      // NOT NULL (see the schema in auth-store.js): two erased accounts both holding a
      // literal '[erased]' would collide and abort the import if this fallback were
      // ever replayed. The id sits in the very same record, so this discloses nothing.
      u.email = u.id ? `${REDACTED}:${u.id}` : REDACTED;
      for (const key of LEGACY_USER_SECRETS) delete u[key];
      changed += 1;
    }
  }

  // Keyed by the token digest, which IS the credential: nothing to blank, so drop it.
  changed += dropEntries(doc.sessions, (_key, value) => !!value && ids.has(value.userId));
  changed += dropEntries(doc.passwordResetTokens, (_key, value) => !!value && ids.has(value.userId));
  // Keyed by the address, value is an unverified signup's password hash.
  changed += dropEntries(doc.pendingRegistrations, (key) => sameEmail(key, subject.email));
  // `mobileIpUsage` is untouched: keyed by IP with no link to an account, the same
  // call NOT_USER_KEYED makes for the `mobile_ip_usage` table it was imported into.
  return changed;
}

/**
 * `memories.json` — the frozen fallback behind the `memories` table, `{ userId: [...] }`
 * where the entries are chat content the user asked to be remembered.
 *
 * @param {any} doc - The parsed document, mutated in place.
 * @param {{ userId: string, email: string }} subject - Who is being erased.
 * @returns {number} Entries changed.
 */
function scrubLegacyMemories(doc, subject) {
  if (!subject.userId) return 0; // nothing but the id can identify a bucket
  // The bucket is keyed BY the id, so an emptied bucket would be a husk that only
  // re-imports as an orphan row — and its SQLite counterpart is DELETEd, not blanked.
  return dropEntries(doc, (key) => unquote(key) === subject.userId);
}

/**
 * `email_opened.json` — the binary "has this address ever opened an email" map
 * written by lib/services/email.js, keyed by the address itself.
 *
 * Unlike the two fallbacks above, this file is LIVE: email.js holds it in a Map on the
 * createEmail instance and rewrites the whole map on the next open by anybody, so
 * scrubbing the file alone would let a running process put the erased address straight
 * back. That is why deleteUser also calls the injected `forgetEmailOpenState` seam
 * (wired in server.js) right after this pass — disk and cache are cleared together, so
 * no restart is required.
 *
 * @param {any} doc - The parsed document, mutated in place.
 * @param {{ userId: string, email: string }} subject - Who is being erased.
 * @returns {number} Entries changed.
 */
function scrubEmailOpened(doc, subject) {
  return dropEntries(doc, (key) => sameEmail(key, subject.email));
}

/**
 * Non-CSV data files that can hold a person, with the function that scrubs one
 * subject out of the parsed document (mutating it, returning how many entries it
 * changed — 0 leaves the file untouched on disk).
 *
 * These are the *frozen legacy fallbacks*: each store imported its JSON once on first
 * boot and never writes to it again, which is precisely why they were easy to forget
 * and why stale PII in them is real exposure — a restore that re-imported one would
 * bring the erased account back.
 *
 * @type {{ file: string, scrub: (doc: any, subject: { userId: string, email: string }) => number }[]}
 */
export const JSON_REDACTIONS = [
  { file: 'auth-store.json', scrub: scrubLegacyAuthStore },
  { file: 'memories.json', scrub: scrubLegacyMemories },
  { file: 'email_opened.json', scrub: scrubEmailOpened },
];

/**
 * Paths the app resolves inside the data directory that an erasure deliberately does
 * NOT touch, with the reason. The drift test reads this, so a new data file has to be
 * classified one way or the other rather than silently ignored.
 * @type {Record<string, string>}
 */
export const NOT_PERSONAL_DATA_FILES = {
  'auth-store.db':
    'the live SQLite database itself — erased row by row via USER_ID_TABLES / USER_EMAIL_TABLES, not as a file',
  'uptime.json': 'service uptime history — no personal data (as NOT_USER_KEYED says of the uptime_state table)',
  'enterprise-domains.json':
    'the frozen fallback for enterprise_domains, which NOT_USER_KEYED exempts as a company billing record rather ' +
    'than a user account. Scrubbing the JSON copy alone would be worse than useless — the live row would keep the ' +
    'contact address while the file looked done. An enterprise contact who asks for erasure needs the domain ' +
    'subscription cancelled first, the same operator step the ACTIVE_SUBSCRIPTION refusal asks for.',
  'hosted-images':
    'admin-uploaded assets (POST /api/host-image is behind protectLogs), and no manifest entry carries a user id ' +
    'or email — there is nothing to key an erasure on',
  'index.json': 'the hosted-images manifest, inside the directory above',
  objects:
    'the LOCAL object-store backend (dev and CI only — in production the bytes are in R2 and never touch this ' +
    'disk). Its contents ARE personal data and ARE erased, but per OBJECT via blob_tombstones rather than as a ' +
    'file, exactly as auth-store.db above is erased row by row rather than as a file. BLOB_KEYED_TABLES is the ' +
    'list that guarantees it, and the drift test over that list is what would catch a table pointing at bytes ' +
    'nobody deletes.',
};

/**
 * Redact one subject out of a JSON store, in place.
 *
 * A missing file is a no-op (these fallbacks only exist where a store was migrated
 * from JSON), and a store with no match is not rewritten at all.
 *
 * @param {string} filePath - The JSON file to rewrite.
 * @param {(doc: any, subject: { userId: string, email: string }) => number} scrub - Per-store scrubber.
 * @param {{ userId: string, email: string }} subject - Who is being erased.
 * @returns {{ file: string, present: boolean, matched: number, reason?: string }}
 */
export function redactJsonStore(filePath, scrub, subject) {
  const result = { file: filePath, present: false, matched: 0 };
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return result; // never migrated from JSON
    throw err;
  }
  result.present = true;
  if (!text.trim()) return result;

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // Report it rather than throw: an unreadable fallback still needs an operator's
    // eyes, and the rest of the erasure must not be held up by it.
    result.reason = 'not parseable as JSON';
    return result;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    result.reason = 'not a JSON object';
    return result;
  }

  result.matched = scrub(doc, subject);
  if (result.matched === 0) return result; // leave the file untouched

  // Two-space JSON, matching what the writers of these files produce (compare
  // saveEmailOpened in lib/services/email.js), so a rewrite is a minimal diff.
  writeFileAtomic(filePath, JSON.stringify(doc, null, 2));
  return result;
}

/**
 * Does this table exist yet?
 *
 * The gallery's tables are created by their own store factory, so a process that has
 * never opened it (or a test that never touches it) simply has none of them. Erasure
 * must still work there — it is the one path that cannot be allowed to fail with "no
 * such table" — so the tombstone statements are prepared only for tables that are
 * actually present.
 *
 * @param {{ prepare: (sql: string) => any }} db - The shared connection.
 * @param {string} table - Table name.
 * @returns {boolean}
 */
function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Build the erasure helper bound to a data directory.
 *
 * @param {{ baseDir: string, getDataLogDir: () => string,
 *   forgetEmailOpenState?: (email: string) => number,
 *   blobReaper?: { drain: (opts?: { limit?: number }) => Promise<any> } }} deps - The
 *   base dir the shared SQLite connection is resolved against, and the directory the
 *   CSV logs live in (injected rather than re-derived — same rule as everything else
 *   that touches the data dir). `blobReaper` drains the object-store deletions this
 *   erasure queues; optional, so a factory built without it (every existing test) still
 *   tombstones correctly and simply leaves the draining to the interval in server.js.
 * @returns {{ deleteUser: (arg: { userId?: string, email?: string, force?: boolean }) => any }}
 */
export function createUserDeletion(deps) {
  const { baseDir, getDataLogDir, forgetEmailOpenState, blobReaper } = deps;
  const db = getDb(baseDir);
  // This module WRITES tombstones and DELETES from the gallery's tables, so it owns
  // making sure both schemas are there rather than depending on the matching factory
  // having been constructed first. Erasure is the one path that cannot be allowed to
  // fail with "no such table", and USER_ID_TABLES prepares its DELETEs unconditionally
  // — that unconditional prepare is what makes a typo'd table name fail loudly instead
  // of being silently skipped, so it is worth keeping. IF NOT EXISTS makes the
  // duplicate exec free, and one exported schema per group means they cannot drift.
  db.exec(BLOB_TOMBSTONE_SCHEMA);
  db.exec(GALLERY_SCHEMA);
  db.exec(API_KEYS_SCHEMA);
  db.exec(API_BILLING_SCHEMA);

  // Statements are prepared on first use, not here: this module spans tables owned by
  // several store factories (memories comes from createMemory, the token tables from
  // session-tokens.js), and preparing up front would make construction ORDER load-
  // bearing — build the deleter before a store and better-sqlite3 throws "no such
  // table" at boot. Lazily, every table exists by the time anyone erases an account.
  /** @type {any} */
  let prepared = null;
  function statements() {
    if (prepared) return prepared;
    prepared = {
      findById: db.prepare('SELECT id, email, stripe_subscription_id FROM users WHERE id = ?'),
      findByEmail: db.prepare('SELECT id, email, stripe_subscription_id FROM users WHERE email = ?'),
      // Prepared FROM the coverage lists, so the statements and the lists cannot drift.
      byId: USER_ID_TABLES.map((t) => ({ ...t, stmt: db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} = ?`) })),
      byEmail: USER_EMAIL_TABLES.map((t) => ({ ...t, stmt: db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} = ?`) })),
      findPending: db.prepare('SELECT email FROM pending_registrations WHERE email = ?'),
      // Tombstone every object this account owns, BEFORE the rows naming those objects
      // are deleted — after the DELETE there is nothing left to read the keys from.
      //
      // Filtered by what actually exists: this module is prepared lazily but the
      // gallery's tables are created by their own store factory, and a deployment that
      // has not opened that store yet (or a test that never touches it) must not fail
      // every erasure with "no such table". A table that appears later is picked up on
      // the next process boot, and the drift test over BLOB_KEYED_TABLES is what keeps
      // the list itself honest.
      tombstone: BLOB_KEYED_TABLES.filter((t) => tableExists(db, t.table)).map((t) => db.prepare(
        `INSERT OR IGNORE INTO blob_tombstones (storage_key, created_at)
         SELECT ${t.column}, ? FROM ${t.table} WHERE ${t.userColumn} = ? AND ${t.column} IS NOT NULL`,
      )),
    };
    // One transaction: an account is either fully gone or still entirely present.
    // Never half-erased, which is the state that produces the orphan rows.
    prepared.purgeRows = db.transaction((userId, email) => {
      /** @type {Record<string, number>} */
      const rows = {};
      // Obligations first, and inside the SAME transaction as the deletes. If the
      // process dies here the account is untouched; if it dies after the commit the
      // rows are gone AND the queue knows what bytes are still owed. There is no
      // ordering in which the bytes are orphaned with nothing recording them.
      const now = Date.now();
      let tombstoned = 0;
      for (const stmt of prepared.tombstone) tombstoned += stmt.run(now, userId).changes;
      if (tombstoned) rows.blob_tombstones = tombstoned;
      for (const t of prepared.byId) rows[t.table] = t.stmt.run(userId).changes;
      for (const t of prepared.byEmail) rows[t.table] = t.stmt.run(email).changes;
      return rows;
    });
    return prepared;
  }

  /** @returns {number} Deletions still owed to the object store, across all accounts. */
  function countTombstones() {
    return /** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM blob_tombstones').get()).n;
  }

  /**
   * Erase one account: its row, every row keyed to it, the identifying cells of its
   * rows in the CSV logs, and its entries in the legacy JSON fallbacks.
   *
   * @param {{ userId?: string, email?: string, force?: boolean }} arg - Identify the
   *   account by id or email. `force` proceeds even when a Stripe subscription is
   *   still attached (see below).
   * @returns {{ ok: boolean, error?: string, code?: string, userId?: string, email?: string,
   *   rows?: Record<string, number>, logs?: any[], blobsPending?: number }} `blobsPending`
   *   is how many object-store deletions are still queued — the honest number, because
   *   the bytes live in someone else's datacentre and this function cannot verify a
   *   completion it did not perform.
   */
  function deleteUser({ userId, email, force = false } = {}) {
    if (!userId && !email) return { ok: false, error: 'A userId or email is required', code: 'NO_IDENTIFIER' };
    const q = statements();
    const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
    // Fall back to the address, do NOT branch on which identifier was supplied.
    // routes/admin.js forwards both fields from the dashboard, so a stale or
    // mistyped id used to mean the email lookup never ran at all and the route
    // answered NOT_FOUND — telling an operator working a right-to-erasure request
    // that the account does not exist while every row, CSV cell and legacy-JSON
    // entry survived. lib/data/pro-grants.js resolves an account the same way.
    let row = userId ? q.findById.get(String(userId)) : null;
    if (!row && normalizedEmail) row = q.findByEmail.get(normalizedEmail);

    if (!row && normalizedEmail && q.findPending.get(normalizedEmail)) {
      // An unverified signup: `pending_registrations` holds a scrypt hash and the
      // address, but no `users` row exists yet, so an id-shaped erasure would answer
      // NOT_FOUND and leave that credential on disk forever (the row only expires if
      // someone retries the flow). Treat the address itself as the subject.
      row = { id: '', email: normalizedEmail, stripe_subscription_id: null };
    }
    if (!row) return { ok: false, error: 'No such user', code: 'NOT_FOUND' };

    // A live subscription outlives the account row: the customer keeps being billed
    // with nothing left to link the charge to, and the webhook that would react to a
    // cancellation can no longer find the user. Cancel in Stripe first. `force` is
    // for the case where that has already been done out of band.
    if (row.stripe_subscription_id && !force) {
      return {
        ok: false,
        code: 'ACTIVE_SUBSCRIPTION',
        error: 'This account still has a Stripe subscription. Cancel it in Stripe first, then retry (or pass force to erase anyway).',
        userId: row.id,
        email: row.email,
      };
    }

    const rows = q.purgeRows(row.id, row.email);

    // Files come after the commit: fs work inside a better-sqlite3 transaction would
    // hold the write lock for the duration, and a failed redaction must not roll the
    // erasure back — the rows are the part that has to be atomic.
    const logDir = getDataLogDir();
    const logs = [];
    /**
     * Run one file's redaction, reporting a failure instead of throwing: the account
     * is already gone from the database and an operator needs to know which file
     * still holds an identifier.
     * @param {string} file - Data-dir-relative filename, for the report.
     * @param {(fullPath: string) => { file: string, present: boolean, matched: number, reason?: string }} run - The redaction.
     */
    const redactFile = (file, run) => {
      try {
        logs.push(run(path.join(logDir, file)));
      } catch (error) {
        logger.error(`[erasure] failed to redact ${file}:`, error);
        logs.push({ file, present: true, matched: 0, error: String(error?.message || error) });
      }
    };

    for (const spec of LOG_REDACTIONS) {
      redactFile(spec.file, (fullPath) =>
        redactCsvFile(fullPath, {
          // An empty id would match every row whose userId cell is blank, so it is
          // filtered out rather than passed through (redactCsvFile drops falsy
          // values too — belt and braces, because the blast radius is every row).
          match: spec.matchOn
            .map((key) =>
              key === 'email'
                ? { column: 'email', value: row.email, caseInsensitive: true }
                : { column: 'userId', value: row.id },
            )
            .filter((m) => m.value),
          redact: spec.redact,
        }),
      );
    }

    // Then the frozen legacy JSON fallbacks. SQLite was imported from these once and
    // has not touched them since, so each still holds the account as it was on import
    // day — the CSV pass above would leave every one of them intact.
    const subject = { userId: row.id, email: row.email };
    for (const spec of JSON_REDACTIONS) {
      redactFile(spec.file, (fullPath) => redactJsonStore(fullPath, spec.scrub, subject));
    }
    // email_opened.json is scrubbed above, but lib/services/email.js keeps that map in
    // memory and rewrites the file wholesale on the next open by ANYONE — which would
    // put the address straight back. Evict it from the live cache too. Optional-called
    // so a factory built without the seam (every existing test) is a no-op.
    forgetEmailOpenState?.(row.email);

    // Kick the object-store deletions the transaction committed an obligation for.
    // Fire and forget, and deliberately AFTER the commit — the same reasoning as the
    // file redactions above: this is network work that must not hold the write lock,
    // and a failure must not roll back an erasure that is already durable.
    //
    // `blobsPending` is what the admin dashboard should report. It is the honest
    // number: "12 objects queued for deletion" rather than a completion this function
    // cannot verify, because the bytes live in someone else's datacentre.
    let blobsPending = 0;
    try {
      blobsPending = countTombstones();
      // Never awaited and cannot reject (see createBlobReaper) — but the extra .catch
      // is belt and braces, because an unhandled rejection in Node 22 exits the process
      // and taking the server down while erasing an account would be a spectacular way
      // to fail a right-to-erasure request.
      if (blobReaper) void blobReaper.drain().catch(() => {});
    } catch (error) {
      logger.error('[erasure] could not start the blob reaper:', error);
    }

    logger.info(
      `[erasure] deleted user ${row.id} — rows: ${JSON.stringify(rows)}; log rows redacted: ${logs.reduce((n, l) => n + (l.matched || 0), 0)}; blobs queued: ${blobsPending}`,
    );
    return { ok: true, userId: row.id, email: row.email, rows, logs, blobsPending };
  }

  return { deleteUser };
}
