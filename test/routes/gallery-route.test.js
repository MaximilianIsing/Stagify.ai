// Tier: route contract (real router + real stores) — routes/gallery.js.
//
// The owner's own history. Two properties carry the weight:
//   - TENANCY. A render id in the path is untrusted input. User A must not be able to
//     read, delete, share or revoke user B's render, and "not yours" must be
//     indistinguishable from "does not exist" or the surface becomes a way to probe
//     which ids are real.
//   - THE TOKEN COMES BACK ONCE. Minting returns the plaintext link; nothing else ever
//     does, so an owner who loses it has to rotate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createGalleryRouter from '../../routes/gallery.js';
import { createGalleryShares } from '../../lib/data/gallery-shares.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { createRenderRefs } from '../../lib/data/render-refs.js';
import { createLocalObjectStore } from '../../lib/data/object-store-local.js';
import { createDisabledObjectStore } from '../../lib/data/object-store.js';
import { keyForRender, newRenderId } from '../../lib/data/object-keys.js';
import { closeDb } from '../../lib/data/db.js';

const servers = [];
const dirs = [];

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) {
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

/**
 * Mount the real router over real stores. `as()` swaps the identity the fake auth
 * returns, so a test can change caller without a session.
 */
async function mount({ objectStore: injected, appOrigin = 'https://stagify.test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-galleryroute-'));
  dirs.push(dir);
  const shares = createGalleryShares(dir);
  const stagedRenders = createStagedRenders(dir);
  const renderRefs = createRenderRefs(dir);
  const objectStore = injected ?? createLocalObjectStore({ baseDir: dir, secret: 'test' });

  const identity = { current: /** @type {any} */ (null) };
  const app = express();
  app.use(express.json());
  app.use(createGalleryRouter({
    stagedRenders, renderRefs, shares, objectStore,
    getAuthUserFromRequest: () => identity.current,
    galleryLimiter: (req, res, next) => next(),
    appOrigin,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);

  const addRender = (userId, { status = 'ok' } = {}) => {
    const id = newRenderId();
    stagedRenders.record({
      render: { id, userId, roomType: 'Bedroom', additionalPrompt: 'keep the desk' },
      blobs: [
        { role: 'after', storageKey: keyForRender({ renderId: id, role: 'after' }), bytes: 1 },
        { role: 'before', storageKey: keyForRender({ renderId: id, role: 'before' }), bytes: 1 },
        { role: 'thumb', storageKey: keyForRender({ renderId: id, role: 'thumb' }), bytes: 1 },
      ],
      isPro: true,
    });
    if (status === 'ok') stagedRenders.markOk(id, { width: 1024, height: 683 });
    return id;
  };

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    as: (id) => { identity.current = id ? { id, plan: 'pro' } : null; },
    shares, stagedRenders, addRender,
  };
}

const json = (res) => res.json();

// ---- auth ---------------------------------------------------------------------------

test('every route refuses an anonymous caller', async () => {
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as(null);

  const calls = [
    ['GET', `${base}/api/gallery`],
    ['DELETE', `${base}/api/gallery/${id}`],
    ['POST', `${base}/api/gallery/${id}/share`],
    ['PATCH', `${base}/api/gallery/${id}/share`],
    ['DELETE', `${base}/api/gallery/${id}/share`],
  ];
  for (const [method, url] of calls) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' || method === 'PATCH' ? '{}' : undefined,
    });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal((await json(res)).code, 'AUTH_REQUIRED');
  }
});

// ---- tenancy ------------------------------------------------------------------------

test('a caller only sees their own entries', async () => {
  const { base, as, addRender } = await mount();
  addRender('user-1');
  addRender('user-1');
  addRender('user-2');

  as('user-1');
  const mine = await json(await fetch(`${base}/api/gallery`));
  assert.equal(mine.total, 2);
  assert.equal(mine.entries.length, 2);

  as('user-2');
  assert.equal((await json(await fetch(`${base}/api/gallery`))).total, 1);
});

