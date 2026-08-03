// Tier: route contract (real router + real stores) — routes/gallery.js.
//
// The owner's own history. Two properties carry the weight:
//   - TENANCY. A render id in the path is untrusted input. User A must not be able to
//     read, delete or edit user B's render, and "not yours" must be indistinguishable
//     from "does not exist" or the surface becomes a way to probe which ids are real.
//   - EVERY ENTRY ARRIVES WITH ITS LINK. There is no create call and no off switch: the
//     listing mints what is missing, so opening a card and copying is the whole flow. A
//     listing that came back without a URL would leave the owner with no way to get one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createGalleryRouter, { MAX_OFFSET, PAGE_SIZE } from '../../routes/gallery.js';
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

  const addRender = (userId, { status = 'ok', roomType = 'Bedroom', furnitureStyle, additionalPrompt = 'keep the desk' } = {}) => {
    const id = newRenderId();
    stagedRenders.record({
      render: { id, userId, roomType, furnitureStyle, additionalPrompt },
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
    // `plan` is what the route reads to decide whether searching is offered, so it has to
    // be settable — every other assertion in this file runs as a Pro account.
    as: (id, plan = 'pro') => { identity.current = id ? { id, plan } : null; },
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
    ['PATCH', `${base}/api/gallery/${id}`],
    ['PATCH', `${base}/api/gallery/${id}/share`],
  ];
  for (const [method, url] of calls) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      // A name, so the rename route cannot answer 401 merely because the body was wrong —
      // the auth check has to be what refuses it.
      body: method === 'PATCH' ? '{"name":"x"}' : undefined,
    });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal((await json(res)).code, 'AUTH_REQUIRED');
  }
});

