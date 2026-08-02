// lib/data/gallery-shares.js — the token that lets a buyer see a staged room.
//
// This is the only unauthenticated read surface the gallery has, so the tests that
// matter are about what the token IS (a bearer credential, hashed at rest, handed out
// once) and about resolveShare refusing in a way that cannot be used to sort real tokens
// from junk.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeDb } from '../../lib/data/db.js';
import { createGalleryShares, newShareToken, normalizeShareSettings, VIEW_DEBOUNCE_MS } from '../../lib/data/gallery-shares.js';
import { hashToken } from '../../lib/data/session-tokens.js';

const dirs = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-shares-'));
  dirs.push(dir);
  return { dir, db: getDb(dir), shares: createGalleryShares(dir) };
}

const RENDER = '0123456789abcdef0123456789abcdef';
const USER = 'user-1';

test('a token is CSPRNG, base64url, and one path segment', () => {
  const tokens = new Set(Array.from({ length: 200 }, newShareToken));
  assert.equal(tokens.size, 200, 'no repeats');
  for (const t of tokens) {
    assert.match(t, /^[A-Za-z0-9_-]{43}$/, 'base64url, 32 bytes, nothing needing escaping');
    assert.equal(encodeURIComponent(t), t, 'survives a URL untouched');
  }
});

test('the plaintext token NEVER reaches disk', () => {
  // A stolen /data volume or a Litestream restore must yield digests, not a set of live
  // links into customers' homes.
  const { db, shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER });

  const rows = db.prepare('SELECT * FROM gallery_shares').all();
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(token), 'the raw token must not appear anywhere in the row');
  assert.equal(rows[0].token_hash, hashToken(token));
});

test('the token is returned exactly once and never read back', () => {
  const { shares } = setup();
  const { token, share } = shares.createShare({ renderId: RENDER, userId: USER });
  assert.ok(token);
  // Neither the create result nor any later read may carry it — a shape that holds the
  // token is one res.json away from publishing it.
  assert.ok(!('token' in share));
  assert.ok(!('tokenHash' in share));
  const active = shares.activeForRender(RENDER);
  assert.ok(!('token' in active) && !('tokenHash' in active));
});

test('resolving works, and counts as the same share', () => {
  const { shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER });
  const res = shares.resolveShare(token);
  assert.equal(res.ok, true);
  assert.equal(res.share.renderId, RENDER);
  assert.equal(res.share.userId, USER);
});

test('rotating replaces the live link in ONE transaction', () => {
  // There must be no instant where a render has two live links or none.
  const { shares } = setup();
  const first = shares.createShare({ renderId: RENDER, userId: USER, now: 1_000 });
  const second = shares.createShare({ renderId: RENDER, userId: USER, now: 2_000 });

  assert.notEqual(first.token, second.token);
  assert.equal(shares.resolveShare(first.token).ok, false, 'the old link is dead');
  assert.equal(shares.resolveShare(second.token).ok, true);
  assert.equal(shares.activeForRender(RENDER).createdAt, 2_000, 'exactly one live link');
});

test('a revoked share keeps its row, so the view count survives', () => {
  // The agent wants to see that the link they sent in March was opened before they
  // killed it. Revocation is a read-time check, not a delete.
  const { db, shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER, now: 1_000 });
  shares.recordView(token, 2_000);
  assert.equal(shares.revoke(RENDER, 3_000), true);

  assert.equal(shares.resolveShare(token).ok, false);
  const row = db.prepare('SELECT * FROM gallery_shares').get();
  assert.equal(row.view_count, 1, 'the history outlives the link');
  assert.equal(row.revoked_at, 3_000);
});

test('revoke is idempotent', () => {
  const { shares } = setup();
  shares.createShare({ renderId: RENDER, userId: USER });
  assert.equal(shares.revoke(RENDER), true);
  assert.equal(shares.revoke(RENDER), false, 'nothing live left to kill');
});

