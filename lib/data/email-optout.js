// Marketing-email suppression: who has unsubscribed, and the token that let them.
//
// WHY THIS EXISTS. privacy.html §3.6 has promised for a long time that you may
// "opt out of outreach emails at any time by using the unsubscribe link in any such
// email". There was no link and no route — the lifecycle mails in
// lib/services/lifecycle-emails.js carried a footer sentence pointing at the plan
// page, which cancels a subscription rather than stopping mail. A policy that
// names a mechanism has to have one, so this is it.
//
// It covers the TRIAL LIFECYCLE mails only. Verification, password-reset and
// password-changed mail is transactional: it is the answer to something the person
// just did, it cannot be unsubscribed from in any jurisdiction that matters, and
// suppressing it would lock people out of their own accounts. The split is enforced
// by which sender consults this store, not by a flag on the message.
//
// THE TOKEN IS STORED IN PLAINTEXT, unlike sessions and reset tokens, which are
// stored as digests (lib/data/session-tokens.js). Two reasons, and the second is
// the load-bearing one:
//
//   1. A digest cannot be un-digested, so a hash-only table could not put the SAME
//      link in next month's email. The alternatives are both worse: reissue on
//      every send, which breaks the unsubscribe link in every email already in
//      someone's inbox, or accept that the link works once.
//   2. The token is not a credential. Everything it can do is stop email to one
//      address and be undone by the person it belongs to, from the same page. It
//      opens no account, reveals nothing, and spends nothing. gallery-shares.js
//      made the same call for the same kind of token.
//
// The address itself is the sensitive column here, and it is what erasure removes:
// this table is listed in USER_EMAIL_TABLES in lib/data/user-deletion.js, so
// deleting an account takes the suppression row with it. That is the correct
// direction even though suppression lists are normally kept forever — we cannot
// hold someone's email address for the purpose of remembering not to email them,
// after they have asked us to hold nothing at all.

import crypto from 'crypto';
import { getDb } from './db.js';

/** The table, exported so user-deletion.js and its drift test can see the shape. */
export const EMAIL_OPTOUT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS email_optouts (
    email        TEXT    PRIMARY KEY,
    token        TEXT    NOT NULL UNIQUE,
    opted_out_at INTEGER,
    created_at   INTEGER NOT NULL
  )
`;

/** 32 bytes of CSPRNG, base64url — the same shape as every other token here. */
const mintToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Addresses are compared case-insensitively and trimmed, because a person who
 * typed `Name@Example.com` at signup and unsubscribes from a mail addressed to
 * `name@example.com` means the same mailbox both times.
 * @param {unknown} email
 * @returns {string} The normalized address, or '' when there isn't one.
 */
function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * @typedef {object} EmailOptOutStore
 * @property {(email: string) => string | null} tokenFor  Mint-once, stable unsubscribe token.
 * @property {(email: string) => boolean} isOptedOut
 * @property {(token: string) => { ok: boolean, email?: string }} optOutByToken
 * @property {(token: string) => { ok: boolean, email?: string }} optInByToken
 * @property {(email: string) => number} forget  Rows removed; used by erasure.
 */

/**
 * Open the suppression store over the shared connection.
 *
 * Takes `baseDir` like every other store (auth, blog views, memory): lib/data/db.js
 * memoizes its handle per DATA DIR, so getDb() resolves a path before it can return a
 * connection — there is no "the" shared handle to ask for without saying which data dir.
 * @param {string} baseDir  Repo/base dir; resolved to the data dir by db.js.
 * @returns {EmailOptOutStore}
 */
export function createEmailOptOut(baseDir) {
  const db = getDb(baseDir);
  db.exec(EMAIL_OPTOUT_SCHEMA);

  const q = {
    get: db.prepare('SELECT email, token, opted_out_at FROM email_optouts WHERE email = ?'),
    byToken: db.prepare('SELECT email, opted_out_at FROM email_optouts WHERE token = ?'),
    insert: db.prepare(
      'INSERT INTO email_optouts (email, token, opted_out_at, created_at) VALUES (?, ?, NULL, ?)',
    ),
    setOptedOut: db.prepare('UPDATE email_optouts SET opted_out_at = ? WHERE token = ?'),
    del: db.prepare('DELETE FROM email_optouts WHERE email = ?'),
  };

  /**
   * The unsubscribe token for an address, minting a row the first time we mail it.
   *
   * Racing sends for one address would both miss the SELECT and both INSERT, and
   * the second would violate the PRIMARY KEY. The retry re-reads rather than
   * failing: the row the other writer just committed is a perfectly good answer,
   * and the caller wants a token, not a claim to have created one.
   *
   * @param {string} email
   * @returns {string | null} The token, or null for a malformed address.
   */
  function tokenFor(email) {
    const addr = normalize(email);
    if (!addr) return null;
    const row = q.get.get(addr);
    if (row) return row.token;
    const token = mintToken();
    try {
      q.insert.run(addr, token, Date.now());
      return token;
    } catch {
      const raced = q.get.get(addr);
      return raced ? raced.token : null;
    }
  }

  /**
   * @param {string} email
   * @returns {boolean} Whether this address has unsubscribed.
   */
  function isOptedOut(email) {
    const addr = normalize(email);
    if (!addr) return false;
    const row = q.get.get(addr);
    return !!(row && row.opted_out_at);
  }

  /**
   * Honor an unsubscribe link.
   *
   * Idempotent on purpose: mail clients prefetch links, and the one-click POST can
   * arrive more than once. A second call is a success, not a "already done" error
   * the person would read as a failure.
   *
   * @param {string} token
   * @returns {{ ok: boolean, email?: string }}
   */
  function optOutByToken(token) {
    const row = typeof token === 'string' && token ? q.byToken.get(token) : null;
    if (!row) return { ok: false };
    if (!row.opted_out_at) q.setOptedOut.run(Date.now(), token);
    return { ok: true, email: row.email };
  }

  /**
   * The way back, offered on the confirmation page so an accidental click is not
   * a one-way door.
   * @param {string} token
   * @returns {{ ok: boolean, email?: string }}
   */
  function optInByToken(token) {
    const row = typeof token === 'string' && token ? q.byToken.get(token) : null;
    if (!row) return { ok: false };
    if (row.opted_out_at) q.setOptedOut.run(null, token);
    return { ok: true, email: row.email };
  }

  /**
   * Erasure seam. See the header for why the suppression row goes rather than stays.
   * @param {string} email
   * @returns {number} Rows removed.
   */
  function forget(email) {
    const addr = normalize(email);
    if (!addr) return 0;
    return q.del.run(addr).changes;
  }

  return { tokenFor, isOptedOut, optOutByToken, optInByToken, forget };
}
