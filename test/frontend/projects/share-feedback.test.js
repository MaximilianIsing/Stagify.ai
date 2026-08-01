// Tier: frontend island logic (DOM-stubbed) — the Listing Studio's "What your client sent
// back" block (public/scripts/projects/share-feedback.js), the broker's end of the seller
// sign-off that arrives through the client share link.
//
// Same harness as test/frontend/projects/share-panel.test.js: no jsdom, the shared element
// factory from test/helpers/admin-dom.js, real modules everywhere else. It mounts through
// `mountSharePanel` rather than calling `mountShareFeedback` directly, because the wiring is
// part of the claim — the feedback block has no entry of its own (projects-app.js is on the
// 650-line ceiling), so "share-panel mounts it" is exactly the thing that would silently
// stop being true.
//
// WHAT IS ACTUALLY WORTH PINNING HERE:
//
//  1. THE LOG IS NOT THE STATE. Feedback rows are append-only: a seller who asks for changes
//     and then approves the same room leaves TWO rows behind. Rendering both shows that room
//     as approved AND rejected at once, which is precisely the ambiguity this panel exists
//     to remove. `latestPerRoom` is asserted on the CURRENT position — and on a payload
//     whose order is wrong, because "the route sorts newest-first" is a property of a query
//     that a future `ORDER BY` can invert while everything still looks plausible.
//  2. A LISTING-LEVEL RESPONSE IS NOT A ROOM. `roomKey: null` is feedback about the whole
//     listing; it gets its own label and is counted separately, or "3 rooms approved"
//     overstates how much of the shoot is signed off.
//  3. NO NAME IS THE COMMON CASE. The shared page never asks a viewer to identify
//     themselves, so `viewerLabel` is usually ''. It must never reach the DOM as "undefined".
//  4. A POLL TICK IS NOT A REFRESH. The store notifies dozens of times a minute during a
//     staging run. Re-reading on each one is pointless traffic and a list redrawing under
//     the operator's eyes; only a CHANGE of listing refreshes.
//  5. THE NOTE IS A STRANGER'S TEXT. It is built with textContent and nothing here is ever
//     an HTML string — asserted on every node in the document, children included.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEl } from '../../helpers/admin-dom.js';
import { makeProjectsStore } from '../../../public/scripts/projects/state.js';
import {
  SHARE_ELEMENT_IDS,
  defaultShareSettings,
  mountSharePanel,
} from '../../../public/scripts/projects/share-panel.js';
import {
  ANONYMOUS_VIEWER,
  FEEDBACK_ELEMENT_IDS,
  WHOLE_LISTING_LABEL,
  feedbackRoomKey,
  feedbackSummary,
  feedbackWhen,
  latestPerRoom,
  mountShareFeedback,
  roomFeedbackLabel,
  verdictLabel,
  viewerName,
} from '../../../public/scripts/projects/share-feedback.js';

// ── Global ownership ─────────────────────────────────────────────────────────
// Replaced for the whole FILE (the modules read them off globalThis at call time) and
// restored afterwards. `node --test` isolates each spec file today, but that is the
// runner's default, not a property of this file.

const saved = {
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
};

after(() => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
  globalThis.fetch = saved.fetch;
  globalThis.requestAnimationFrame = saved.requestAnimationFrame;
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  else delete (/** @type {any} */ (globalThis)).navigator;
});

Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

// ── Element stub ─────────────────────────────────────────────────────────────

/** @param {string} tag */
function stubEl(tag) {
  const node = /** @type {any} */ (makeEl(tag));
  node.checked = false;
  node.focus = () => {};
  node.select = () => {};
  return node;
}

/**
 * Every id the share panel resolves — which, since the feedback block's ids are spread into
 * SHARE_ELEMENT_IDS by the module that resolves them, covers this panel too. Plus the toast
 * host, so a toast raised by mistake lands somewhere this file can see it.
 */
const PANEL_IDS = [...SHARE_ELEMENT_IDS, 'toast-host'];

/** @type {Record<string, any>} */
let els = {};

/** Rebuild the page. Mirrors the `hidden` classes projects.html ships. */
function resetDom() {
  els = {};
  for (const id of PANEL_IDS) {
    const node = stubEl('div');
    node.id = id;
    els[id] = node;
  }
  els['pj-share-url-row'].classList.add('hidden');
  els['pj-share-error'].classList.add('hidden');
  els['pj-feedback-summary'].classList.add('hidden');
  els['pj-feedback-error'].classList.add('hidden');
  els['pj-feedback-empty'].textContent = 'No responses yet.';
}