test('every refusal is reported, so the route can flatten them into ONE 404', () => {
  // A surface that answers differently for "revoked" and "never existed" sorts real
  // tokens from junk for anyone who asks it enough times.
  const { shares } = setup();
  assert.deepEqual(shares.resolveShare('not-a-real-token'), { ok: false, reason: 'unknown' });

  const revoked = shares.createShare({ renderId: RENDER, userId: USER });
  shares.revoke(RENDER);
  assert.deepEqual(shares.resolveShare(revoked.token), { ok: false, reason: 'revoked' });

  const expiring = shares.createShare({ renderId: 'f'.repeat(32), userId: USER, expiresAt: 5_000 });
  assert.equal(shares.resolveShare(expiring.token, 4_999).ok, true);
  assert.deepEqual(shares.resolveShare(expiring.token, 5_000), { ok: false, reason: 'expired' });
});

test('resolving junk never throws', () => {
  const { shares } = setup();
  for (const junk of [null, undefined, '', 42, {}, [], '../../etc/passwd', 'a'.repeat(5000)]) {
    assert.doesNotThrow(() => shares.resolveShare(/** @type {any} */ (junk)));
    assert.equal(shares.resolveShare(/** @type {any} */ (junk)).ok, false);
  }
});

test('an expired share is not "active" for its owner either', () => {
  const { shares } = setup();
  shares.createShare({ renderId: RENDER, userId: USER, expiresAt: 5_000 });
  assert.ok(shares.activeForRender(RENDER, 4_999));
  assert.equal(shares.activeForRender(RENDER, 5_001), null);
});

// ---- settings ---------------------------------------------------------------------

test('settings are an ALLOWLIST, so a future owner-side field cannot leak', () => {
  const out = normalizeShareSettings({
    headline: 'Staged living room',
    note: 'Let me know what you think',
    agentName: 'A. Broker',
    agentEmail: 'a@example.com',
    agentPhone: '+1 555 0100',
    // Everything below is dropped rather than stored.
    internalNotes: 'seller is desperate',
    userId: 'someone-else',
    showBefore: true,
  });
  assert.deepEqual(Object.keys(out).sort(), ['agentEmail', 'agentName', 'agentPhone', 'headline', 'note']);
  assert.ok(!('showBefore' in out), 'the share page never shows the source photo, so the key must not exist');
});

test('settings are clamped and trimmed', () => {
  const out = normalizeShareSettings({ headline: `  ${'x'.repeat(500)}  `, note: 42, agentName: null });
  assert.equal(out.headline.length, 120);
  assert.equal(out.note, '', 'a non-string is dropped, not coerced');
  assert.equal(out.agentName, '');
});

test('updating settings does NOT rotate the link', () => {
  // An agent fixing a typo in their own phone number must not invalidate the link they
  // already sent to a client.
  const { shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER, settings: { headline: 'first' } });
  const updated = shares.updateSettings({ renderId: RENDER, settings: { headline: 'second' } });

  assert.equal(updated.settings.headline, 'second');
  assert.equal(shares.resolveShare(token).ok, true, 'the same link still works');
  assert.equal(shares.resolveShare(token).share.settings.headline, 'second');
});

test('corrupt settings degrade to defaults rather than 500ing a live link', () => {
  const { db, shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER });
  db.prepare('UPDATE gallery_shares SET settings_json = ?').run('{not json at all');

  const res = shares.resolveShare(token);
  assert.equal(res.ok, true, 'losing a headline beats a 500 on a URL already texted to a client');
  assert.equal(res.share.settings.headline, '');
});

// ---- view counting ----------------------------------------------------------------

test('views are debounced, so a tab left open is one visit', () => {
  const { db, shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER, now: 0 });

  shares.recordView(token, 1_000);
  shares.recordView(token, 2_000);
  shares.recordView(token, 1_000 + VIEW_DEBOUNCE_MS - 1);
  assert.equal(db.prepare('SELECT view_count AS n FROM gallery_shares').get().n, 1);

  shares.recordView(token, 1_000 + VIEW_DEBOUNCE_MS);
  assert.equal(db.prepare('SELECT view_count AS n FROM gallery_shares').get().n, 2);
});

test('a revoked link records no further views', () => {
  const { db, shares } = setup();
  const { token } = shares.createShare({ renderId: RENDER, userId: USER, now: 0 });
  shares.revoke(RENDER, 1_000);
  shares.recordView(token, 2_000);
  assert.equal(db.prepare('SELECT view_count AS n FROM gallery_shares').get().n, 0);
});

test('recording a view for junk never throws', () => {
  const { shares } = setup();
  for (const junk of [null, undefined, '', 'nope']) {
    assert.doesNotThrow(() => shares.recordView(/** @type {any} */ (junk)));
  }
});
