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
// Beyond SQLite, the CSV logs hold the same person's email/id — erasure redacts
// those cells rather than dropping the rows (see csv-redaction.js for why).
import path from 'path';
import { getDb } from './db.js';
import { redactCsvFile } from './csv-redaction.js';
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
];

/**
 * Build the erasure helper bound to a data directory.
 *
 * @param {{ baseDir: string, getDataLogDir: () => string }} deps - The base dir the
 *   shared SQLite connection is resolved against, and the directory the CSV logs
 *   live in (injected rather than re-derived — same rule as everything else that
 *   touches the data dir).
 * @returns {{ deleteUser: (arg: { userId?: string, email?: string, force?: boolean }) => any }}
 */
export function createUserDeletion(deps) {
  const { baseDir, getDataLogDir } = deps;
  const db = getDb(baseDir);

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
    };
    // One transaction: an account is either fully gone or still entirely present.
    // Never half-erased, which is the state that produces the orphan rows.
    prepared.purgeRows = db.transaction((userId, email) => {
      /** @type {Record<string, number>} */
      const rows = {};
      for (const t of prepared.byId) rows[t.table] = t.stmt.run(userId).changes;
      for (const t of prepared.byEmail) rows[t.table] = t.stmt.run(email).changes;
      return rows;
    });
    return prepared;
  }

  /**
   * Erase one account: its row, every row keyed to it, and the identifying cells of
   * its rows in the CSV logs.
   *
   * @param {{ userId?: string, email?: string, force?: boolean }} arg - Identify the
   *   account by id or email. `force` proceeds even when a Stripe subscription is
   *   still attached (see below).
   * @returns {{ ok: boolean, error?: string, code?: string, userId?: string, email?: string,
   *   rows?: Record<string, number>, logs?: any[] }}
   */
  function deleteUser({ userId, email, force = false } = {}) {
    if (!userId && !email) return { ok: false, error: 'A userId or email is required', code: 'NO_IDENTIFIER' };
    const q = statements();
    const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
    let row = userId ? q.findById.get(String(userId)) : q.findByEmail.get(normalizedEmail);

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
    for (const spec of LOG_REDACTIONS) {
      try {
        logs.push(
          redactCsvFile(path.join(logDir, spec.file), {
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
      } catch (error) {
        // Report it, don't throw: the account is already gone from the database and
        // an operator needs to know which file still holds an identifier.
        logger.error(`[erasure] failed to redact ${spec.file}:`, error);
        logs.push({ file: spec.file, present: true, matched: 0, error: String(error?.message || error) });
      }
    }

    logger.info(
      `[erasure] deleted user ${row.id} — rows: ${JSON.stringify(rows)}; log rows redacted: ${logs.reduce((n, l) => n + (l.matched || 0), 0)}`,
    );
    return { ok: true, userId: row.id, email: row.email, rows, logs };
  }

  return { deleteUser };
}
