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

test('the token IS stored, deliberately, and the digest stays the lookup key', () => {
  // This reverses the module's original posture and is pinned so the reversal stays a
  // decision rather than a drift. A share link is one-per-render and permanent, and the
  // owner must be able to reopen the gallery next week and copy the link they already
  // sent — which a write-only credential cannot do. See the header of gallery-shares.js
  // for what it costs. The DIGEST still has to be the primary key, or resolveShare would
  // be scanning plaintext.
  const { db, shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER });

  const row = /** @type {any} */ (db.prepare('SELECT * FROM gallery_shares').get());
  assert.equal(row.token_plain, token, 'the owner has to be able to read this back');
  assert.equal(row.token_hash, hashToken(token), 'and lookup still goes through the digest');
  assert.notEqual(row.token_hash, row.token_plain);
});

test('session tokens are NOT in the same class — they stay digest-only', () => {
  // The reason this file may store plaintext and session-tokens.js may not: these tokens
  // authenticate nothing. Guarding it here so "the gallery does it" never becomes an
  // argument for doing it to credentials that are account takeover.
  const src = fs.readFileSync(new URL('../../lib/data/session-tokens.js', import.meta.url), 'utf8');
  assert.ok(!/token_plain|plaintext_token/.test(src), 'session/reset tokens must never gain a plaintext column');
});

test('the live share carries its token, so the owner can see the link again', () => {
  const { shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER });

  const active = shares.activeForRender(RENDER);
  assert.equal(active.token, token, 'reopening the gallery must show the same link');
  assert.ok(!('tokenHash' in active), 'the digest is still never mapped out');
});

test('resolving works, and counts as the same share', () => {
  const { shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER });
  const res = shares.resolveShare(token);
  assert.equal(res.ok, true);
  assert.equal(res.share.renderId, RENDER);
  assert.equal(res.share.userId, USER);
});

test('asking twice returns the SAME link rather than replacing it', () => {
  // This used to rotate, which meant the button that created a link was also the button
  // that invalidated one the owner had already texted to somebody. A render has one link
  // for its lifetime.
  const { shares } = setup();
  const first = shares.ensureShare({ renderId: RENDER, userId: USER, now: 1_000 });
  const second = shares.ensureShare({ renderId: RENDER, userId: USER, now: 2_000 });

  assert.equal(second.token, first.token);
  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the second call minted nothing');
  assert.equal(shares.resolveShare(first.token).ok, true, 'the link already sent still works');
  assert.equal(shares.activeForRender(RENDER).createdAt, 1_000, 'still the original link');
});

test('but a revoked link is never resurrected', () => {
  // Turning a link off is a decision to kill that URL. Handing the same string back
  // afterwards would undo it silently.
  const { shares } = setup();
  const first = shares.ensureShare({ renderId: RENDER, userId: USER, now: 1_000 });
  assert.equal(shares.revoke(RENDER, 2_000), true);

  const second = shares.ensureShare({ renderId: RENDER, userId: USER, now: 3_000 });
  assert.notEqual(second.token, first.token);
  assert.equal(second.created, true);
  assert.equal(shares.resolveShare(first.token).ok, false, 'the killed link stays dead');
  assert.equal(shares.resolveShare(second.token).ok, true);
  assert.equal(shares.activeForRender(RENDER).createdAt, 3_000, 'exactly one live link');
});

test('a link minted before token_plain existed is replaced, not shown', () => {
  // Those tokens were only ever stored as a digest, so they genuinely cannot be read
  // back. Replacing is the only way to give the owner a link they can see.
  const { db, shares } = setup();
  const legacy = shares.ensureShare({ renderId: RENDER, userId: USER, now: 1_000 });
  db.prepare('UPDATE gallery_shares SET token_plain = NULL WHERE render_id = ?').run(RENDER);
  assert.equal(shares.activeForRender(RENDER).token, null);

  const replacement = shares.ensureShare({ renderId: RENDER, userId: USER, now: 2_000 });
  assert.equal(replacement.created, true);
  assert.notEqual(replacement.token, legacy.token);
  assert.equal(shares.resolveShare(legacy.token).ok, false);
  assert.equal(shares.activeForRender(RENDER).token, replacement.token);
});

test('a revoked share keeps its row, so the view count survives', () => {
  // The agent wants to see that the link they sent in March was opened before they
  // killed it. Revocation is a read-time check, not a delete.
  const { db, shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER, now: 1_000 });
  shares.recordView(token, 2_000);
  assert.equal(shares.revoke(RENDER, 3_000), true);

  assert.equal(shares.resolveShare(token).ok, false);
  const row = db.prepare('SELECT * FROM gallery_shares').get();
  assert.equal(row.view_count, 1, 'the history outlives the link');
  assert.equal(row.revoked_at, 3_000);
});

test('revoke is idempotent', () => {
  const { shares } = setup();
  shares.ensureShare({ renderId: RENDER, userId: USER });
  assert.equal(shares.revoke(RENDER), true);
  assert.equal(shares.revoke(RENDER), false, 'nothing live left to kill');
});

test('every refusal is reported, so the route can flatten them into ONE 404', () => {
  // A surface that answers differently for "revoked" and "never existed" sorts real
  // tokens from junk for anyone who asks it enough times.
  const { shares } = setup();
  assert.deepEqual(shares.resolveShare('not-a-real-token'), { ok: false, reason: 'unknown' });

  const revoked = shares.ensureShare({ renderId: RENDER, userId: USER });
  shares.revoke(RENDER);
  assert.deepEqual(shares.resolveShare(revoked.token), { ok: false, reason: 'revoked' });

  const expiring = shares.ensureShare({ renderId: 'f'.repeat(32), userId: USER, expiresAt: 5_000 });
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
  shares.ensureShare({ renderId: RENDER, userId: USER, expiresAt: 5_000 });
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
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER, settings: { headline: 'first' } });
  const updated = shares.updateSettings({ renderId: RENDER, settings: { headline: 'second' } });

  assert.equal(updated.settings.headline, 'second');
  assert.equal(shares.resolveShare(token).ok, true, 'the same link still works');
  assert.equal(shares.resolveShare(token).share.settings.headline, 'second');
});

test('corrupt settings degrade to defaults rather than 500ing a live link', () => {
  const { db, shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER });
  db.prepare('UPDATE gallery_shares SET settings_json = ?').run('{not json at all');

  const res = shares.resolveShare(token);
  assert.equal(res.ok, true, 'losing a headline beats a 500 on a URL already texted to a client');
  assert.equal(res.share.settings.headline, '');
});

// ---- view counting ----------------------------------------------------------------

test('views are debounced, so a tab left open is one visit', () => {
  const { db, shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER, now: 0 });

  shares.recordView(token, 1_000);
  shares.recordView(token, 2_000);
  shares.recordView(token, 1_000 + VIEW_DEBOUNCE_MS - 1);
  assert.equal(db.prepare('SELECT view_count AS n FROM gallery_shares').get().n, 1);

  shares.recordView(token, 1_000 + VIEW_DEBOUNCE_MS);
  assert.equal(db.prepare('SELECT view_count AS n FROM gallery_shares').get().n, 2);
});

test('a revoked link records no further views', () => {
  const { db, shares } = setup();
  const { token } = shares.ensureShare({ renderId: RENDER, userId: USER, now: 0 });
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