// ── Network ──────────────────────────────────────────────────────────────────

/** @type {Array<{ method: string, path: string }>} */
const requests = [];
/** @type {{ status: number, payload: any }|null} */
let failFeedback = null;
/** @type {any[]} */
let feedbackFixture = [];
/** @type {any} */
let shareFixture = null;

const LIVE_SHARE = {
  id: 'sh1',
  projectId: 'p1',
  userId: 'u1',
  createdAt: Date.parse('2026-07-20T10:00:00Z'),
  expiresAt: null,
  revokedAt: null,
  viewCount: 3,
  lastViewedAt: Date.parse('2026-07-28T09:00:00Z'),
  settings: { ...defaultShareSettings(), agentName: 'Dana Brook' },
};

const HOUR = 3600000;

/**
 * A feedback row. Timestamps default to "a couple of hours ago" so the relative stamp is
 * deterministic without freezing the clock.
 * @param {Partial<any>} fields
 */
function row(fields) {
  return {
    id: 'fb-x',
    shareId: 'sh1',
    projectId: 'p1',
    userId: 'u1',
    roomKey: 'bedroom-1',
    verdict: 'approved',
    note: '',
    viewerLabel: '',
    createdAt: Date.now() - 2 * HOUR,
    ...fields,
  };
}

const jsonResponse = (/** @type {any} */ payload) => ({ ok: true, status: 200, json: async () => payload });

globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => {
  fn();
  return 1;
});

// Failure is targeted at the FEEDBACK path rather than "the next request": the share row and
// the responses are read on the same store notification, so an order-dependent `failNext`
// would silently retarget the day either module's subscribe order changes.
globalThis.fetch = /** @type {any} */ (
  async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const method = init.method || 'GET';
    const path = String(url);
    requests.push({ method, path });
    if (path.endsWith('/feedback')) {
      if (failFeedback) {
        const failure = failFeedback;
        failFeedback = null;
        return { ok: false, status: failure.status, json: async () => failure.payload };
      }
      return jsonResponse({ feedback: feedbackFixture });
    }
    if (path.endsWith('/share')) {
      return jsonResponse({ share: shareFixture, history: [] });
    }
    return jsonResponse({});
  }
);

// ── document / window ────────────────────────────────────────────────────────

globalThis.document = /** @type {any} */ ({
  documentElement: stubEl('html'),
  body: stubEl('body'),
  getElementById: (/** @type {string} */ id) => els[id] || null,
  createElement: (/** @type {string} */ tag) => stubEl(tag),
  addEventListener: () => {},
});

globalThis.window = /** @type {any} */ ({
  StagifyAuth: { getToken: () => 'tok_session' },
  addEventListener: () => {},
});

// ── Harness helpers ──────────────────────────────────────────────────────────