test("another account's render id is a 404 on every route, not a 403", async () => {
  // Indistinguishable from "does not exist", so this cannot be used to probe which
  // render ids are real.
  const { base, as, addRender } = await mount();
  const theirs = addRender('user-2');
  as('user-1');

  const invented = newRenderId();
  for (const id of [theirs, invented]) {
    for (const [method, suffix] of [['DELETE', ''], ['POST', '/share'], ['PATCH', '/share'], ['DELETE', '/share']]) {
      const res = await fetch(`${base}/api/gallery/${id}${suffix}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' || method === 'PATCH' ? '{}' : undefined,
      });
      assert.equal(res.status, 404, `${method} ${id}${suffix}`);
    }
  }
});

test("deleting another account's render leaves it entirely alone", async () => {
  const { base, as, addRender, stagedRenders } = await mount();
  const theirs = addRender('user-2');
  as('user-1');
  await fetch(`${base}/api/gallery/${theirs}`, { method: 'DELETE' });

  as('user-2');
  assert.equal((await json(await fetch(`${base}/api/gallery`))).total, 1, 'still there');
  assert.equal(stagedRenders.get(theirs).evicted_at, null);
});

// ---- the manifest -------------------------------------------------------------------

test('an entry carries the settings that make the gallery worth having', async () => {
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');

  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  assert.equal(entry.roomType, 'Bedroom');
  // "What did I actually ask for" is the reason a history beats a downloads folder.
  assert.equal(entry.additionalPrompt, 'keep the desk');
  assert.ok(entry.urls.after, 'the staged result');
  // The OWNER gets the before photo. The public share deliberately does not — that
  // asymmetry is the whole reason the two manifests are built by two functions.
  assert.ok(entry.urls.before, 'and their own source photo');
  assert.ok(entry.urls.thumb);
});

test('the owner manifest carries the live link, so it survives a reload', async () => {
  // It used to carry only `active: true`, on the reasoning that the token was handed out
  // once. That made the owner's own copy of the link unrecoverable: close the panel and
  // the URL you had just been given was gone for good.
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const minted = await json(await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));

  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  assert.equal(entry.share.active, true);
  assert.equal(entry.share.url, minted.url, 'the same link, not a new one');
  assert.equal(entry.share.viewCount, 0);
});

test('a signed-in stranger never sees another owner\'s link', async () => {
  // The manifest now carries a live URL, so the tenancy check on the LISTING is load
  // bearing in a way it was not when the field was absent.
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');
  await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  as('user-2');
  const body = await (await fetch(`${base}/api/gallery`)).text();
  assert.ok(!body.includes('/s/'), 'user-2 must not be handed user-1\'s share URL');
  assert.deepEqual(JSON.parse(body).entries, []);
});

// ---- sharing ------------------------------------------------------------------------

test('minting returns a pasteable absolute URL, once', async () => {
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');

  const res = await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { headline: 'Living room', agentEmail: 'a@example.com' } }),
  });
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.match(body.url, /^https:\/\/stagify\.test\/s\/[A-Za-z0-9_-]{43}$/);
  assert.equal(body.share.settings.headline, 'Living room');
});

test('an unconfigured origin still mints a PASTEABLE link, not a bare path', async () => {
  // The bug this exists for: routes/gallery.js read an APP_ORIGIN that is set in no
  // environment and no config file, and fell back to the empty string — so every link
  // came back as `/s/<token>`. The token is shown exactly once and has no read-back, so
  // an agent who copied one had to rotate to recover.
  //
  // Every other assertion in this file injects appOrigin, which is precisely why the
  // empty case shipped: the fallback was never once exercised.
  const saved = { pub: process.env.PUBLIC_APP_URL, app: process.env.APP_URL, origin: process.env.APP_ORIGIN };
  delete process.env.PUBLIC_APP_URL;
  delete process.env.APP_URL;
  delete process.env.APP_ORIGIN;
  try {
    const { base, as, addRender } = await mount({ appOrigin: '' });
    const id = addRender('user-1');
    as('user-1');

    const body = await fetch(`${base}/api/gallery/${id}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(json);

    assert.ok(!body.url.startsWith('/s/'), `still a bare path: ${body.url}`);
    assert.match(body.url, /^https?:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{43}$/);
    // It has to survive the round trip a person actually makes with it.
    assert.equal(new URL(body.url).pathname, `/s/${body.token}`);
  } finally {
    if (saved.pub === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = saved.pub;
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved.origin;
  }
});

test('minting twice returns the SAME link, so a sent URL is never invalidated', async () => {
  // This endpoint used to rotate on every call, which made "create link" indistinguish-
  // able from "break the link I already texted to somebody".
  const { base, as, addRender, shares } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const mint = () => fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then(json);

  const first = await mint();
  const second = await mint();
  assert.equal(second.token, first.token);
  assert.equal(second.url, first.url);
  assert.equal(shares.resolveShare(first.token).ok, true, 'the original link still works');
});

test('but a link turned off is not resurrected by creating another', async () => {
  const { base, as, addRender, shares } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const mint = () => fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then(json);

  const first = await mint();
  await fetch(`${base}/api/gallery/${id}/share`, { method: 'DELETE' });
  const second = await mint();

  assert.notEqual(second.token, first.token);
  assert.equal(shares.resolveShare(first.token).ok, false, 'the killed link stays dead');
  assert.equal(shares.resolveShare(second.token).ok, true);
});

test('a render whose bytes never landed cannot be shared', async () => {
  // Minting for it would hand somebody a URL that 404s.
  const { base, as, addRender } = await mount();
  const pending = addRender('user-1', { status: 'pending' });
  as('user-1');
  const res = await fetch(`${base}/api/gallery/${pending}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 404);
});

test('editing settings does not rotate the link', async () => {
  const { base, as, addRender, shares } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const { token } = await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then(json);

  await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { headline: 'Corrected' } }),
  });
  // An agent fixing a typo must not invalidate the link they already sent.
  const resolved = shares.resolveShare(token);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.share.settings.headline, 'Corrected');
});

test('revoking is idempotent', async () => {
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');
  await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`${base}/api/gallery/${id}/share`, { method: 'DELETE' });
    assert.equal(res.status, 200, '"make sure this link is dead" is what the caller wants');
  }
});

test('deleting an entry is the HARD revoke', async () => {
  const { base, as, addRender, shares } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const { token } = await fetch(`${base}/api/gallery/${id}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then(json);

  await fetch(`${base}/api/gallery/${id}`, { method: 'DELETE' });
  assert.equal(shares.resolveShare(token).ok, false);
  assert.equal((await json(await fetch(`${base}/api/gallery`))).total, 0);
});

// ---- the off switch -----------------------------------------------------------------

test('a disabled object store answers an empty gallery, not a 500', async () => {
  // On Render with no R2 the gallery is off by design. The page renders its empty state
  // and says why; a 500 would look like a broken account.
  const { base, as, addRender } = await mount({ objectStore: createDisabledObjectStore() });
  addRender('user-1');
  as('user-1');
  const res = await fetch(`${base}/api/gallery`);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.entries, []);
  assert.equal(body.enabled, false);
});