test('the routes that minted and killed a link are gone, not merely unused', () => {
  // Removing the buttons without removing the endpoints would leave a mint and a revoke
  // reachable by anyone with a session and curl, for a model that no longer has either.
  const src = fs.readFileSync(new URL('../../routes/gallery.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/router\.post\(/.test(src), 'a POST is mounted again — there is no link to create');
  assert.ok(!/router\.delete\(\s*'\/api\/gallery\/:id\/share'/.test(src), 'the revoke route is back');
  // The delete-the-render route is the takedown and must stay.
  assert.match(src, /router\.delete\(\s*'\/api\/gallery\/:id'/);
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
    for (const [method, suffix, body] of [['DELETE', ''], ['PATCH', '', '{"name":"Mine now"}'], ['PATCH', '/share', '{}']]) {
      const res = await fetch(`${base}/api/gallery/${id}${suffix}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 404, `${method} ${id}${suffix}`);
    }
  }
});

test("naming another account's render leaves it entirely alone", async () => {
  // The 404 above proves the ANSWER. This proves the write did not happen anyway, which is
  // the half a status code cannot show — the id and the user id go into one UPDATE's WHERE
  // precisely so there is no check-then-write to get out of step.
  const { base, as, addRender, stagedRenders } = await mount();
  const theirs = addRender('user-2');
  as('user-1');

  await fetch(`${base}/api/gallery/${theirs}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"Mine now"}',
  });
  assert.equal(stagedRenders.get(theirs).custom_name, null);
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

// ---- search (Stagify+) --------------------------------------------------------------
//
// The gate is the point. The page hides the box for a free account, but the box is not the
// enforcement — `?q=` is a URL anyone can type, and the SERVER has to be what decides.

const search = (base, q) => fetch(`${base}/api/gallery?q=${encodeURIComponent(q)}`).then(json);

test('a Stagify+ caller can narrow the listing', async () => {
  const { base, as, addRender } = await mount();
  addRender('user-1', { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  addRender('user-1', { roomType: 'Kitchen', furnitureStyle: 'coastal' });
  as('user-1');

  const body = await search(base, 'kitchen');
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].roomType, 'Kitchen');
  assert.equal(body.search.enabled, true);
  assert.equal(body.search.q, 'kitchen');
});

test('the total is the MATCHING count, not the size of the gallery', async () => {
  // The page prints this above the grid. "1 of 2" over one tile is the listing
  // contradicting itself.
  const { base, as, addRender } = await mount();
  addRender('user-1', { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  addRender('user-1', { roomType: 'Kitchen', furnitureStyle: 'coastal' });
  as('user-1');

  assert.equal((await search(base, 'kitchen')).total, 1);
  assert.equal((await json(await fetch(`${base}/api/gallery`))).total, 2, 'unfiltered is still both');
});

test('a FREE caller is told searching is off, and their query is ignored', async () => {
  // Not a 403: the listing itself is theirs, and refusing a parameter they cannot see on
  // screen would be a worse answer than their own gallery. But it must not silently look
  // like a search that matched everything either — hence the flag.
  const { base, as, addRender } = await mount();
  addRender('user-1', { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  addRender('user-1', { roomType: 'Kitchen', furnitureStyle: 'coastal' });
  as('user-1', 'free');

  const body = await search(base, 'kitchen');
  assert.equal(body.search.enabled, false, 'a free account must not be offered the box');
  assert.equal(body.search.q, '', 'the query must not be echoed back as if it were applied');
  assert.equal(body.entries.length, 2, 'they get their whole gallery, not a filtered one');
  assert.equal(body.total, 2);
});

test('an enterprise-domain account searches too — it is the same plan', async () => {
  // getAuthUserFromRequest rewrites an active enterprise domain to plan 'pro' before the
  // route ever sees it, so this must not be gated on anything narrower.
  const { base, as, addRender } = await mount();
  addRender('user-1', { roomType: 'Kitchen', furnitureStyle: 'coastal' });
  as('user-1', 'pro');
  assert.equal((await search(base, 'kitchen')).search.enabled, true);
});

test('search never reaches across accounts', async () => {
  const { base, as, addRender } = await mount();
  addRender('user-2', { roomType: 'Kitchen', furnitureStyle: 'coastal' });
  as('user-1');

  const body = await search(base, 'kitchen');
  assert.deepEqual(body.entries, []);
  assert.equal(body.total, 0);
});

test('a plain listing reports search as available without applying one', async () => {
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');

  const body = await json(await fetch(`${base}/api/gallery`));
  assert.deepEqual(body.search, { enabled: true, q: '' });
  assert.equal(body.entries.length, 1);
});

test('search pages on the matching set', async () => {
  const { base, as, addRender } = await mount();
  for (let i = 0; i < 3; i += 1) addRender('user-1', { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  addRender('user-1', { roomType: 'Kitchen', furnitureStyle: 'coastal' });
  as('user-1');

  const body = await json(await fetch(`${base}/api/gallery?q=bedroom&offset=2`));
  assert.equal(body.total, 3, 'the total stays the matching count on a later page');
  assert.equal(body.entries.length, 1, 'and the offset applies within the matches');
});

// ---- naming -------------------------------------------------------------------------

test('an entry starts with no name, so the page derives one', async () => {
  // '' rather than a server-built "Modern Bedroom": the default is derived on read, so it
  // is not frozen into rows staged before the wording last changed.
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');

  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  assert.equal(entry.name, '');
});

test('a name round-trips through the listing', async () => {
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');

  const res = await fetch(`${base}/api/gallery/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '412 Rosewood Lane' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).name, '412 Rosewood Lane');

  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  assert.equal(entry.name, '412 Rosewood Lane');
});

test('the response carries the STORED name, not the submitted one', async () => {
  // The store trims and clamps at 80. Echoing the submission would let the page paint a
  // name the next load contradicts.
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');

  const body = await json(await fetch(`${base}/api/gallery/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `   ${'x'.repeat(200)}   ` }),
  }));
  assert.equal(body.name.length, 80);
  assert.ok(!body.name.startsWith(' '));
});

test('an empty name clears it rather than being refused', async () => {
  const { base, as, addRender, stagedRenders } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const patch = (name) => fetch(`${base}/api/gallery/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });

  await patch('Wilson viewing');
  const res = await patch('');
  assert.equal(res.status, 200, 'clearing is the reset, not a validation failure');
  assert.equal((await json(res)).name, '');
  assert.equal(stagedRenders.get(id).custom_name, null, 'stored a blank instead of NULL');
});

test('a body with no name at all is a 400, not a silent clear', async () => {
  // The difference between "clear it" and a client that sent the wrong shape. Answering
  // 200 to the second would wipe a name nobody asked to remove.
  const { base, as, addRender, stagedRenders } = await mount();
  const id = addRender('user-1');
  as('user-1');
  await fetch(`${base}/api/gallery/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Wilson viewing' }),
  });

  for (const body of ['{}', '{"name":null}', '{"name":42}', '{"name":{"toString":1}}']) {
    const res = await fetch(`${base}/api/gallery/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(res.status, 400, `body ${body}`);
    assert.equal((await json(res)).code, 'INVALID_NAME');
  }
  assert.equal(stagedRenders.get(id).custom_name, 'Wilson viewing', 'a malformed body wiped the name');
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

test('every entry arrives with a pasteable link, without anybody creating one', async () => {
  // The whole model: there is no create call to make, so a listing that came back with
  // `active: true` and no URL — which is what this used to do — left the owner holding a
  // link they could not read and no way to reach it.
  const { base, as, addRender, shares } = await mount();
  addRender('user-1');
  as('user-1');

  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  assert.match(entry.share.url, /^https:\/\/stagify\.test\/s\/[A-Za-z0-9_-]{43}$/);
  assert.equal(entry.share.viewCount, 0);
  // And it is a real one, not a URL shape: the public route has to be able to resolve it.
  assert.equal(shares.resolveShare(new URL(entry.share.url).pathname.slice('/s/'.length)).ok, true);
});

test('reloading the gallery hands back the SAME link, not a fresh one', async () => {
  // The listing is where links are minted, so it runs on every page load and every "load
  // more". Rotating there would break whatever the owner sent, silently, on a reload.
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');

  const first = (await json(await fetch(`${base}/api/gallery`))).entries[0].share;
  const second = (await json(await fetch(`${base}/api/gallery`))).entries[0].share;
  assert.equal(second.url, first.url);
  assert.equal(second.createdAt, first.createdAt, 'the original row, not a replacement');
});

test('an entry carries no `active` flag, because there is no inactive state', async () => {
  // A boolean that is true on every row ever serialized is a field the page can only
  // learn the wrong lesson from — the old UI hid the link behind exactly that check.
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');
  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  // Asserted before the `in` check rather than left to throw a TypeError: a listing that
  // came back with no share at all is a different failure from one carrying the old flag,
  // and reading `'active' in null` reports neither.
  assert.ok(entry.share, 'the entry arrived with no link');
  assert.ok(!('active' in entry.share), 'the flag is gone; the URL is the answer');
});

test('a signed-in stranger never sees another owner\'s link', async () => {
  // The manifest carries a live URL for every entry, which makes the tenancy check on the
  // LISTING load bearing in a way it was not when the field was absent.
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');
  await fetch(`${base}/api/gallery`);

  as('user-2');
  const body = await (await fetch(`${base}/api/gallery`)).text();
  assert.ok(!body.includes('/s/'), 'user-2 must not be handed user-1\'s share URL');
  assert.deepEqual(JSON.parse(body).entries, []);
});

// ---- sharing ------------------------------------------------------------------------

test('a render whose bytes never landed gets no link at all', async () => {
  // Minting for it would hand somebody a URL that 404s. `listForUser` is the gate — it
  // returns finished renders only — which is the same bar the old create route enforced.
  const { base, as, addRender, shares } = await mount();
  const pending = addRender('user-1', { status: 'pending' });
  as('user-1');

  assert.deepEqual((await json(await fetch(`${base}/api/gallery`))).entries, []);
  assert.equal(shares.activeForRender(pending), null, 'and nothing was minted behind it');
});

test('an unconfigured origin still yields a PASTEABLE link, not a bare path', async () => {
  // The bug this exists for: routes/gallery.js read an APP_ORIGIN that is set in no
  // environment and no config file, and fell back to the empty string — so every link
  // came back as `/s/<token>`, which is not something anyone can open.
  //
  // Every other assertion in this file injects appOrigin, which is precisely why the
  // empty case shipped: the fallback was never once exercised.
  const saved = { pub: process.env.PUBLIC_APP_URL, app: process.env.APP_URL, origin: process.env.APP_ORIGIN };
  delete process.env.PUBLIC_APP_URL;
  delete process.env.APP_URL;
  delete process.env.APP_ORIGIN;
  try {
    const { base, as, addRender } = await mount({ appOrigin: '' });
    addRender('user-1');
    as('user-1');

    const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
    assert.ok(!entry.share.url.startsWith('/s/'), `still a bare path: ${entry.share.url}`);
    assert.match(entry.share.url, /^https?:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{43}$/);
    // It has to survive the round trip a person actually makes with it.
    assert.doesNotThrow(() => new URL(entry.share.url));
  } finally {
    if (saved.pub === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = saved.pub;
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved.origin;
  }
});

test('editing settings does not rotate the link', async () => {
  const { base, as, addRender, shares } = await mount();
  const id = addRender('user-1');
  as('user-1');
  // The listing is the mint, so a link exists before anything is edited.
  await fetch(`${base}/api/gallery`);
  const token = shares.activeForRender(id).token;

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

test('deleting an entry is the takedown — and it is the ONLY one', async () => {
  // With no off switch, this is what an owner does about a link that went further than
  // they meant it to. It is also the stronger of the two: revoking only stopped new
  // presigned URLs being minted, while this tombstones the bytes.
  const { base, as, addRender, shares } = await mount();
  const id = addRender('user-1');
  as('user-1');
  const [entry] = (await json(await fetch(`${base}/api/gallery`))).entries;
  const token = new URL(entry.share.url).pathname.slice('/s/'.length);

  await fetch(`${base}/api/gallery/${id}`, { method: 'DELETE' });
  assert.equal(shares.resolveShare(token).ok, false);
  assert.equal((await json(await fetch(`${base}/api/gallery`))).total, 0);
});

// ---- paging ---------------------------------------------------------------------------
//
// `offset` is the only number this route takes off the query string, and better-sqlite3
// binds it straight into `LIMIT ? OFFSET ?`. It refuses a non-integer or out-of-range
// value from INSIDE the statement, so a coercion that lets one through is not a bad page —
// it is a 500 on an authenticated endpoint. `?offset=1.5` and `?offset=1e21` both were.

test('a fractional offset floors instead of throwing', async () => {
  const { base, as, addRender } = await mount();
  as('user-1');
  addRender('user-1', { roomType: 'Bedroom' });
  addRender('user-1', { roomType: 'Kitchen' });

  const all = (await json(await fetch(`${base}/api/gallery`))).entries;
  const res = await fetch(`${base}/api/gallery?offset=1.5`);
  assert.equal(res.status, 200, 'a fractional offset used to reach SQLite and 500');
  const body = await json(res);
  assert.equal(body.offset, 1);
  // Floored to 1, so it starts at the SECOND entry — not merely "did not crash".
  assert.deepEqual(body.entries.map((e) => e.id), all.slice(1).map((e) => e.id));
});

test('an offset past every row answers an empty page with the total intact', async () => {
  const { base, as, addRender } = await mount();
  as('user-1');
  addRender('user-1');

  // 1e21 is finite but far outside SQLite's integer range, which is the other half of the
  // same crash: `Number('1e21')` is a perfectly good float and a hopeless bind parameter.
  const res = await fetch(`${base}/api/gallery?offset=1e21`);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.entries, []);
  assert.equal(body.offset, MAX_OFFSET, 'clamped, and the response says so');
  assert.equal(body.total, 1, 'the account still has its render');
});

test('junk and negative offsets land on the first page', async () => {
  const { base, as, addRender } = await mount();
  as('user-1');
  addRender('user-1');
  const first = (await json(await fetch(`${base}/api/gallery`))).entries;

  // The last case is `?offset=1&offset=2`, which Express hands over as an ARRAY. Number()
  // of that is NaN, so it lands here with everything else rather than binding an object.
  for (const qs of ['offset=-5', 'offset=abc', 'offset=', 'offset=NaN', 'offset=1&offset=2']) {
    const res = await fetch(`${base}/api/gallery?${qs}`);
    assert.equal(res.status, 200, qs);
    const body = await json(res);
    assert.equal(body.offset, 0, qs);
    assert.deepEqual(body.entries.map((e) => e.id), first.map((e) => e.id), qs);
  }
});

test('a hostile offset is just as safe with a search on', async () => {
  // The search path binds `limit, offset` through a DIFFERENT prepared statement in
  // lib/data/staged-renders.js, so it has the identical hazard and needs the identical
  // proof — fixing only the listing would leave the crash one query parameter away.
  const { base, as, addRender } = await mount();
  as('user-1', 'pro');
  addRender('user-1', { roomType: 'Bedroom' });

  for (const qs of ['offset=1.5&q=bedroom', 'offset=1e21&q=bedroom', 'offset=abc&q=bedroom']) {
    const res = await fetch(`${base}/api/gallery?${qs}`);
    assert.equal(res.status, 200, qs);
    assert.equal((await json(res)).search.q, 'bedroom', qs);
  }
});

test('the page size is the server\'s to decide', async () => {
  // The client cannot ask for a bigger page; `limit` is not read at all. Pinned because a
  // caller-controlled limit is how an offset clamp gets quietly routed around.
  const { base, as, addRender } = await mount();
  as('user-1');
  addRender('user-1');
  const body = await json(await fetch(`${base}/api/gallery?limit=5000&pageSize=5000`));
  assert.equal(body.pageSize, PAGE_SIZE);
});

// ---- caching --------------------------------------------------------------------------

test('every gallery response forbids caching', async () => {
  // The body carries presigned R2 URLs and a live /s/<token> — bearer credentials that
  // happen to live in a URL. Without `no-store` an intermediary may hold them, and the
  // back/forward cache will happily replay a 15-minute-old page as a screen of 404s.
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');
  as('user-1');

  for (const [method, url] of [
    ['GET', `${base}/api/gallery`],
    ['DELETE', `${base}/api/gallery/${id}`],
  ]) {
    const res = await fetch(url, { method });
    assert.equal(res.headers.get('cache-control'), 'no-store', `${method} ${url}`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${method} ${url}`);
  }
});

test('the refusals carry the headers too', async () => {
  // Set before any handler runs, so a 401 and a 404 are protected as well as a 200. A
  // header applied inside the success path is one early return away from being absent.
  const { base, as, addRender } = await mount();
  const id = addRender('user-1');

  as(null);
  const anon = await fetch(`${base}/api/gallery`);
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('cache-control'), 'no-store');

  as('user-2');
  const notMine = await fetch(`${base}/api/gallery/${id}`, { method: 'DELETE' });
  assert.equal(notMine.status, 404);
  assert.equal(notMine.headers.get('cache-control'), 'no-store');
  assert.equal(notMine.headers.get('referrer-policy'), 'no-referrer');
});

test('nothing here is ever publicly cacheable', async () => {
  // Deliberately asserts PRESENCE before content. "No cache-control at all" satisfies
  // "not public" while being the exact bug this section exists to catch — a response with
  // no directive is heuristically cacheable, which is worse than one that says `public`.
  const { base, as, addRender } = await mount();
  addRender('user-1');
  as('user-1');
  const res = await fetch(`${base}/api/gallery`);
  const cc = res.headers.get('cache-control');
  assert.ok(cc, 'no cache-control at all is the failure mode, not a pass');
  assert.ok(!/public|max-age=[1-9]/.test(cc), `cache-control was ${cc}`);
});

// ---- the gallery being switched off --------------------------------------------------

test('a disabled object store answers an empty gallery, not a 500', async () => {
  // On Render with no R2 the gallery is off by design. The page renders its empty state
  // and says why; a 500 would look like a broken account.
  const { base, as, addRender, shares } = await mount({ objectStore: createDisabledObjectStore() });
  const id = addRender('user-1');
  as('user-1');
  const res = await fetch(`${base}/api/gallery`);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.entries, []);
  assert.equal(body.enabled, false);
  // And it mints nothing on the way out. The listing writes now, so the early return has
  // to happen BEFORE that — a deployment with no bucket would otherwise fill the table
  // with links to bytes it cannot serve.
  assert.equal(shares.activeForRender(id), null);
});