/** Let every queued microtask and resolved fetch settle. */
async function flush() {
  for (let i = 0; i < 14; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** @type {any} */
let panel = null;

/**
 * Mount the share panel — which mounts the feedback block — and open a listing, which is
 * what triggers the read. Returns the store so a test can drive it.
 * @param {{ project?: any }} [opts]
 */
async function mountPanel(opts = {}) {
  const project = 'project' in opts ? opts.project : { id: 'p1', title: 'Rosedale', address: '14 Rosedale Ave' };
  resetDom();
  requests.length = 0;
  const store = makeProjectsStore();
  panel = mountSharePanel({ store, ask: (heading, body, label, action) => action() });
  if (project) {
    store.set({ project });
    await flush();
  }
  return { store };
}

// THE LEAK GUARD. A primed-but-unconsumed fixture is the classic cross-test bleed in this
// suite's shape: the next mount's first read eats it and fails for no reason the failing
// test names. Everything mutable resets here, not only in the mount helper.
afterEach(() => {
  failFeedback = null;
  feedbackFixture = [];
  shareFixture = null;
  if (panel && typeof panel.destroy === 'function') panel.destroy();
  panel = null;
});

/** @param {string} method @param {RegExp} pattern */
const sent = (method, pattern) =>
  requests.filter((request) => request.method === method && pattern.test(request.path));

/** Every node in a subtree, the container included. @param {any} node @returns {any[]} */
function nodes(node) {
  /** @type {any[]} */
  const out = [];
  const walk = (/** @type {any} */ n) => {
    if (!n) return;
    out.push(n);
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  return out;
}

/** The first descendant carrying `cls`. @param {any} node @param {string} cls */
function find(node, cls) {
  return nodes(node).find((n) => n.classList && n.classList.contains(cls)) || null;
}

/** The rendered rows, read the way an operator reads them. */
function rendered() {
  return els['pj-feedback-list'].children.map((/** @type {any} */ item) => {
    const note = find(item, 'pj-feedback__note');
    return {
      room: find(item, 'pj-feedback__room').textContent,
      isListing: !!find(item, 'pj-feedback__room--listing'),
      verdict: find(item, 'pj-feedback__verdict').textContent,
      note: note ? note.textContent : '',
      by: find(item, 'pj-feedback__by').textContent,
      approved: item.classList.contains('is-approved'),
      changes: item.classList.contains('is-changes'),
    };
  });
}

// ── The pure helpers ─────────────────────────────────────────────────────────

test('THE ONE THAT MATTERS: the newest response per room wins, whatever the order', () => {
  const older = row({ id: 'a', roomKey: 'kitchen-1', verdict: 'changes', createdAt: 1000 });
  const newer = row({ id: 'b', roomKey: 'kitchen-1', verdict: 'approved', createdAt: 2000 });

  // The route's own order: newest first.
  const fromApi = latestPerRoom([newer, older]);
  assert.equal(fromApi.length, 1, 'an append-only log is ONE current position per room');
  assert.equal(fromApi[0].id, 'b');
  assert.equal(fromApi[0].verdict, 'approved');

  // And the same answer from a payload sorted the other way. The reduction compares
  // createdAt rather than trusting position — a future ORDER BY that flips the route would
  // otherwise invert every verdict on screen while still looking entirely plausible.
  const reversed = latestPerRoom([older, newer]);
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].id, 'b', 'position is not the tiebreaker; the timestamp is');

  // Different rooms are never collapsed into each other.
  const twoRooms = latestPerRoom([newer, older, row({ id: 'c', roomKey: 'bedroom-1' })]);
  assert.equal(twoRooms.length, 2);
  assert.deepEqual(twoRooms.map((entry) => entry.id).sort(), ['b', 'c']);
});

test('a whole-listing response is its own bucket, not a room called ""', () => {
  const listing = row({ id: 'l1', roomKey: null, verdict: 'changes', createdAt: 3000 });
  const roomEntry = row({ id: 'r1', roomKey: 'bedroom-1', createdAt: 2000 });
  const current = latestPerRoom([listing, roomEntry]);
  assert.equal(current.length, 2, 'listing-level feedback does not overwrite a room');

  assert.equal(feedbackRoomKey(listing), null);
  // '' and '   ' mean the same thing as null — "not about one room" — rather than minting a
  // nameless room of their own.
  assert.equal(feedbackRoomKey(row({ roomKey: '' })), null);
  assert.equal(feedbackRoomKey(row({ roomKey: '   ' })), null);
  assert.equal(feedbackRoomKey(row({ roomKey: ' bedroom-1 ' })), 'bedroom-1');

  assert.equal(roomFeedbackLabel(null), WHOLE_LISTING_LABEL);
  assert.equal(roomFeedbackLabel(''), WHOLE_LISTING_LABEL);
  // Room keys are clusterer slugs, so they are de-slugged for reading.
  assert.equal(roomFeedbackLabel('bedroom-2'), 'Bedroom 2');
  assert.equal(roomFeedbackLabel('living-room-1'), 'Living room 1');
  // A key that de-slugs to nothing is shown verbatim rather than mislabelled as the listing.
  assert.equal(roomFeedbackLabel('--'), '--');
});

test('the summary counts rooms, and states a listing-level verdict separately', () => {
  const entries = [
    row({ id: '1', roomKey: 'bedroom-1', verdict: 'approved' }),
    row({ id: '2', roomKey: 'kitchen-1', verdict: 'approved' }),
    row({ id: '3', roomKey: 'living-room-1', verdict: 'approved' }),
    row({ id: '4', roomKey: 'bathroom-1', verdict: 'changes' }),
  ];
  assert.equal(feedbackSummary(entries), '3 room(s) approved · 1 change(s) requested');
  assert.equal(feedbackSummary([entries[0]]), '1 room(s) approved');
  assert.equal(feedbackSummary([]), '', 'nothing to summarize says nothing');

  // A listing-level response is NOT folded into the room count — doing so would claim more
  // of the shoot is signed off than actually is.
  const withListing = feedbackSummary([...entries, row({ id: '5', roomKey: null, verdict: 'approved' })]);
  assert.match(withListing, /3 room\(s\) approved/);
  assert.match(withListing, /the whole listing approved/);
  assert.match(
    feedbackSummary([row({ roomKey: null, verdict: 'changes' })]),
    /changes requested on the whole listing/
  );
});

test('a missing viewer name is a person, not "undefined"', () => {
  assert.equal(viewerName('Priya Raman'), 'Priya Raman');
  assert.equal(viewerName('  Priya  '), 'Priya');
  // The shared page never asks anyone to identify themselves, so these are the COMMON case.
  assert.equal(viewerName(''), ANONYMOUS_VIEWER);
  assert.equal(viewerName(undefined), ANONYMOUS_VIEWER);
  assert.equal(viewerName(null), ANONYMOUS_VIEWER);
  assert.equal(viewerName('   '), ANONYMOUS_VIEWER);
  for (const value of ['', undefined, null, '   ']) {
    assert.doesNotMatch(viewerName(value), /undefined|null/);
  }
});

test('the verdict reads as words, and an unknown one is not rounded into a rejection', () => {
  assert.equal(verdictLabel('approved'), 'Approved');
  assert.equal(verdictLabel('changes'), 'Needs changes');
  // A value from a newer server must not put words in the client's mouth.
  assert.equal(verdictLabel('maybe'), 'Responded');
  assert.equal(verdictLabel(undefined), 'Responded');
});

test('the timestamp is relative while that helps, and absolute once it does not', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert.equal(feedbackWhen(now - 5000, now), 'just now');
  assert.equal(feedbackWhen(now - 5 * 60000, now), '5 minute(s) ago');
  assert.equal(feedbackWhen(now - 3 * HOUR, now), '3 hour(s) ago');
  assert.equal(feedbackWhen(now - 2 * 86400000, now), '2 day(s) ago');
  // Past a week a relative stamp stops answering anything; and a viewer's skewed clock
  // must not render as "0 minute(s) ago", which reads as a bug.
  assert.ok(/2026/.test(feedbackWhen(now - 30 * 86400000, now)));
  assert.ok(/2026/.test(feedbackWhen(now + 60 * 60000, now)));
  assert.equal(feedbackWhen(null, now), '');
  assert.equal(feedbackWhen('not a date', now), '');
});

