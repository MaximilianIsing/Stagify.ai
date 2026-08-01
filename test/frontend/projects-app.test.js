// Tier: frontend island logic (DOM-stubbed) — the Listing Studio, public/projects.html
// and the modules under public/scripts/projects/.
//
// WHAT IS WORTH PINNING HERE, and why each one is a quiet failure rather than a crash:
//
//  1. ROOM GROUPING AND HERO ORDER. The auto-clustering is a first draft the operator
//     overrides, so the grid must survive a room with NO hero and a room with TWO (both
//     happen: nothing marked yet, and an in-flight override). A filter-and-prepend
//     implementation drops or duplicates a frame in those cases and looks fine in the
//     happy path.
//  2. THE PROGRESS-COMPLETE PREDICATE. `queued + running === 0` is TRUE before the
//     backend has enqueued anything, so the naive version stops the poller on its first
//     tick and the operator watches an idle page forever.
//  3. BLOB-URL REVOCATION ON REPLACE. Render bytes reach an <img> only as object URLs,
//     and the before/after toggle rewrites the same key. Overwriting without revoking
//     leaks the old blob — invisible until a long session over a 90-render listing.
//     Equally: re-setting the SAME url must NOT revoke, or the live image goes blank.
//  4. THE MISSING-BIBLE DECISION. The backend reports a room whose renders had no look
//     bible instead of hiding it; the banner is the UI half of that promise. It must
//     fire when renders exist without a bible, and must NOT fire for a room that simply
//     has not been staged yet — a banner that cries wolf is one the operator learns to
//     ignore.
//  5. THE HERO SWAP IS A PAIR. Promoting a frame without demoting the previous hero
//     leaves the room with two.
//
// No jsdom (the house style is a hand-rolled shim per surface); the DOM stub is the
// shared test/helpers/admin-dom.js element factory. Everything asserted below is pure,
// except the entry's boot guard, which is driven directly.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEl } from '../helpers/admin-dom.js';

import {
  apiErrorMessage,
  authHeaders,
  photoImagePath,
  photoPath,
  projectPath,
  renderImagePath,
} from '../../public/scripts/projects/api.js';
import {
  ROOM_UNASSIGNED,
  groupByRoom,
  isProgressComplete,
  makeProjectsStore,
  needsConsistencyWarning,
  progressPercent,
  progressSummary,
  roomLabel,
  roomsMissingBible,
  sortRenders,
  sortRoomPhotos,
} from '../../public/scripts/projects/state.js';
import { makeBlobRegistry } from '../../public/scripts/projects/render-grid.js';
// formatScore moved to ./scores.js when the grid was split at the 650-line cap; it lives
// with the rest of the score presentation (the /100 scale and the "Not checked" label).
import { formatScore } from '../../public/scripts/projects/scores.js';
import {
  MAX_PHOTOS,
  heroPatchesFor,
  nextRoomKey,
  rejectionMessage,
  validateFiles,
} from '../../public/scripts/projects/upload.js';

// ── The entry module, imported behind a DOM stub ─────────────────────────────
// projects-app.js boots itself on import (like admin.js), guarded on #pj-root. The
// stub is installed FIRST so the guard is what decides, not a missing global.

/** Ids the stub document will admit to having. */
const present = new Set();
/** Every document-level listener the module registers, so inertness is observable. */
/** @type {string[]} */
const documentListeners = [];

// Restored when the file finishes: `node --test` isolates each spec file in its own
// process today, but a leaked DOM stub is the classic cause of an unreproducible failure
// in an unrelated file, and a spec should not depend on the runner's isolation mode.
// Same discipline as test/helpers/auth-modal-dom.js.
const savedDocument = globalThis.document;
after(() => {
  globalThis.document = savedDocument;
});

globalThis.document = /** @type {any} */ ({
  documentElement: makeEl('html'),
  visibilityState: 'visible',
  getElementById: (id) => (present.has(id) ? makeEl('div') : null),
  createElement: (tag) => makeEl(tag),
  addEventListener: (type) => documentListeners.push(String(type)),
});

const projectsApp = await import('../../public/scripts/projects-app.js');

// ── api.js: paths and error copy ─────────────────────────────────────────────

