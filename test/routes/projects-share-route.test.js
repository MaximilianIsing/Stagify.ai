// Tier: route contract (REAL share store on a throwaway data dir, fake project ownership) —
// the owner-side share API in routes/projects-share.js.
//
// WHAT THIS COVERS, AND WHY THESE THINGS
// These four routes mint the only credential in the product that is handed to a person with
// no account. That makes the load-bearing tests here narrower and sharper than "does the
// endpoint work":
//
//   * THE TOKEN LEAVES THE SERVER EXACTLY ONCE. The POST body carries it; nothing else may.
//     The GET is asserted against the RAW RESPONSE TEXT rather than a parsed field, because
//     a leak would arrive as a *new* key nobody wrote an assertion for — `share.token`,
//     `history[0].tokenHash`, an accidental `...row` spread. Only searching the whole body
//     catches the shape of that bug.
//   * THE GATE IS IN THE HANDLER. Every verb is asserted to 401 unauthenticated AND to have
//     touched no store method: a share store reached before the gate is a share store that
//     can be probed.
//   * CROSS-USER IS 404, NEVER 403, on all four verbs. A 403 confirms the listing id exists,
//     and every listing id here is one POST away from a public URL.
//   * ROTATION IS REAL. "POST twice returns two different tokens" is not enough — the old
//     token has to stop resolving, which is only observable through the store's public-side
//     `resolveShare`. That is used as the oracle throughout.
//   * EXPIRY IS REFUSED, NOT CLAMPED. `expiresInDays: 3650` silently becoming 365 would hand
//     an owner an expiry date they never chose on a page showing a client's home.
//
// The SHARE STORE IS THE REAL ONE (real SQLite, temp dir) because token hashing, one-time
// return and rotation are exactly the behaviours under test — a fake would be re-asserting
// the fake. Project ownership is a two-field in-memory map, since routes/projects.js owns
// that lookup and injects it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError, setSensitiveHeaders } from '../../lib/http/http-helpers.js';
import { reportError } from '../../lib/http/error-ref.js';
import { createProjectShares } from '../../lib/data/project-shares.js';
import { closeDb } from '../../lib/data/db.js';
import {
  registerShareRoutes, readExpiry, readShareSettings, shareOrigin,
  MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS, DAY_MS,
} from '../../routes/projects-share.js';

const USER_A = { id: 'u_a', email: 'a@example.com', plan: 'pro' };
const USER_B = { id: 'u_b', email: 'b@example.com', plan: 'pro' };
const APP_URL = 'https://stagify.test';
/** 32 CSPRNG bytes, base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** @type {string[]} */
const dirs = [];
/** @type {any} */
let app = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Mount the four share routes on a bare Express app with the REAL store and the same
 * `guard`/`notFound`/`ownedProject` helpers routes/projects.js injects.
 * @param {{ user?: any, appUrl?: string }} [overrides] - `user` installs a requireProAccount
 *   that returns it (the authorized case); otherwise the gate 401s.
 * @returns {Promise<any>} `{ baseUrl, shares, calls, seed, close }`.
 */
async function mountShares(overrides = {}) {
  const { user, appUrl = APP_URL } = overrides;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-share-'));
  dirs.push(dir);
  const store = createProjectShares(dir);

  // Every store call is logged by name so "the store was never touched" is assertable. The
  // wrapper dispatches through `store[name]` on each call rather than capturing the
  // function, so a test can swap one method out afterwards to inject a failure.
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const shares = {};
  for (const name of Object.keys(store)) {
    shares[name] = (...args) => {
      calls.push(name);
      return store[name](...args);
    };
  }

  /** @type {Map<string, { id: string, userId: string }>} */
  const projects = new Map();
  let seq = 0;

  const router = createAsyncRouter();
  registerShareRoutes({
    router,
    shares,
    requireProAccount: user
      ? () => user
      : (req, res) => {
        res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
        return null;
      },
    // Verbatim from routes/projects.js — a 500 carries a ref, never the exception text.
    guard: (context, fn) => async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        const ref = reportError(context, err);
        if (!res.headersSent) sendError(res, 500, 'Request failed', { ref });
      }
    },
    notFound: (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' }),
    ownedProject: (req, u) => {
      const project = projects.get(String(req.params.id));
      // Same answer for "absent" and "someone else's".
      if (!project || project.userId !== u.id) return null;
      return project;
    },
    setSensitiveHeaders,
    appUrl,
  });

  const server = express();
  server.use(express.json({ limit: '1mb' }));
  server.use(router);
  // Catch-all, as in server.js — without it Express renders a stack trace as HTML.
  server.use((err, req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Server error', code: err?.code || 'ERROR' });
  });

  const listening = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = listening.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    shares: store,
    calls,
    /** @returns {{ id: string, userId: string }} A listing owned by `userId`. */
    seed: (userId) => {
      const project = { id: `p_${(seq += 1)}`, userId };
      projects.set(project.id, project);
      return project;
    },
    close: () => new Promise((r) => listening.close(() => r(undefined))),
  };
}

