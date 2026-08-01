// Client share links — the one surface of the Listing Studio that a person WITHOUT a
// Stagify account ever sees.
//
// WHY THIS EXISTS
// Everything else in the Listing Studio is gated on `requireProAccount`: the manifest,
// both byte routes, the archive. That is correct for the broker's workspace, and it makes
// the output unshowable to the two people the output is FOR — the seller who has to
// approve the staging before it goes on the market, and the buyer who scrolls it on a
// phone. Handing those people a zip is not a product. A link is.
//
// SO THE TOKEN IS THE CREDENTIAL, and this module treats it exactly like the bearer
// tokens in session-tokens.js:
//   * 32 bytes of CSPRNG, base64url — not an id, not a slug, not guessable;
//   * hashed with the SAME `hashToken` before it touches disk, so a stolen /data volume
//     or a Litestream restore yields digests, not a set of live links into customers'
//     listings;
//   * returned in plaintext EXACTLY ONCE, from `createShare`. There is no read-back. An
//     owner who loses the link rotates it, which is one statement away.
// The digest is a plain unsalted sha256 for the same reason it is there: the input is
// already 32 bytes of entropy, and the lookup has to stay deterministic.
//
// REVOCATION IS A READ-TIME CHECK, NOT A DELETE. A revoked or expired share keeps its
// row: the broker wants to see that the link they sent the seller in March was opened 14
// times before they killed it. `resolveShare` is therefore the ONLY way the public routes
// may reach a share, and it answers with a reason code the caller is expected to flatten
// into one 404 (see routes/share-public.js) so the surface cannot be used to sort real
// tokens from junk.
//
// NO FOREIGN KEYS, same standing rule as the rest of this database (lib/data/db.js,
// pinned by test/data/db.test.js). `project_shares` is therefore listed EXPLICITLY in
// three cascades — `deleteProject` and `deleteProjectsForUser` in lib/data/projects.js,
// and PROJECT_CHILD_TABLES in lib/data/user-deletion.js. A share that outlives its
// listing is not a dangling row, it is a live URL into deleted data, so the erasure test
// covering it is load-bearing rather than tidy.
//
// `user_id` IS DENORMALIZED onto the row on purpose. It is redundant with
// `projects.user_id`, and it is what lets the GDPR drift guard SEE this table: that guard
// finds user-keyed tables by looking for a `user_id`/`email` column, and the other three
// project children (photos, bibles, renders) are invisible to it precisely because they
// have none. One column removes this table from that blind spot.
import crypto from 'crypto';
import { getDb } from './db.js';
import { hashToken } from './session-tokens.js';
import { logger } from '../logger.js';

/** @typedef {import('../types/projects.js').ProjectShare} ProjectShare */
/** @typedef {import('../types/projects.js').ShareSettings} ShareSettings */

/**
 * Token entropy, in bytes. 32 matches the session/reset tokens: base64url-encoded it is
 * 43 characters, which is short enough to sit in a text message and far past any
 * brute-force worth rate-limiting.
 */
export const SHARE_TOKEN_BYTES = 32;

/**
 * Views are counted at most once per token per window, so a buyer scrolling a 40-photo
 * gallery (which fetches the manifest once but may re-open the tab all afternoon) reads
 * as the one visit it is. Coarse on purpose: this is a "was it opened" signal for the
 * broker, not analytics.
 */
export const VIEW_DEBOUNCE_MS = 30 * 60 * 1000;

const MAX_HEADLINE = 120;
const MAX_NOTE = 600;
const MAX_CONTACT = 120;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_shares (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    view_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at INTEGER,
    settings_json TEXT
  );
  -- The public lookup, and the guarantee that two shares cannot collide on one digest.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_token ON project_shares (token_hash);
  -- "the active share for this listing", the only owner-side query.
  CREATE INDEX IF NOT EXISTS idx_shares_project ON project_shares (project_id, created_at DESC);
  -- Account erasure sweeps by user, without a join back to projects.
  CREATE INDEX IF NOT EXISTS idx_shares_user ON project_shares (user_id);