// ── The panel ────────────────────────────────────────────────────────────────

test('without its markup the feedback block is inert rather than throwing', async () => {
  els = {};
  requests.length = 0;
  const store = makeProjectsStore();
  const handle = mountShareFeedback({ store });
  store.set({ project: { id: 'p1', title: 'Rosedale', address: '' } });
  await flush();
  assert.equal(requests.length, 0, 'an unmounted block must not talk to the API');
  handle.destroy();
});

test('with no responses it says so in one line, with no list and no summary', async () => {
  await mountPanel();

  assert.equal(sent('GET', /\/api\/projects\/p1\/feedback$/).length, 1, 'the block reads on open');
  assert.ok(!els['pj-feedback-empty'].classList.contains('hidden'), 'the empty line is shown');
  assert.match(els['pj-feedback-empty'].textContent, /No responses yet/i);
  // Not an empty box with chrome: no rows, and no summary claiming a count of nothing.
  assert.equal(els['pj-feedback-list'].children.length, 0);
  assert.ok(els['pj-feedback-summary'].classList.contains('hidden'));
  assert.equal(els['pj-feedback-summary'].textContent, '');
  assert.ok(els['pj-feedback-error'].classList.contains('hidden'));
});

test('two responses for one room render as ONE entry showing the newer verdict', async () => {
  // The exact shape the append-only store produces after a seller changes their mind, in the
  // order the route sends it: newest first.
  feedbackFixture = [
    row({
      id: 'fb2',
      roomKey: 'kitchen-1',
      verdict: 'approved',
      note: 'Looks great now, thank you.',
      viewerLabel: 'Priya Raman',
      createdAt: Date.now() - HOUR,
    }),
    row({
      id: 'fb1',
      roomKey: 'kitchen-1',
      verdict: 'changes',
      note: 'The island is too big.',
      viewerLabel: 'Priya Raman',
      createdAt: Date.now() - 5 * HOUR,
    }),
  ];
  await mountPanel();

  const rows = rendered();
  assert.equal(rows.length, 1, 'the log is a history; the panel shows the current position');
  assert.equal(rows[0].room, 'Kitchen 1');
  assert.equal(rows[0].verdict, 'Approved', 'the NEWER verdict wins');
  assert.equal(rows[0].note, 'Looks great now, thank you.');
  // The superseded note must not linger anywhere — showing both is showing a room as
  // approved and rejected at once.
  assert.ok(!els['pj-feedback-list'].children.some(
    (/** @type {any} */ item) => nodes(item).some((n) => /island is too big/.test(n.textContent || ''))
  ), 'the superseded response is gone, not stacked underneath');
  assert.equal(rows[0].approved, true);
  assert.equal(rows[0].changes, false);
  assert.match(rows[0].by, /Priya Raman/);
  assert.match(rows[0].by, /hour\(s\) ago/);

  assert.ok(els['pj-feedback-empty'].classList.contains('hidden'), 'the empty line is gone');
  assert.ok(!els['pj-feedback-summary'].classList.contains('hidden'));
  assert.equal(els['pj-feedback-summary'].textContent, '1 room(s) approved');
});

