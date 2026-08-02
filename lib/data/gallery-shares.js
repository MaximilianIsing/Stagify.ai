// Client share links — the one surface of the gallery a person WITHOUT a Stagify
// account ever sees.
//
// Adapted from lib/data/project-shares.js on origin/experimental/listing-studio. The
// security posture is harvested verbatim; the subject changed from a listing to a single
// staged render, and `showBefore` is gone (see below).
//
// WHY THIS EXISTS
// Everything else in the gallery is gated on the session. That is right for the agent's
// own history, and it makes the output unshowable to the people the output is FOR — the
// seller deciding whether to stage, and the buyer scrolling it on a phone. Emailing a
// WebP is not a product. A link is, and it is the only thing here that travels.
//
// SO THE TOKEN IS THE CREDENTIAL, treated exactly like the bearer tokens in
// session-tokens.js:
//   * 32 bytes of CSPRNG, base64url — not an id, not a slug, not guessable;
//   * hashed with the SAME `hashToken` before it touches disk, so a stolen /data volume
//     or a Litestream restore yields digests, not a set of live links into customers'
//     homes;
//   * returned in plaintext EXACTLY ONCE, from `createShare`. There is no read-back. An
//     owner who loses the link rotates it, which is the same call.
//
// REVOCATION IS A READ-TIME CHECK, NOT A DELETE. A revoked or expired share keeps its
// row, because the agent wants to see that the link they sent in March was opened
// fourteen times before they killed it. `resolveShare` is therefore the ONLY way the
// public route may reach a share, and it answers with a reason code the caller is
// expected to flatten into one identical 404 — a surface that distinguishes "revoked"
// from "never existed" sorts real tokens from junk for anyone who asks it enough times.
//
// AND REVOCATION IS EVENTUAL FOR BYTES. Revoking stops NEW presigned URLs being minted
// immediately, but one already handed out keeps working until it expires — at most the
// TTL in lib/data/object-store-r2.js. Any UI copy that says "immediately" is wrong. The
// hard revoke is deleting the entry, because a presigned URL to a deleted object 404s
// however valid its signature is.
//
// THERE IS NO `showBefore` SETTING, deliberately. The parked module had one, defaulting
// true. Here the share page never shows the source photograph at all: the owner sees
// before/after in their own private gallery, and the public link shows the staged result
// only. A settings key that can never be true is a trap for whoever reads this next, so
// it is absent rather than hardcoded false.
//
// `user_id` IS DENORMALIZED onto the row on purpose — it is redundant with
// staged_renders.user_id, and it is what lets the GDPR drift guard SEE this table.
import crypto from 'crypto';
import { getDb } from './db.js';
import { GALLERY_SCHEMA } from './gallery-schema.js';
import { hashToken } from './session-tokens.js';
import { logger } from '../logger.js';

/**
 * Token entropy, in bytes. 32 matches the session/reset tokens: base64url-encoded it is
 * 43 characters, short enough to sit in a text message and far past any brute force
 * worth rate-limiting.
 */
export const SHARE_TOKEN_BYTES = 32;

/**
 * Views are counted at most once per token per window, so a buyer who leaves the tab
 * open all afternoon reads as the one visit it is. Coarse on purpose: this is a "was it
 * opened" signal for the agent, not analytics.
 */
export const VIEW_DEBOUNCE_MS = 30 * 60 * 1000;

const MAX_HEADLINE = 120;
const MAX_NOTE = 600;
const MAX_CONTACT = 120;

/**
 * Clamp a caller-supplied string to a trimmed maximum.
 * @param {unknown} value @param {number} max @returns {string} '' when not a string.
 */
function clamp(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Normalize the presentation settings an owner may attach to a share.
 *
 * Everything here is published to anyone holding the link, so it is an ALLOWLIST: an
 * unknown key is dropped rather than stored, which is what stops a future owner-side
 * field from leaking through this surface by accident.
 *
 * @param {unknown} raw @returns {{ headline: string, note: string, agentName: string,
 *   agentEmail: string, agentPhone: string }}
 */
export function normalizeShareSettings(raw) {
  const bag = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    headline: clamp(bag.headline, MAX_HEADLINE),
    note: clamp(bag.note, MAX_NOTE),
    agentName: clamp(bag.agentName, MAX_CONTACT),
    agentEmail: clamp(bag.agentEmail, MAX_CONTACT),
    agentPhone: clamp(bag.agentPhone, MAX_CONTACT),
  };
}

/**
 * A fresh share token. base64url so it is one path segment with no escaping.
 * @returns {string} 43 characters of CSPRNG.
 */