const call = (base, route, { method = 'GET', body } = {}) =>
  fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const share = (base, projectId, opts) => call(base, `/api/projects/${projectId}/share`, opts);

/** POST a share and return the parsed body, asserting it succeeded. */
async function mint(base, projectId, body = {}) {
  const res = await share(base, projectId, { method: 'POST', body });
  assert.equal(res.status, 200, 'precondition: minting must succeed');
  return res.json();
}

// ── The token: minted once, never re-served ──────────────────────────────────

test('POST mints a link: a 43-char base64url token and a <appUrl>/s/<token> URL', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);

  const body = await mint(app.baseUrl, project.id);
  assert.match(body.token, TOKEN_SHAPE, 'the token is 32 CSPRNG bytes, base64url');
  assert.equal(body.url, `${APP_URL}/s/${body.token}`);
  assert.equal(body.replaced, 0, 'nothing to rotate out on the first mint');
  assert.equal(body.share.projectId, project.id);
  assert.equal(body.share.userId, USER_A.id, 'ownership comes from the session');
  assert.equal(body.share.revokedAt, null);
  assert.equal(body.share.expiresAt, null, 'no expiry unless one was asked for');

  // The token is a live credential, not just a string.
  assert.equal(app.shares.resolveShare(body.token).ok, true);
});

test('GET never carries the token — asserted on the RAW body, not a named field', async () => {
  // THE test in this file. A leak would arrive as a key nobody predicted (`share.token`, a
  // `tokenHash` from an accidental row spread), so only searching the whole serialized
  // response can see it. Both the live share and the audit trail are in this body.
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const first = await mint(app.baseUrl, project.id);
  const second = await mint(app.baseUrl, project.id, { settings: { headline: 'Sunny' } });

  const res = await share(app.baseUrl, project.id);
  assert.equal(res.status, 200);
  const raw = await res.text();

  for (const token of [first.token, second.token]) {
    assert.ok(!raw.includes(token), `the GET body must never contain a share token: ${raw}`);
  }
  // And not the digest either — a sha256 of a 32-byte token is not brute-forceable, but it
  // is still the exact value the lookup index compares against.
  assert.ok(!/token/i.test(raw), `no token-ish field may appear at all: ${raw}`);

  const body = JSON.parse(raw);
  assert.equal(body.share.settings.headline, 'Sunny', 'the live share is the newest one');
  assert.equal(body.history.length, 2, 'revoked links stay as the owner\'s audit trail');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET answers null (not 404) for a listing that has never been shared', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const body = await (await share(app.baseUrl, project.id)).json();
  assert.equal(body.share, null);
  assert.deepEqual(body.history, []);
});

test('POST twice rotates: a new token, replaced = 1, and the OLD link stops resolving', async () => {
  // "Two different strings" is not the contract — the point of the rotate button is that
  // the link the seller forwarded to the whole street stops working.
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);

  const first = await mint(app.baseUrl, project.id);
  const second = await mint(app.baseUrl, project.id);

  assert.notEqual(second.token, first.token);
  assert.equal(second.replaced, 1, 'the previous link is rotated out in the same transaction');
  assert.equal(app.shares.activeShareFor(project.id).id, second.share.id, 'exactly one live link');

  assert.equal(app.shares.resolveShare(first.token).ok, false, 'the old link must be dead');
  assert.equal(app.shares.resolveShare(first.token).code, 'REVOKED');
  assert.equal(app.shares.resolveShare(second.token).ok, true);
});