test('whole-listing feedback is labelled distinctly from a room, and counted separately', async () => {
  feedbackFixture = [
    row({ id: 'l', roomKey: null, verdict: 'changes', note: 'Can we see the garden too?', createdAt: Date.now() - HOUR }),
    row({ id: 'r', roomKey: 'bedroom-1', verdict: 'approved', createdAt: Date.now() - 3 * HOUR }),
  ];
  await mountPanel();

  const rows = rendered();
  assert.equal(rows.length, 2);
  const [listing, bedroom] = rows;
  assert.equal(listing.room, WHOLE_LISTING_LABEL);
  assert.notEqual(listing.room, bedroom.room, 'the listing must not read as a room');
  assert.equal(listing.isListing, true, 'and it carries its own modifier for the eye');
  assert.equal(bedroom.room, 'Bedroom 1');
  assert.equal(bedroom.isListing, false);
  assert.equal(listing.verdict, 'Needs changes');
  assert.equal(listing.changes, true);

  // The summary keeps them apart too: one room approved, plus a listing-level ask.
  assert.match(els['pj-feedback-summary'].textContent, /1 room\(s\) approved/);
  assert.match(els['pj-feedback-summary'].textContent, /changes requested on the whole listing/);
  assert.doesNotMatch(els['pj-feedback-summary'].textContent, /2 room\(s\)/);
});

test('an unnamed client renders as a person, never as "undefined"', async () => {
  feedbackFixture = [
    row({ id: 'a', roomKey: 'bedroom-1', viewerLabel: '', note: 'Perfect.' }),
    row({ id: 'b', roomKey: 'kitchen-1', viewerLabel: '   ' }),
  ];
  await mountPanel();

  for (const entry of rendered()) {
    assert.match(entry.by, new RegExp(ANONYMOUS_VIEWER));
    assert.doesNotMatch(entry.by, /undefined|null/);
  }
  // And nowhere else in the block either — a stray "undefined" in a heading is the same bug.
  for (const node of nodes(els['pj-feedback'])) {
    assert.doesNotMatch(String(node.textContent || ''), /undefined|null/);
  }
});

test('the summary counts what is on screen, not what is in the log', async () => {
  feedbackFixture = [
    // Two rooms approved, one asking for changes — with a superseded row for the kitchen
    // that must NOT be counted a second time.
    row({ id: '1', roomKey: 'bedroom-1', verdict: 'approved', createdAt: 5000 }),
    row({ id: '2', roomKey: 'kitchen-1', verdict: 'approved', createdAt: 4000 }),
    row({ id: '3', roomKey: 'bathroom-1', verdict: 'changes', createdAt: 3000 }),
    row({ id: '4', roomKey: 'kitchen-1', verdict: 'changes', createdAt: 1000 }),
  ];
  await mountPanel();

  assert.equal(rendered().length, 3, 'four rows, three rooms');
  assert.equal(els['pj-feedback-summary'].textContent, '2 room(s) approved · 1 change(s) requested');
});