test('paths are built from the project root and escape their segments', () => {
  assert.equal(projectPath('abc'), '/api/projects/abc');
  assert.equal(photoPath('abc', 'p1'), '/api/projects/abc/photos/p1');
  assert.equal(renderImagePath('abc', 'r9'), '/api/projects/abc/renders/r9/image');
  assert.equal(photoImagePath('abc', 'p1'), '/api/projects/abc/photos/p1/image');
  // An id is server-generated, but it lands in a URL — never interpolate it raw.
  assert.equal(renderImagePath('a/b', 'r 1'), '/api/projects/a%2Fb/renders/r%201/image');
});

test('the render and photo image routes are distinct', () => {
  // They differ by one path segment and both take a listing id; a copy-paste that
  // pointed "before" at the render would silently compare a render with itself.
  assert.notEqual(renderImagePath('a', 'x'), photoImagePath('a', 'x'));
});

test("a server-supplied error message wins over the status fallback", () => {
  assert.equal(apiErrorMessage(400, { error: '  too many photos  ' }), 'too many photos');
});

test('every status the UI can hit has a sentence, and none of them leak internals', () => {
  for (const status of [0, 401, 403, 404, 409, 413, 429, 500, 418]) {
    const message = apiErrorMessage(status, null);
    assert.ok(message.length > 8, `status ${status} needs real copy`);
    assert.ok(!/undefined|null|\[object/i.test(message), `status ${status} leaked a placeholder`);
  }
});

test('a non-string error field falls back rather than rendering an object', () => {
  assert.equal(apiErrorMessage(500, { error: { deep: 'detail' } }), apiErrorMessage(500, null));
});

test('authHeaders carries the bearer token and never sets Content-Type', () => {
  // Content-Type must stay absent: the multipart upload relies on the browser setting
  // it WITH the boundary, and a hard-coded one makes the server unable to parse it.
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { getToken: () => 'tok-123' } });
  globalThis.localStorage = /** @type {any} */ ({ getItem: () => 'from-storage' });
  try {
    const headers = authHeaders();
    assert.equal(headers.Authorization, 'Bearer tok-123', 'auth.js is the preferred source');
    assert.ok(!('Content-Type' in headers));
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

test('authHeaders omits Authorization entirely when there is no token', () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = /** @type {any} */ ({});
  globalThis.localStorage = /** @type {any} */ ({ getItem: () => null });
  try {
    assert.ok(!('Authorization' in authHeaders()), 'no empty "Bearer " header');
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

// ── state.js: the store ──────────────────────────────────────────────────────

test('the store notifies subscribers with the patched state', () => {
  const store = makeProjectsStore();
  /** @type {number[]} */
  const seen = [];
  store.subscribe((state) => seen.push(state.photos.length));
  store.set({ photos: [{ id: 'p1' }] });
  assert.deepEqual(seen, [1]);
  assert.equal(store.get().photos.length, 1);
});

test('unsubscribing stops the notifications', () => {
  const store = makeProjectsStore();
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  store.set({ loading: true });
  off();
  store.set({ loading: false });
  assert.equal(calls, 1);
});

test('a subscriber that unsubscribes mid-notify does not skip its neighbour', () => {
  // Iterating the live Set would drop the second listener here.
  const store = makeProjectsStore();
  let second = 0;
  const off = store.subscribe(() => off());
  store.subscribe(() => { second += 1; });
  store.set({ loading: true });
  assert.equal(second, 1);
});

test('reset clears the open listing but keeps the picker populated', () => {
  const store = makeProjectsStore({ projects: [{ id: 'a', title: 'A', address: '' }] });
  store.set({ photos: [{ id: 'p1' }], progress: { total: 3 } });
  store.reset();
  assert.equal(store.get().projects.length, 1, 'the picker must survive a delete');
  assert.equal(store.get().photos.length, 0);
  assert.equal(store.get().progress, null);
});

// ── state.js: grouping and hero order ────────────────────────────────────────

/** @type {any[]} */
const PHOTOS = [
  { id: 'p3', roomKey: 'living', roomType: 'living room', seq: 3 },
  { id: 'p1', roomKey: 'living', seq: 1 },
  { id: 'p2', roomKey: 'living', seq: 2, frameRole: 'hero' },
  { id: 'p4', roomKey: 'kitchen', seq: 4 },
  { id: 'p5', seq: 9 },
];

test('photos group by room, in shoot order, with unassigned pinned last', () => {
  const groups = groupByRoom(PHOTOS, [], []);
  assert.deepEqual(groups.map((g) => g.roomKey), ['living', 'kitchen', ROOM_UNASSIGNED]);
});

test('the marked hero leads its room even when it is not the earliest frame', () => {
  const [living] = groupByRoom(PHOTOS, [], []);
  assert.deepEqual(living.frames.map((f) => f.photo.id), ['p2', 'p1', 'p3']);
  assert.deepEqual(living.frames.map((f) => f.isHero), [true, false, false]);
});

test('a room with no marked hero still gets exactly one lead frame', () => {
  const [kitchenLess] = groupByRoom(
    [{ id: 'b', roomKey: 'den', seq: 2 }, { id: 'a', roomKey: 'den', seq: 1 }],
    [],
    []
  );
  assert.deepEqual(kitchenLess.frames.map((f) => f.photo.id), ['a', 'b']);
  assert.equal(kitchenLess.frames.filter((f) => f.isHero).length, 1);
});

test('a room with TWO marked heroes keeps both frames and still leads with one', () => {
  // Reachable while an override is in flight. Dropping a frame here would hide a photo.
  const [group] = groupByRoom(
    [
      { id: 'a', roomKey: 'den', seq: 1, frameRole: 'hero' },
      { id: 'b', roomKey: 'den', seq: 2, frameRole: 'hero' },
      { id: 'c', roomKey: 'den', seq: 3 },
    ],
    [],
    []
  );
  assert.equal(group.frames.length, 3, 'no frame is dropped');
  assert.equal(group.frames.filter((f) => f.isHero).length, 1, 'and none is duplicated as lead');
});

test('sortRoomPhotos does not mutate its input', () => {
  const input = [{ id: 'b', seq: 2 }, { id: 'a', seq: 1 }];
  sortRoomPhotos(input);
  assert.deepEqual(input.map((p) => p.id), ['b', 'a']);
});

test('renders attach to their own photo, in variation order', () => {
  const renders = [
    { id: 'r2', photoId: 'p2', variation: 2, status: 'ok' },
    { id: 'r1', photoId: 'p2', variation: 1, status: 'ok' },
    { id: 'r3', photoId: 'p4', variation: 1, status: 'ok' },
  ];
  const groups = groupByRoom(PHOTOS, renders, []);
  const living = groups[0];
  assert.deepEqual(living.frames[0].renders.map((r) => r.id), ['r1', 'r2']);
  assert.equal(living.renderCount, 2);
  assert.equal(groups[1].renderCount, 1, 'the kitchen keeps its own render');
});

test('superseded renders sort after live ones, so the current look shows first', () => {
  const sorted = sortRenders([
    { id: 'old', photoId: 'p', variation: 1, status: 'superseded' },
    { id: 'new', photoId: 'p', variation: 2, status: 'ok' },
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ['new', 'old']);
});

test('the highest bible version wins for a room', () => {
  const groups = groupByRoom(
    [{ id: 'a', roomKey: 'living', seq: 1 }],
    [],
    [
      { id: 'b1', roomKey: 'living', version: 1 },
      { id: 'b2', roomKey: 'living', version: 2 },
    ]
  );
  assert.equal(groups[0].bible.id, 'b2');
});

// ── state.js: the missing-bible decision ─────────────────────────────────────

test('COMPLETED renders without a bible raise the consistency warning', () => {
  assert.equal(needsConsistencyWarning({ bible: null, okRenderCount: 4 }), true);
});

test('a room that has merely been QUEUED does not raise it yet', () => {
  // The banner used to key on `renderCount`, which counts queued and running rows — so the
  // instant the operator pressed Stage, every room shouted "Consistency was not enforced"
  // about a run that had produced nothing. A warning that fires on every room every time is
  // one the operator learns to ignore, which costs exactly the case it exists for.
  assert.equal(needsConsistencyWarning({ bible: null, okRenderCount: 0, renderCount: 6 }), false);
});

test('an unstaged room does NOT raise it — no renders, nothing to warn about', () => {
  assert.equal(needsConsistencyWarning({ bible: null, renderCount: 0 }), false);
});

test('a room with a bible never raises it', () => {
  assert.equal(needsConsistencyWarning({ bible: { id: 'b', roomKey: 'r' }, renderCount: 4 }), false);
});

test('groupByRoom carries the warning through, and roomsMissingBible names the rooms', () => {
  const groups = groupByRoom(
    [
      { id: 'a', roomKey: 'living', seq: 1 },
      { id: 'b', roomKey: 'kitchen', seq: 2 },
      { id: 'c', roomKey: 'den', seq: 3 },
    ],
    [
      { id: 'r1', photoId: 'a', status: 'ok' },
      { id: 'r2', photoId: 'b', status: 'ok' },
    ],
    [{ id: 'bible-1', roomKey: 'living', version: 1 }]
  );
  const byKey = new Map(groups.map((g) => [g.roomKey, g]));
  assert.equal(byKey.get('living').bibleMissing, false, 'has a bible');
  assert.equal(byKey.get('kitchen').bibleMissing, true, 'rendered unconditioned');
  assert.equal(byKey.get('den').bibleMissing, false, 'never staged');
  assert.deepEqual(roomsMissingBible(groups), ['kitchen']);
});

test('a room never renders as a blank heading', () => {
  assert.equal(roomLabel('living', 'living room'), 'living room');
  assert.equal(roomLabel('living', ''), 'living');
  assert.equal(roomLabel(ROOM_UNASSIGNED, ''), 'Unassigned');
});

// ── state.js: progress ───────────────────────────────────────────────────────

test('an empty queue is NOT complete — that is what stops the poller dying at tick one', () => {
  assert.equal(isProgressComplete({ queued: 0, running: 0, total: 0 }), false);
  assert.equal(isProgressComplete(null), false);
  assert.equal(isProgressComplete(undefined), false);
  assert.equal(isProgressComplete({}), false);
});

test('a drained, non-empty queue is complete', () => {
  assert.equal(isProgressComplete({ queued: 0, running: 0, ok: 6, total: 6 }), true);
  assert.equal(isProgressComplete({ queued: 0, running: 0, ok: 4, failed: 2, total: 6 }), true);
});

test('work still in flight is not complete', () => {
  assert.equal(isProgressComplete({ queued: 1, running: 0, ok: 5, total: 6 }), false);
  assert.equal(isProgressComplete({ queued: 0, running: 1, ok: 5, total: 6 }), false);
});

test('progressPercent counts every settled frame and stays inside 0..100', () => {
  assert.equal(progressPercent(null), 0);
  assert.equal(progressPercent({ total: 0, ok: 3 }), 0, 'no division by zero');
  assert.equal(progressPercent({ total: 4, ok: 1 }), 25);
  assert.equal(progressPercent({ total: 4, ok: 2, failed: 1, superseded: 1 }), 100);
  assert.equal(progressPercent({ total: 4, ok: 99 }), 100, 'clamped');
});

test('the progress summary names all four counters', () => {
  const summary = progressSummary({ queued: 1, running: 2, ok: 3, failed: 4, total: 10 });
  for (const part of ['1 queued', '2 running', '3 done', '4 failed']) {
    assert.ok(summary.includes(part), `summary is missing "${part}": ${summary}`);
  }
  assert.equal(progressSummary(null), 'No staging run yet.');
});

// ── render-grid.js: object-URL ownership ─────────────────────────────────────

/** A registry plus the list of URLs it revoked. */
function trackedRegistry() {
  /** @type {string[]} */
  const revoked = [];
  return { revoked, registry: makeBlobRegistry({ revoke: (url) => revoked.push(url) }) };
}

test('replacing a key revokes the URL it replaced', () => {
  const { revoked, registry } = trackedRegistry();
  registry.set('/a', 'blob:1');
  registry.set('/a', 'blob:2');
  assert.deepEqual(revoked, ['blob:1'], 'the displaced URL must be given back');
  assert.equal(registry.get('/a'), 'blob:2');
  assert.equal(registry.count(), 1, 'and it replaced, not accumulated');
});

test('re-setting the SAME url does not revoke the live one', () => {
  // The before/after toggle re-asks for a path it already holds. Revoking here blanks
  // the <img> that is displaying it.
  const { revoked, registry } = trackedRegistry();
  registry.set('/a', 'blob:1');
  registry.set('/a', 'blob:1');
  assert.deepEqual(revoked, []);
  assert.equal(registry.get('/a'), 'blob:1');
});

test('release revokes one key and is a no-op for an unknown one', () => {
  const { revoked, registry } = trackedRegistry();
  registry.set('/a', 'blob:1');
  registry.release('/a');
  registry.release('/a');
  registry.release('/never-held');
  assert.deepEqual(revoked, ['blob:1']);
  assert.equal(registry.get('/a'), null);
});

test('releaseAll gives back every URL', () => {
  const { revoked, registry } = trackedRegistry();
  registry.set('/a', 'blob:1');
  registry.set('/b', 'blob:2');
  registry.releaseAll();
  assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2']);
  assert.equal(registry.count(), 0);
});

test('retain keeps what is still on screen and revokes only the rest', () => {
  // This is what a redraw uses. releaseAll there would re-download every visible
  // render on every 2.5s poll tick.
  const { revoked, registry } = trackedRegistry();
  registry.set('/a', 'blob:1');
  registry.set('/b', 'blob:2');
  registry.set('/c', 'blob:3');
  registry.retain(['/a', '/c']);
  assert.deepEqual(revoked, ['blob:2']);
  assert.deepEqual([registry.get('/a'), registry.get('/b'), registry.get('/c')], [
    'blob:1',
    null,
    'blob:3',
  ]);
});

test('retain with nothing live is equivalent to releaseAll', () => {
  const { revoked, registry } = trackedRegistry();
  registry.set('/a', 'blob:1');
  registry.retain([]);
  assert.deepEqual(revoked, ['blob:1']);
  assert.equal(registry.count(), 0);
});

test('a missing score reads as no result, not a bad one', () => {
  // "Not checked", never an em dash: the dash was identical to the placeholder a hero frame
  // shows for a score it never had, so "nobody looked" and "looked, found nothing wrong"
  // rendered the same. And the judges emit 0-100, not 0-1.
  assert.equal(formatScore(null), 'Not checked');
  assert.equal(formatScore(undefined), 'Not checked');
  assert.equal(formatScore(Number.NaN), 'Not checked');
  assert.equal(formatScore(0), '0 / 100', 'a real zero is still a score');
  assert.equal(formatScore(87.4), '87 / 100', 'rounded — two decimals on an integer scale is false precision');
});

// ── upload.js: intake validation ─────────────────────────────────────────────

/** @param {{ name?: string, type?: string, size?: number }} attrs */
const fakeFile = (attrs = {}) => ({
  name: attrs.name ?? 'shot.jpg',
  type: attrs.type ?? 'image/jpeg',
  size: attrs.size ?? 2048,
});

test('an ordinary batch is accepted whole', () => {
  const files = [fakeFile({ name: 'a.jpg' }), fakeFile({ name: 'b.png', type: 'image/png' })];
  const { accepted, rejected } = validateFiles(files);
  assert.equal(accepted.length, 2);
  assert.deepEqual(rejected, []);
  assert.equal(rejectionMessage(rejected), '');
});

test('the batch is capped, and the overflow is reported rather than dropped', () => {
  const files = Array.from({ length: MAX_PHOTOS + 5 }, (_, i) => fakeFile({ name: `${i}.jpg` }));
  const { accepted, rejected } = validateFiles(files);
  assert.equal(accepted.length, MAX_PHOTOS);
  assert.equal(rejected.length, 5);
  assert.ok(rejectionMessage(rejected).includes(`${MAX_PHOTOS}-photo limit`));
});

test('wrong type, oversize and empty files are each rejected with their own reason', () => {
  const { accepted, rejected } = validateFiles([
    fakeFile({ name: 'raw.cr2', type: 'image/x-canon-cr2' }),
    fakeFile({ name: 'huge.jpg', size: 40 * 1024 * 1024 }),
    fakeFile({ name: 'zero.jpg', size: 0 }),
    fakeFile({ name: 'fine.webp', type: 'image/webp' }),
  ]);
  assert.deepEqual(accepted.map((f) => f.name), ['fine.webp']);
  assert.deepEqual(rejected.map((r) => r.reason).sort(), ['empty', 'size', 'type']);
  const message = rejectionMessage(rejected);
  assert.ok(message.includes('Skipped 3 file(s)'), message);
});

test('HEIC is identified as HEIC, not lumped in with unsupported types', () => {
  // The default iPhone export IS HEIC, so "not a JPEG, PNG or WebP" was a hard stop for a
  // plausible first-run user, with no hint about what to do. It carries its own reason so
  // the conversion path and the message can address it specifically.
  const { accepted, rejected } = validateFiles([fakeFile({ name: 'IMG.heic', type: 'image/heic' })]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].reason, 'heic');
});

test('an empty pick is handled without throwing', () => {
  assert.deepEqual(validateFiles([]), { accepted: [], rejected: [] });
  assert.deepEqual(validateFiles(null), { accepted: [], rejected: [] });
});

// ── upload.js: overriding the clustering ─────────────────────────────────────

test('promoting a hero also demotes the one it replaces', () => {
  const photos = [
    { id: 'a', roomKey: 'living', frameRole: 'hero' },
    { id: 'b', roomKey: 'living' },
  ];
  assert.deepEqual(heroPatchesFor(photos, 'b'), [
    { photoId: 'b', fields: { frameRole: 'hero' } },
    { photoId: 'a', fields: { frameRole: 'support' } },
  ]);
});

test('the demotion is scoped to the same room', () => {
  const photos = [
    { id: 'a', roomKey: 'living', frameRole: 'hero' },
    { id: 'b', roomKey: 'kitchen', frameRole: 'hero' },
    { id: 'c', roomKey: 'kitchen' },
  ];
  const patches = heroPatchesFor(photos, 'c');
  assert.deepEqual(patches.map((p) => p.photoId), ['c', 'b'], "living's hero is untouched");
});

test('promoting a room with no hero yet is a single patch', () => {
  assert.deepEqual(heroPatchesFor([{ id: 'a', roomKey: 'living' }], 'a'), [
    { photoId: 'a', fields: { frameRole: 'hero' } },
  ]);
});

test('promoting the current hero is a no-op, so a double click is not two requests', () => {
  assert.deepEqual(heroPatchesFor([{ id: 'a', roomKey: 'living', frameRole: 'hero' }], 'a'), []);
});

test('an unknown photo yields no patches', () => {
  assert.deepEqual(heroPatchesFor([{ id: 'a' }], 'nope'), []);
});

test('a new room key never collides with one already in use', () => {
  assert.equal(nextRoomKey([]), 'room-1');
  assert.equal(nextRoomKey([{ id: 'a', roomKey: 'room-1' }]), 'room-2');
  assert.equal(
    nextRoomKey([{ id: 'a', roomKey: 'room-1' }, { id: 'b', roomKey: 'room-2' }]),
    'room-3'
  );
});

// ── projects-app.js: the access decision and the boot guard ──────────────────

test('no user is a redirect, not an upgrade prompt', () => {
  // We do not know who they are — a token that is missing, expired or rejected by /me
  // all land here. Showing them the upgrade dialog would reveal the page shell.
  assert.equal(projectsApp.proAccessDecision(null), 'redirect');
  assert.equal(projectsApp.proAccessDecision(undefined), 'redirect');
});

test('a signed-in free user gets the upgrade dialog', () => {
  assert.equal(projectsApp.proAccessDecision({ plan: 'free' }), 'upgrade');
  assert.equal(projectsApp.proAccessDecision({}), 'upgrade');
});

test('only plan "pro" is allowed in', () => {
  assert.equal(projectsApp.proAccessDecision({ plan: 'pro' }), 'allow');
  assert.equal(projectsApp.proAccessDecision({ plan: 'Pro' }), 'upgrade', 'no case fuzzing');
  assert.equal(projectsApp.proAccessDecision({ plan: 'pro-trial' }), 'upgrade');
});

test('a listing always has a label, whatever the server sent', () => {
  assert.equal(projectsApp.projectLabel({ title: 'A', address: 'B' }), 'A — B');
  assert.equal(projectsApp.projectLabel({ title: 'A' }), 'A');
  assert.equal(projectsApp.projectLabel({ address: 'B' }), 'B');
  assert.equal(projectsApp.projectLabel({}), 'Untitled listing');
  assert.equal(projectsApp.projectLabel({ title: '   ' }), 'Untitled listing');
});

test('the poll interval and empty-poll bound are real values', () => {
  assert.equal(typeof projectsApp.POLL_INTERVAL_MS, 'number');
  assert.ok(projectsApp.POLL_INTERVAL_MS >= 1000, 'do not hammer the endpoint');
  assert.ok(projectsApp.MAX_EMPTY_POLLS > 0, 'the never-started case must be bounded');
});

test('importing the entry off its own page is inert', () => {
  // The import above already ran the boot. With no #pj-root it must have returned
  // before touching a single element, and registered no document listeners.
  assert.deepEqual(documentListeners, []);
  assert.equal(projectsApp.initProjectsPage(), undefined);
});

test('the #pj-root guard is what makes that inert — not an empty init', () => {
  // Hand it a root but none of the page's other markup: init has to get PAST the guard
  // and then fail on a real element. If this did not throw, the test above would be
  // asserting nothing at all, which is exactly how a vacuous guard ships.
  present.add('pj-root');
  try {
    assert.throws(() => projectsApp.initProjectsPage());
  } finally {
    present.delete('pj-root');
  }
});