// ── The gate ─────────────────────────────────────────────────────────────────

test('every verb 401s without a session, and the store is never touched', async () => {
  app = await mountShares();
  const project = app.seed(USER_A.id);
  app.calls.length = 0;

  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const res = await share(app.baseUrl, project.id, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} must 401 unauthenticated`);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  }
  assert.deepEqual(app.calls, [], 'an anonymous caller must not reach the share store at all');
});

test('a second user gets 404 (never 403) on all four verbs, and changes nothing', async () => {
  // 403 would confirm the listing exists — and each listing id here is one POST away from a
  // public URL onto someone\'s home.
  app = await mountShares({ user: USER_B });
  const project = app.seed(USER_A.id);
  // User A already has a live link, minted out-of-band through the store.
  const live = app.shares.createShare({ projectId: project.id, userId: USER_A.id, settings: {} });

  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const res = await share(app.baseUrl, project.id, { method, body: method === 'GET' ? undefined : { settings: { headline: 'hijack' } } });
    assert.equal(res.status, 404, `${method} must 404 for a non-owner`);
    assert.notEqual(res.status, 403, `${method} must not confirm the listing exists`);
    assert.equal((await res.json()).code, 'NOT_FOUND');
  }

  const after = app.shares.activeShareFor(project.id);
  assert.equal(after.id, live.share.id, 'the link must not be rotated');
  assert.equal(after.revokedAt, null, 'nor revoked');
  assert.equal(after.settings.headline, '', 'nor re-worded');
  assert.equal(app.shares.resolveShare(live.token).ok, true, 'and it still works for its owner');
});

test('an unknown listing id is the same 404 as somebody else\'s', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_B.id);
  const mine = await share(app.baseUrl, 'p_does_not_exist');
  const theirs = await share(app.baseUrl, project.id);
  assert.equal(mine.status, theirs.status);
  assert.deepEqual(await mine.json(), await theirs.json(), 'the two answers must be indistinguishable');
});

// ── Revoke ───────────────────────────────────────────────────────────────────

test('DELETE revokes the live link and is idempotent (0 revoked, still 200)', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const minted = await mint(app.baseUrl, project.id);

  const first = await share(app.baseUrl, project.id, { method: 'DELETE' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, revoked: 1 });
  assert.equal(app.shares.resolveShare(minted.token).ok, false, 'the link must stop working');
  assert.equal(app.shares.activeShareFor(project.id), null);

  // A kill switch that errors on a double click is a kill switch people stop trusting.
  const second = await share(app.baseUrl, project.id, { method: 'DELETE' });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, revoked: 0 });

  // Revocation is a flag, not a DELETE: the row survives so the owner keeps the view count.
  assert.equal(app.shares.listSharesFor(project.id).length, 1);
});

test('DELETE on a listing that never had a link is a 200 with revoked: 0', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const res = await share(app.baseUrl, project.id, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: 0 });
});

// ── Patch ────────────────────────────────────────────────────────────────────

test('PATCH re-words the page WITHOUT rotating the token', async () => {
  // The whole reason PATCH exists rather than "mint again with new settings": the link the
  // broker already texted their client has to keep working.
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const minted = await mint(app.baseUrl, project.id, { settings: { headline: 'Old' } });

  const res = await share(app.baseUrl, project.id, {
    method: 'PATCH',
    body: { settings: { headline: 'New', note: 'Ready for viewings', showBefore: false } },
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(minted.token), 'PATCH must not echo the token back');

  const body = JSON.parse(raw);
  assert.equal(body.share.id, minted.share.id, 'same row — no rotation');
  assert.equal(body.share.settings.headline, 'New');
  assert.equal(body.share.settings.note, 'Ready for viewings');
  assert.equal(body.share.settings.showBefore, false);
  assert.equal(app.shares.resolveShare(minted.token).ok, true, 'the original link still resolves');
  assert.equal(app.shares.listSharesFor(project.id).length, 1, 'and no second row was created');
});

test('PATCH with no live share is a 400 NO_SHARE (the listing itself is fine)', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);

  const never = await share(app.baseUrl, project.id, { method: 'PATCH', body: { settings: { headline: 'x' } } });
  assert.equal(never.status, 400);
  assert.equal((await never.json()).code, 'NO_SHARE');

  // Same answer once the only link has been revoked — editing a dead page is meaningless.
  await mint(app.baseUrl, project.id);
  await share(app.baseUrl, project.id, { method: 'DELETE' });
  const revoked = await share(app.baseUrl, project.id, { method: 'PATCH', body: { settings: { headline: 'x' } } });
  assert.equal(revoked.status, 400);
  assert.equal((await revoked.json()).code, 'NO_SHARE');
});

test('PATCH settings alone leaves a time-boxed link\'s expiry untouched', async () => {
  // Settings and expiry come from two different controls; a settings save that cleared the
  // expiry would quietly un-expire a link the owner deliberately time-boxed.
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const minted = await mint(app.baseUrl, project.id, { expiresInDays: 7 });
  assert.ok(minted.share.expiresAt, 'precondition: the link expires');

  const body = await (await share(app.baseUrl, project.id, { method: 'PATCH', body: { settings: { headline: 'Hi' } } })).json();
  assert.equal(body.share.expiresAt, minted.share.expiresAt);

  // …but an explicit null does clear it.
  const cleared = await (await share(app.baseUrl, project.id, { method: 'PATCH', body: { expiresInDays: null } })).json();
  assert.equal(cleared.share.expiresAt, null);
});

// ── Expiry ───────────────────────────────────────────────────────────────────

test('expiresInDays becomes an epoch roughly days*86400000 from now', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const before = Date.now();
  const body = await mint(app.baseUrl, project.id, { expiresInDays: 30 });
  const expected = before + (30 * DAY_MS);
  assert.ok(Math.abs(body.share.expiresAt - expected) < 5000, `${body.share.expiresAt} ≉ ${expected}`);
});

test('an out-of-range or nonsense expiresInDays is a 400 and mints nothing', async () => {
  // Clamping instead of refusing would hand the owner an expiry date they never chose.
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);

  for (const value of [0, -1, 366, 3650, 1.5, 'soon', '', true, {}, []]) {
    const res = await share(app.baseUrl, project.id, { method: 'POST', body: { expiresInDays: value } });
    assert.equal(res.status, 400, `expiresInDays=${JSON.stringify(value)} must be refused`);
    assert.equal((await res.json()).code, 'BAD_EXPIRY');
  }
  assert.equal(app.shares.activeShareFor(project.id), null, 'a refused request must not mint a link');
  assert.equal(app.shares.count(), 0);

  // PATCH refuses the same values — and refuses them BEFORE touching the settings.
  const minted = await mint(app.baseUrl, project.id, { settings: { headline: 'Keep me' } });
  const bad = await share(app.baseUrl, project.id, { method: 'PATCH', body: { settings: { headline: 'Lose me' }, expiresInDays: 999 } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'BAD_EXPIRY');
  assert.equal(app.shares.activeShareFor(project.id).settings.headline, 'Keep me', 'a refused patch changes nothing');
  assert.equal(app.shares.activeShareFor(project.id).id, minted.share.id);
});

test('the range boundaries are inclusive', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  for (const days of [MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS, String(MAX_EXPIRY_DAYS)]) {
    const res = await share(app.baseUrl, project.id, { method: 'POST', body: { expiresInDays: days } });
    assert.equal(res.status, 200, `expiresInDays=${days} must be accepted`);
    await res.json();
  }
});

// ── Body handling ────────────────────────────────────────────────────────────

test('settings are clamped and unknown keys never reach the share', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const body = await mint(app.baseUrl, project.id, {
    settings: {
      headline: 'H'.repeat(5000),
      note: 'N'.repeat(5000),
      agentEmail: '  agent@example.com  ',
      internalCostCents: 4200,
      userId: USER_B.id,
    },
  });
  assert.equal(body.share.settings.headline.length, 120, 'the store\'s per-field limit applies');
  assert.equal(body.share.settings.note.length, 600);
  assert.equal(body.share.settings.agentEmail, 'agent@example.com', 'trimmed');
  const serialized = JSON.stringify(body.share);
  assert.ok(!serialized.includes('internalCostCents'), 'the settings allowlist drops unknown keys');
  assert.ok(!serialized.includes(USER_B.id), 'and a userId in the body is never honoured');
  assert.equal(body.share.userId, USER_A.id);
});

test('a flat body works as well as a nested settings bag', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const body = await mint(app.baseUrl, project.id, { headline: 'Flat', showBefore: false });
  assert.equal(body.share.settings.headline, 'Flat');
  assert.equal(body.share.settings.showBefore, false);
});

test('showBefore defaults to true when the caller omits it', async () => {
  // It is the before/after pair that sells staging; defaulting it off would make the common
  // case require a settings trip.
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const body = await mint(app.baseUrl, project.id, { settings: { headline: 'x' } });
  assert.equal(body.share.settings.showBefore, true);
});

test('an empty POST body still mints a usable link', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const res = await fetch(`${app.baseUrl}/api/projects/${project.id}/share`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.token, TOKEN_SHAPE);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('readExpiry distinguishes absent from an explicit null', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(readExpiry({}, now), { ok: true, present: false, expiresAt: null });
  assert.deepEqual(readExpiry({ expiresInDays: null }, now), { ok: true, present: true, expiresAt: null });
  assert.deepEqual(readExpiry({ expiresInDays: 2 }, now), { ok: true, present: true, expiresAt: now + (2 * DAY_MS) });
  assert.deepEqual(readExpiry({ expiresInDays: '2' }, now), { ok: true, present: true, expiresAt: now + (2 * DAY_MS) });
  assert.deepEqual(readExpiry(null, now), { ok: true, present: false, expiresAt: null });
  for (const bad of [0, 366, true, false, 'x', {}, [], NaN, Infinity]) {
    assert.deepEqual(readExpiry({ expiresInDays: bad }, now), { ok: false }, `${JSON.stringify(bad)} must be refused`);
  }
});

test('readShareSettings omits showBefore unless it was sent', () => {
  // Tri-state on the wire: absent means "use the store's default", which is true.
  assert.equal('showBefore' in readShareSettings({ headline: 'x' }), false);
  assert.equal(readShareSettings({ showBefore: 'true' }).showBefore, true);
  assert.equal(readShareSettings({ showBefore: false }).showBefore, false);
  assert.equal(readShareSettings({ settings: { headline: ' hi ' } }).headline, 'hi');
  assert.equal(readShareSettings(undefined).headline, '');
  assert.equal(readShareSettings({ headline: 42 }).headline, '', 'a non-string field becomes empty, never "42"');
});

test('shareOrigin strips trailing slashes and never yields a relative URL', () => {
  assert.equal(shareOrigin('https://stagify.ai/'), 'https://stagify.ai');
  assert.equal(shareOrigin('https://stagify.ai///'), 'https://stagify.ai');
  assert.equal(shareOrigin(''), 'https://stagify.ai', 'a misconfigured origin must not produce /s/<token>');
  assert.equal(shareOrigin(undefined), 'https://stagify.ai');
});

test('a configured origin with a trailing slash still builds a single-slash URL', async () => {
  app = await mountShares({ user: USER_A, appUrl: 'https://demo.stagify.test/' });
  const project = app.seed(USER_A.id);
  const body = await mint(app.baseUrl, project.id);
  assert.equal(body.url, `https://demo.stagify.test/s/${body.token}`);
});

// ── 5xx hygiene ──────────────────────────────────────────────────────────────

test('an unexpected store failure returns a ref, never the exception text or a token', async () => {
  app = await mountShares({ user: USER_A });
  const project = app.seed(USER_A.id);
  const minted = await mint(app.baseUrl, project.id);
  // Break the store AFTER a real token exists, and put the token IN the exception, so the
  // `details: err.message` shape this pattern replaced would genuinely leak it. (The token
  // reaching stderr here is this test fabricating the leak vector — no route logs one.)
  const boom = new Error(`SQLITE_CORRUPT reading ${minted.token} from /srv/data/auth-store.db`);
  app.shares.activeShareFor = () => { throw boom; };

  const res = await share(app.baseUrl, project.id);
  assert.equal(res.status, 500);
  const raw = await res.text();
  assert.match(JSON.parse(raw).ref, /^[0-9a-f]{8}$/);
  assert.ok(!raw.includes('SQLITE_CORRUPT'), 'the exception text must not reach the client');
  assert.ok(!raw.includes('/srv/data'), 'nor an absolute server path');
  assert.ok(!raw.includes(minted.token), 'and above all not the token');
});