export function newShareToken() {
  return crypto.randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

/**
 * Open the share store.
 * @param {string} baseDir - Handed to getDb, as every store in lib/data does.
 */
export function createGalleryShares(baseDir) {
  const db = getDb(baseDir);
  db.exec(GALLERY_SCHEMA);

  const q = {
    insert: db.prepare(`INSERT INTO gallery_shares
      (token_hash, render_id, user_id, created_at, expires_at, revoked_at, view_count, last_viewed_at, settings_json)
      VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?)`),
    byToken: db.prepare('SELECT * FROM gallery_shares WHERE token_hash = ?'),
    activeForRender: db.prepare(
      'SELECT * FROM gallery_shares WHERE render_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ),
    revokeForRender: db.prepare('UPDATE gallery_shares SET revoked_at = ? WHERE render_id = ? AND revoked_at IS NULL'),
    patchSettings: db.prepare(
      'UPDATE gallery_shares SET settings_json = ?, expires_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    ),
    countView: db.prepare('UPDATE gallery_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE token_hash = ?'),
  };

  /**
   * Row → API shape. The token digest is NEVER mapped out: nothing downstream has a use
   * for it, and a shape that carries it is one `res.json` away from publishing it.
   * @param {any} row @returns {any}
   */
  function rowToShare(row) {
    if (!row) return null;
    let settings;
    try {
      settings = normalizeShareSettings(row.settings_json ? JSON.parse(row.settings_json) : null);
    } catch (e) {
      // A corrupt bag degrades to defaults rather than throwing: the link still works, it
      // just shows the un-customized page. Losing a headline beats a 500 on a URL the
      // agent has already texted to their client.
      logger.warn('[shares] unparseable settings_json:', e);
      settings = normalizeShareSettings(null);
    }
    return {
      renderId: row.render_id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? null,
      revokedAt: row.revoked_at ?? null,
      viewCount: row.view_count || 0,
      lastViewedAt: row.last_viewed_at ?? null,
      settings,
    };
  }

  return {
    VIEW_DEBOUNCE_MS,

    /**
     * Mint a link for one render, revoking whatever link that render had.
     *
     * ONE LIVE LINK PER RENDER, enforced here rather than by a unique index because the
     * revoked rows have to stay. Rotating is therefore the same call as creating — which
     * is what an owner wants from a "the seller forwarded it to the whole street" button
     * — and it happens in ONE transaction, so there is no instant where a render has two
     * live links or none.
     *
     * @param {{ renderId: string, userId: string, settings?: any, expiresAt?: number | null,
     *   now?: number }} arg
     * @returns {{ token: string, share: any }} The plaintext token, returned ONCE.
     */
    createShare({ renderId, userId, settings, expiresAt = null, now = Date.now() }) {
      const token = newShareToken();
      const tokenHash = hashToken(token);
      const share = db.transaction(() => {
        q.revokeForRender.run(now, renderId);
        q.insert.run(
          tokenHash, renderId, userId, now, expiresAt,
          JSON.stringify(normalizeShareSettings(settings)),
        );
        return rowToShare(q.byToken.get(tokenHash));
      })();
      return { token, share };
    },

    /**
     * The live link for one render, or null. Never exposes the token — an owner who lost
     * it rotates.
     * @param {string} renderId @param {number} [now]
     * @returns {any} The share, or null when there is no live one.
     */
    activeForRender(renderId, now = Date.now()) {
      const row = /** @type {any} */ (q.activeForRender.get(renderId));
      if (!row) return null;
      if (row.expires_at && row.expires_at <= now) return null;
      return rowToShare(row);
    },

    /**
     * Resolve a public token.
     *
     * Returns a REASON so the caller can log or branch internally, but the caller is
     * expected to flatten every failure into one identical 404 — see routes/share-public.js.
     * @param {string} token - Raw token from the URL.
     * @param {number} [now]
     * @returns {{ ok: true, share: any } | { ok: false, reason: 'unknown' | 'revoked' | 'expired' }}
     */
    resolveShare(token, now = Date.now()) {
      const row = /** @type {any} */ (q.byToken.get(hashToken(String(token ?? ''))));
      if (!row) return { ok: false, reason: 'unknown' };
      if (row.revoked_at) return { ok: false, reason: 'revoked' };
      if (row.expires_at && row.expires_at <= now) return { ok: false, reason: 'expired' };
      return { ok: true, share: rowToShare(row) };
    },

    /**
     * Update a live link's presentation without rotating it — the agent fixing a typo in
     * their own phone number must not invalidate the link they already sent.
     * @param {{ renderId: string, settings?: any, expiresAt?: number | null, now?: number }} arg
     * @returns {any} The updated share, or null when there is no live link.
     */
    updateSettings({ renderId, settings, expiresAt = null, now = Date.now() }) {
      const row = /** @type {any} */ (q.activeForRender.get(renderId));
      if (!row) return null;
      q.patchSettings.run(JSON.stringify(normalizeShareSettings(settings)), expiresAt, row.token_hash);
      void now;
      return rowToShare(q.byToken.get(row.token_hash));
    },

    /**
     * Revoke whatever live link a render has. Idempotent — revoking twice is a no-op, and
     * "make sure this link is dead" is what every caller actually wants.
     * @param {string} renderId @param {number} [now] @returns {boolean} True when a live link was killed.
     */
    revoke(renderId, now = Date.now()) {
      return q.revokeForRender.run(now, renderId).changes > 0;
    },

    /**
     * Count a view, at most once per debounce window.
     * @param {string} token - Raw token. @param {number} [now]
     */
    recordView(token, now = Date.now()) {
      const tokenHash = hashToken(String(token ?? ''));
      const row = /** @type {any} */ (q.byToken.get(tokenHash));
      if (!row || row.revoked_at) return;
      if (row.last_viewed_at && now - row.last_viewed_at < VIEW_DEBOUNCE_MS) return;
      q.countView.run(now, tokenHash);
    },
  };
}