test('a progress tick does NOT re-read the responses; a listing change does', async () => {
  feedbackFixture = [row({ id: 'a', roomKey: 'bedroom-1', verdict: 'approved' })];
  const { store } = await mountPanel();
  assert.equal(sent('GET', /\/p1\/feedback$/).length, 1);
  assert.equal(rendered().length, 1);

  // The store notifies on EVERY poll tick during a staging run — dozens of times a minute.
  // Same listing, so there is nothing to re-read.
  store.set({ progress: { queued: 1, running: 1, ok: 2, failed: 0, superseded: 0, total: 4 } });
  store.set({ progress: { queued: 0, running: 1, ok: 3, failed: 0, superseded: 0, total: 4 } });
  await flush();
  assert.equal(sent('GET', /\/feedback$/).length, 1, 'no re-read on a tick');
  assert.equal(rendered().length, 1, 'and no redraw churning the list');

  // A different listing is a different conversation, and must be read again.
  feedbackFixture = [
    row({ id: 'b', projectId: 'p2', roomKey: 'kitchen-1', verdict: 'changes', note: 'Too dark.' }),
  ];
  store.set({ project: { id: 'p2', title: 'Bathurst', address: '9 Bathurst St' } });
  await flush();
  assert.equal(sent('GET', /\/api\/projects\/p2\/feedback$/).length, 1, 'the new listing IS read');
  const rows = rendered();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].room, 'Kitchen 1', 'and the previous listing’s responses are gone');
  assert.equal(rows[0].note, 'Too dark.');
});

test('a failed read shows an inline notice and leaves the share panel usable', async () => {
  shareFixture = LIVE_SHARE;
  failFeedback = { status: 500, payload: { ref: 'abc123' } };
  await mountPanel();

  assert.ok(!els['pj-feedback-error'].classList.contains('hidden'), 'the notice is shown');
  assert.match(els['pj-feedback-error'].textContent, /responses/i);
  assert.match(els['pj-feedback-error'].textContent, /server had a problem/i);

  // THE POINT OF THIS TEST. A background read the operator never asked for must not take the
  // share controls down with it, and must not blame them with a toast over their work.
  assert.equal(els['toast-host'].children.length, 0, 'no toast for a background read');
  assert.ok(els['pj-share-error'].classList.contains('hidden'), 'and the share panel keeps its own notice clear');
  assert.match(els['pj-share-status'].textContent, /active/, 'the link is still described');
  assert.equal(els['pj-share-create'].disabled, false);
  assert.equal(els['pj-share-revoke'].disabled, false);
  assert.equal(els['pj-share-save'].disabled, false);

  // And the next listing recovers — the notice does not become permanent.
  feedbackFixture = [row({ id: 'ok', roomKey: 'bedroom-1', verdict: 'approved' })];
  panel.destroy();
  await mountPanel();
  assert.ok(els['pj-feedback-error'].classList.contains('hidden'), 'the stale notice is cleared');
  assert.equal(rendered().length, 1);
});

test('a hostile note and viewer name are text, never markup', async () => {
  const hostileNote = '<img src=x onerror="alert(1)">';
  const hostileName = '</strong><script>alert(2)</script>';
  const hostileRoom = '<b>kitchen</b>';
  feedbackFixture = [
    row({ id: 'x', roomKey: hostileRoom, verdict: 'changes', note: hostileNote, viewerLabel: hostileName }),
  ];
  await mountPanel();

  const [entry] = rendered();
  // Round-tripped VERBATIM as text — escaping it would corrupt what the client actually
  // wrote, and a value assigned to textContent is never parsed as markup.
  assert.equal(entry.note, hostileNote);
  assert.match(entry.by, new RegExp(hostileName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(entry.room, /<b>kitchen<\/b>/);

  // THE ASSERTION THIS FILE IS FOR: nothing in this panel is built as an HTML string. Every
  // node in the document, children included — this is what fails the day someone swaps a
  // textContent write for an innerHTML one.
  for (const [id, node] of Object.entries(els)) {
    for (const descendant of nodes(node)) {
      assert.equal(descendant.innerHTML, '', `${id} must not be filled with an HTML string`);
    }
  }
});

test('the ids the feedback block resolves are exported through the share panel’s list', () => {
  // The page's drift guard (test/frontend/projects/studio.test.js) checks SHARE_ELEMENT_IDS
  // against projects.html. A feedback id missing from that spread would ship as "the
  // responses never appear" with nothing failing anywhere.
  assert.ok(FEEDBACK_ELEMENT_IDS.length > 0);
  for (const id of FEEDBACK_ELEMENT_IDS) {
    assert.ok(SHARE_ELEMENT_IDS.includes(id), `${id} must be covered by the page's id guard`);
  }
});
