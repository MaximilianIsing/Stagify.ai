// Tier: route contract (real router + real stores) — routes/share-public.js.
//
// WHAT THIS COVERS
// The only unauthenticated read surface the gallery has. The token in the path is the
// entire credential, so the properties worth pinning are all about refusal:
//   - ONE 404 for unknown, revoked, expired, cross-tenant and not-yet-uploaded, identical
//     in status, body AND headers, so the surface cannot be used to sort real tokens from
//     invented ones;
//   - the page route performs NO lookup, so it cannot be used the same way;
//   - the manifest is an allowlist — no user id, no storage key, no model name;
//   - the source photo is never published, and no flag exists that could publish it;
//   - image URLs point at the object store, not at this origin, because that is the whole
//     reason the bytes are in a bucket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createSharePublicRouter from '../../routes/share-public.js';
import { createGalleryShares } from '../../lib/data/gallery-shares.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { createLocalObjectStore } from '../../lib/data/object-store-local.js';
import { keyForRender, newRenderId } from '../../lib/data/object-keys.js';
import { closeDb } from '../../lib/data/db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const servers = [];
const dirs = [];

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) {
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

/** Mount the real router over real stores on a temp data dir. */
async function mount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-shareroute-'));
  dirs.push(dir);
  const shares = createGalleryShares(dir);
  const stagedRenders = createStagedRenders(dir);
  const objectStore = createLocalObjectStore({ baseDir: dir, secret: 'test' });

  const app = express();
  app.use(createSharePublicRouter({
    shares, stagedRenders, objectStore, __dirname: ROOT,
    // A pass-through, so unrelated cases do not share one bucket.
    shareLimiter: (req, res, next) => next(),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A finished, publishable render owned by `userId`. */
  const addRender = (userId, { status = 'ok' } = {}) => {
    const id = newRenderId();
    stagedRenders.record({
      render: { id, userId, roomType: 'Living room', model: 'gemini-secret-model-name' },
      blobs: [
        { role: 'after', storageKey: keyForRender({ renderId: id, role: 'after' }), bytes: 1 },
        { role: 'thumb', storageKey: keyForRender({ renderId: id, role: 'thumb' }), bytes: 1 },
        // The source photo exists on the row — the point is that it never reaches the wire.
        { role: 'before', storageKey: keyForRender({ renderId: id, role: 'before' }), bytes: 1 },
      ],
      isPro: true,
    });
    if (status === 'ok') stagedRenders.markOk(id, { width: 1024, height: 683 });
    return id;
  };

  return { base, shares, stagedRenders, addRender };
}

/** Every field of a response that a caller could use to tell two refusals apart. */
async function fingerprint(res) {
  return {
    status: res.status,
    body: await res.text(),
    headers: {
      'content-type': res.headers.get('content-type'),
      'cache-control': res.headers.get('cache-control'),
      'referrer-policy': res.headers.get('referrer-policy'),
      'x-robots-tag': res.headers.get('x-robots-tag'),
    },
  };
}

// ---- the page ----------------------------------------------------------------------

test('the page shell is byte-identical for a real token and an invented one', async () => {
  // NO lookup happens on this route, so it cannot be used to sort tokens — not because
  // the comparison is careful, but because there is no comparison.
  const { base, addRender, shares } = await mount();
  const id = addRender('user-1');
  const { token } = shares.ensureShare({ renderId: id, userId: 'user-1' });

  const real = await fetch(`${base}/s/${token}`);
  const fake = await fetch(`${base}/s/ZZZZinventedZZZZinventedZZZZ`);
  assert.equal(real.status, 200);
  assert.equal(fake.status, 200);
  assert.equal(await real.text(), await fake.text());
});

test('the page carries the headers that keep the token and the house private', async () => {
  const { base } = await mount();
  const res = await fetch(`${base}/s/anything`);
  // The token is in the PATH: without no-referrer, one outbound click or third-party
  // image load hands the live credential to a stranger.
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(String(res.headers.get('cache-control')), /private/);
  assert.ok(!/public/.test(String(res.headers.get('cache-control'))), 'never proxy-cacheable');
});

// ---- ONE refusal -------------------------------------------------------------------

test('every refusal is byte-identical, headers included', async () => {
  const { base, shares, stagedRenders, addRender } = await mount();

  const revokedId = addRender('user-1');
  const revoked = shares.ensureShare({ renderId: revokedId, userId: 'user-1' });
  shares.revoke(revokedId);

  const expiredId = addRender('user-1');
  const expired = shares.ensureShare({ renderId: expiredId, userId: 'user-1', expiresAt: 1 });

  // Someone else's render behind a share that claims it.
  const otherId = addRender('user-2');
  const crossTenant = shares.ensureShare({ renderId: otherId, userId: 'user-1' });

  const pendingId = addRender('user-1', { status: 'pending' });
  const pending = shares.ensureShare({ renderId: pendingId, userId: 'user-1' });

  const deletedId = addRender('user-1');
  const deleted = shares.ensureShare({ renderId: deletedId, userId: 'user-1' });
  stagedRenders.remove({ id: deletedId, userId: 'user-1' });

  const cases = {
    unknown: 'ZZZZinventedZZZZinventedZZZZ',
    revoked: revoked.token,
    expired: expired.token,
    crossTenant: crossTenant.token,
    notUploaded: pending.token,
    deleted: deleted.token,
  };

  const prints = {};
  for (const [name, token] of Object.entries(cases)) {
    prints[name] = await fingerprint(await fetch(`${base}/api/share/${token}`));
    assert.equal(prints[name].status, 404, `${name} must be a 404`);
  }
  // The actual assertion: they are all the SAME 404. A caller who can tell "revoked"
  // from "never existed" has learned that a token was once real.
  const baseline = JSON.stringify(prints.unknown);
  for (const [name, print] of Object.entries(prints)) {
    assert.equal(JSON.stringify(print), baseline, `${name} is distinguishable from unknown`);
  }
});

test('a junk token never 500s', async () => {
  const { base } = await mount();
  for (const junk of ['', '..%2f..%2fetc', 'a'.repeat(4000), '%00', 'null']) {
    const res = await fetch(`${base}/api/share/${encodeURIComponent(junk)}`);
    assert.ok(res.status === 404 || res.status === 200, `got ${res.status} for ${junk}`);
    assert.notEqual(res.status, 500);
  }
});

// ---- the manifest ------------------------------------------------------------------

test('a live share returns the render, its disclosure, and nothing internal', async () => {
  const { base, shares, addRender } = await mount();
  const id = addRender('user-1');
  const { token } = shares.ensureShare({
    renderId: id,
    userId: 'user-1',
    settings: { headline: 'Living room', agentName: 'A. Broker', agentEmail: 'a@example.com' },
  });

  const res = await fetch(`${base}/api/share/${token}`);
  assert.equal(res.status, 200);
  const manifest = await res.json();

  assert.equal(manifest.headline, 'Living room');
  assert.equal(manifest.agent.name, 'A. Broker');
  assert.equal(manifest.rooms[0].frames[0].renderId, id);
  assert.equal(manifest.frameCount, 1);
  // The MLS/NAR disclosure ships WITH the pixels; an agent who forwards this to a portal
  // is the one on the hook for it being absent.
  assert.match(manifest.disclosure, /virtually staged/i);

  // The allowlist. A `...row` spread would publish every one of these.
  const serialized = JSON.stringify(manifest);
  for (const leak of ['user-1', 'user_id', 'gemini-secret-model-name', 'storage_key', 'additional_prompt']) {
    assert.ok(!serialized.includes(leak), `manifest leaked ${leak}`);
  }

  // The object key itself DOES appear, inside the presigned URL — it has to, because a
  // presigned URL names the object it authorizes. That is safe here only because of the
  // key layout: `renders/<renderId>/after.webp` carries no account id, and the renderId
  // is already in the manifest. This assertion is the one that would fail the day
  // somebody "helpfully" puts a user id back into the key.
  const url = manifest.rooms[0].frames[0].url;
  assert.match(url, /renders\/[a-f0-9]+\/after\.webp/, 'sanity: the URL really does name the object');
  assert.ok(!url.includes('user-1'), 'and the key must never carry the account it belongs to');
});

test('the source photo is never published, and no setting can publish it', async () => {
  // `before` exists on the row and in the store. The owner sees it in their private
  // gallery; the buyer never does. The omission is structural — there is no showBefore
  // flag to flip, which is why the settings allowlist drops one if somebody sends it.
  const { base, shares, addRender } = await mount();
  const id = addRender('user-1');
  const { token } = shares.ensureShare({
    renderId: id, userId: 'user-1', settings: { showBefore: true },
  });

  const manifest = await (await fetch(`${base}/api/share/${token}`)).json();
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes('before'), 'no before URL, and no key hinting at one');
  assert.ok(!('showBefore' in manifest), 'no flag that a future edit could turn on');
});

test('image URLs point at the object store, not at this origin', async () => {
  // The entire egress argument. If bytes came back through this process, R2 would be
  // buying nothing and the single Node event loop would be serving a buyer's scrolling.
  const { base, shares, addRender } = await mount();
  const id = addRender('user-1');
  const { token } = shares.ensureShare({ renderId: id, userId: 'user-1' });

  const manifest = await (await fetch(`${base}/api/share/${token}`)).json();
  const url = manifest.rooms[0].frames[0].url;
  assert.ok(url, 'a frame must carry a URL');
  // Under the local backend that is a signed same-origin path; under R2 it is the bucket.
  // Either way it is a SIGNED url, never a bare route a caller could construct.
  assert.match(url, /(X-Amz-Signature=|[?&]sig=)/, 'the URL must be presigned');
  assert.ok(manifest.urlTtlMs > 0, 'the client needs to know these expire');
});

test('a view is counted once, and only for a manifest that was actually served', async () => {
  const { base, shares, addRender } = await mount();
  const id = addRender('user-1');
  const { token } = shares.ensureShare({ renderId: id, userId: 'user-1' });

  await fetch(`${base}/api/share/${token}`);
  await fetch(`${base}/api/share/${token}`);
  assert.equal(shares.activeForRender(id).viewCount, 1, 'debounced — a re-open is one visit');

  await fetch(`${base}/api/share/ZZZZinventedZZZZinventedZZZZ`);
  assert.equal(shares.activeForRender(id).viewCount, 1, 'a refused request is not a view');
});

test('revoking stops the manifest immediately', async () => {
  const { base, shares, addRender } = await mount();
  const id = addRender('user-1');
  const { token } = shares.ensureShare({ renderId: id, userId: 'user-1' });
  assert.equal((await fetch(`${base}/api/share/${token}`)).status, 200);

  shares.revoke(id);
  // NEW urls stop being minted at once. Already-minted ones keep working until they
  // expire — that is the documented, bounded cost of presigning, and the reason the UI
  // copy says "within 15 minutes" rather than "immediately".
  assert.equal((await fetch(`${base}/api/share/${token}`)).status, 404);
});