`;

/**
 * Clamp a caller-supplied string to a trimmed maximum.
 * @param {unknown} value - Raw field.
 * @param {number} max - Maximum characters kept.
 * @returns {string} The clamped string; '' when the field was not a string.
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
 * `showBefore` defaults to TRUE. The before/after pair is the entire persuasive point of
 * the page for a seller deciding whether to stage — defaulting it off would make the
 * common case require a settings trip.
 * @param {unknown} raw - Caller-supplied settings bag.
 * @returns {ShareSettings} The normalized settings.
 */
export function normalizeShareSettings(raw) {
  const bag = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    showBefore: bag.showBefore === undefined ? true : bag.showBefore === true || bag.showBefore === 'true',
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
 * Open the share store against the shared application database.
 *
 * Takes the same `baseDir` as the other stores so rows land on one volume. `now` is
 * injectable at every mutator, matching lib/data/projects.js, so expiry and the view
 * debounce are testable without sleeping.
 * @param {string} baseDir - Repo/base dir, resolved to the data dir by db.js.
 */
export function createProjectShares(baseDir) {
  const db = getDb(baseDir);
  db.exec(SCHEMA);

  const q = {
    insert: db.prepare(`INSERT INTO project_shares
      (id, project_id, user_id, token_hash, created_at, expires_at, revoked_at, view_count, last_viewed_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?) RETURNING *`),
    byToken: db.prepare('SELECT * FROM project_shares WHERE token_hash = ?'),
    byId: db.prepare('SELECT * FROM project_shares WHERE id = ?'),
    activeForProject: db.prepare('SELECT * FROM project_shares WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    listForProject: db.prepare('SELECT * FROM project_shares WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'),
    revokeForProject: db.prepare('UPDATE project_shares SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL'),
    revokeById: db.prepare('UPDATE project_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    patchSettings: db.prepare('UPDATE project_shares SET settings_json = ?, expires_at = ? WHERE id = ? RETURNING *'),
    countView: db.prepare('UPDATE project_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?'),
    delForProject: db.prepare('DELETE FROM project_shares WHERE project_id = ?'),
    delForUser: db.prepare('DELETE FROM project_shares WHERE user_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM project_shares'),
  };

  const withTxn = db.transaction((/** @type {() => any} */ fn) => fn());

  /**
   * Row → API shape. The token digest is NEVER mapped out: nothing downstream has a use
   * for it, and a shape that carries it is one `res.json` away from publishing it.
   * @param {any} row - Raw better-sqlite3 row.
   * @returns {ProjectShare | null} The mapped share.
   */
  function rowToShare(row) {
    if (!row) return null;
    let settings;
    try {
      settings = normalizeShareSettings(row.settings_json ? JSON.parse(row.settings_json) : null);
    } catch (e) {
      // A corrupt bag degrades to defaults rather than throwing: the link still works,
      // it just shows the un-customized page. Losing a headline beats a 500 on a URL
      // the broker has already texted to their client.
      logger.warn(`[shares] unparseable settings_json for ${row.id}:`, e && e.message ? e.message : e);
      settings = normalizeShareSettings(null);
    }
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? null,
      revokedAt: row.revoked_at ?? null,
      viewCount: row.view_count || 0,
      lastViewedAt: row.last_viewed_at ?? null,
      settings,
    };
  }

  /**
   * Mint a share link for a listing, revoking whatever link that listing had.
   *
   * ONE LIVE LINK PER LISTING, enforced here rather than by a unique index, because the
   * revoked rows have to stay (see the header). Rotating is therefore the same call as
   * creating — which is the behaviour an owner wants from a "the seller forwarded it to
   * the whole street" button, and it happens in ONE transaction so there is no instant
   * where a listing has two live links.
   *
   * The plaintext token comes back HERE AND NOWHERE ELSE.
   * @param {{ projectId?: string, userId?: string, settings?: unknown, expiresAt?: number|null, now?: number }} [arg]
   * @returns {{ share: ProjectShare, token: string, replaced: number }} The row, its one-time token, and how many links were rotated out.
   */
  function createShare(arg = {}) {
    const projectId = String(arg.projectId || '');
    const userId = String(arg.userId || '');
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    const token = newShareToken();
    const expiresAt = typeof arg.expiresAt === 'number' && Number.isFinite(arg.expiresAt) ? arg.expiresAt : null;
    const settings = normalizeShareSettings(arg.settings);
    return withTxn(() => {
      const replaced = q.revokeForProject.run(now, projectId).changes;
      const row = q.insert.get(
        crypto.randomBytes(16).toString('hex'), projectId, userId, hashToken(token),
        now, expiresAt, JSON.stringify(settings),
      );
      return { share: /** @type {ProjectShare} */ (rowToShare(row)), token, replaced };
    });
  }

  /**
   * The live link for a listing, or null when it has never had one (or the last was
   * revoked). Never carries a token — see `createShare`.
   * @param {string} projectId - Listing id.
   * @returns {ProjectShare | null} The active share.
   */
  const activeShareFor = (projectId) => rowToShare(q.activeForProject.get(String(projectId)));

  /**
   * Every share a listing has ever had, newest first — the owner's audit trail.
   * @param {string} projectId - Listing id.
   * @param {number} [limit] - Rows to return.
   * @returns {ProjectShare[]} Shares, including revoked and expired ones.
   */
  const listSharesFor = (projectId, limit = 20) =>
    q.listForProject.all(String(projectId), Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(rowToShare)
      .filter(/** @returns {s is ProjectShare} */ (s) => s !== null);

  /**
   * Resolve a PUBLIC token to its share, or say why not.
   *
   * The single door the unauthenticated surface may use. Callers must flatten every
   * rejection to one indistinguishable 404: telling a caller that a token is REVOKED
   * rather than NOT_FOUND confirms the token was once real, which is a slow oracle over
   * a keyspace we otherwise never leak.
   * @param {string} token - The raw token from the URL.
   * @param {number} [now] - Clock, injectable.
   * @returns {{ ok: true, share: ProjectShare } | { ok: false, code: 'NOT_FOUND'|'REVOKED'|'EXPIRED' }}
   */
  function resolveShare(token, now = Date.now()) {
    const raw = String(token ?? '');
    // Hash first, compare never: the lookup is by digest, so an empty or malformed token
    // simply misses the unique index rather than needing its own validation branch.
    if (!raw) return { ok: false, code: 'NOT_FOUND' };
    const share = rowToShare(q.byToken.get(hashToken(raw)));
    if (!share) return { ok: false, code: 'NOT_FOUND' };
    if (share.revokedAt) return { ok: false, code: 'REVOKED' };
    if (share.expiresAt != null && share.expiresAt <= now) return { ok: false, code: 'EXPIRED' };
    return { ok: true, share };
  }

  /**
   * Revoke a listing's live link. Idempotent: revoking twice reports 0 the second time
   * rather than failing, so a double-clicked "disable" button is not an error.
   * @param {string} projectId - Listing id.
   * @param {number} [now] - Clock, injectable.
   * @returns {number} Links revoked.
   */
  const revokeSharesFor = (projectId, now = Date.now()) => q.revokeForProject.run(now, String(projectId)).changes;

  /**
   * Revoke one specific share by id — what the audit list's per-row control uses.
   * @param {string} id - Share id.
   * @param {number} [now] - Clock, injectable.
   * @returns {number} 1 when it was live, 0 when it was already revoked or absent.
   */
  const revokeShare = (id, now = Date.now()) => q.revokeById.run(now, String(id)).changes;

  /**
   * Update a live share's presentation settings and/or expiry, WITHOUT rotating the
   * token — the link the broker already sent keeps working.
   *
   * Settings are replaced wholesale from the normalized bag rather than merged, because
   * a merge cannot express "clear the headline": the client sends the full state it wants.
   *
   * `expiresAt` is the opposite — it is only touched when the key is PRESENT. Settings
   * and expiry arrive from two different controls, and a settings save that silently
   * cleared the expiry date would quietly un-expire a link the owner had time-boxed.
   * `null` means "no expiry"; omitting the key means "leave it".
   * @param {string} id - Share id.
   * @param {{ settings?: unknown, expiresAt?: number|null }} [patch] - New settings, and optionally a new expiry.
   * @returns {ProjectShare | null} The updated share, or null when there is no such row.
   */
  function updateShare(id, patch = {}) {
    const current = q.byId.get(String(id));
    if (!current) return null;
    const settings = normalizeShareSettings(patch.settings);
    const hasExpiry = Object.prototype.hasOwnProperty.call(patch, 'expiresAt');
    const expiresAt = !hasExpiry ? (current.expires_at ?? null)
      : (typeof patch.expiresAt === 'number' && Number.isFinite(patch.expiresAt) ? patch.expiresAt : null);
    return rowToShare(q.patchSettings.get(JSON.stringify(settings), expiresAt, String(id)));
  }

  /**
   * Count one visit, at most once per VIEW_DEBOUNCE_MS.
   *
   * Debounced against `last_viewed_at` rather than a session cookie: the page is
   * deliberately cookie-free (it is shown to people who never consented to anything), so
   * the row's own clock is the only state available. That makes the count a lower bound
   * on distinct visits, which is the honest direction for it to be wrong in.
   * @param {string} id - Share id.
   * @param {number} [now] - Clock, injectable.
   * @param {number|null} [lastViewedAt] - The share's current `lastViewedAt`.
   * @returns {boolean} Whether this call actually counted.
   */
  function recordView(id, now = Date.now(), lastViewedAt = null) {
    if (lastViewedAt != null && now - lastViewedAt < VIEW_DEBOUNCE_MS) return false;
    return q.countView.run(now, String(id)).changes > 0;
  }

  /**
   * Drop every share of one listing — called from `deleteProject`'s cascade in
   * lib/data/projects.js, inside that transaction.
   * @param {string} projectId - Listing id.
   * @returns {number} Rows removed.
   */
  const deleteForProject = (projectId) => q.delForProject.run(String(projectId)).changes;

  /**
   * Drop every share of one account — the erasure sweep's belt-and-braces pass, matching
   * `deleteProjectsForUser`.
   * @param {string} userId - Account id.
   * @returns {number} Rows removed.
   */
  const deleteForUser = (userId) => q.delForUser.run(String(userId)).changes;

  /** @returns {number} Total share rows, for the admin counters and the tests. */
  const count = () => {
    const row = q.count.get();
    return row && typeof row.n === 'number' ? row.n : 0;
  };

  return {
    createShare, activeShareFor, listSharesFor, resolveShare,
    revokeShare, revokeSharesFor, updateShare, recordView,
    deleteForProject, deleteForUser, count,
  };
}
