// Tier: frontend island logic (DOM-stubbed) — public/scripts/gallery-tab.js.
//
// The Gallery tab is hidden from signed-out visitors. Two things about that need
// holding down, and neither is visible from reading the markup:
//
//  1. THE DIRECTION. The tab ships `hidden` in the HTML, so signed-out is the no-JS
//     default and a signed-in visitor is REVEALED after /api/auth/me. Flip it and
//     every visitor sees the tab for a moment and then has it taken away — which is
//     also what a reader who skips this comment will "tidy up" the markup into.
//
//  2. THE EVENT. Revealing a tab between "Staging" and "Guides" moves every link to
//     its right, and the nav pill is positioned by measured offsets. nav-pill.js
//     cannot observe this for itself (see the comment on the dispatch), so the
//     writer announces it. A silent regression here leaves the pill sitting a
//     tab-width to the left of the link it is meant to be under, on every page a
//     signed-in visitor loads.
//
// The whole-page markup guard — that every nav-bearing page ships the tab hidden,
// with the hook this file selects on — lives in test/frontend/staging-menu.test.js,
// next to the rest of the shared-header drift guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A stand-in for the tab, tracking its class list and nothing else. */
function makeTab({ hidden = true } = {}) {
  const classes = new Set(['nav-link', 'desktop-only']);
  if (hidden) classes.add('hidden');
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    get hidden() { return classes.has('hidden'); },
  };
}

/**
 * Install a document exposing `tabs` for `[data-nav-gallery]`, plus an auth state.
 *
 * `token` and `sessionArmed` model the pre-paint half: session-class.js puts
 * `has-session` on <html> from the stored token, and this writer only takes it back off
 * once there is a real answer to take it off for. `token` defaults to "one exists iff a
 * user does", which is the settled state every older test here was written against.
 */
function mount({ user = null, tabs = [makeTab()], token = undefined, sessionArmed = false } = {}) {
  const events = [];
  const rootClasses = new Set(sessionArmed ? ['has-session'] : []);
  const storedToken = token === undefined ? (user ? 'tok_test' : null) : token;
  globalThis.CustomEvent = /** @type {any} */ (class { constructor(type) { this.type = type; } });
  globalThis.document = /** @type {any} */ ({
    documentElement: {
      classList: {
        add: (c) => rootClasses.add(c),
        remove: (c) => rootClasses.delete(c),
        contains: (c) => rootClasses.has(c),
        toggle: (c, on) => (on ? rootClasses.add(c) : rootClasses.delete(c)),
      },
    },
    querySelectorAll: (sel) => (sel === '[data-nav-gallery]' ? tabs : []),
    dispatchEvent: (e) => { events.push(e.type); return true; },
  });
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { user, getToken: () => storedToken } });
  return { tabs, events, hasSession: () => rootClasses.has('has-session') };
}

mount();
const { galleryTabVisible, syncGalleryTab, NAV_VISIBILITY_EVENT } =
  await import('../../../public/scripts/gallery-tab.js');

// ---- the pure rule ---------------------------------------------------------

test('galleryTabVisible shows the tab to a signed-in visitor and nobody else', () => {
  assert.equal(galleryTabVisible(true), true);
  assert.equal(galleryTabVisible(false), false);
});

// ---- the DOM writer --------------------------------------------------------

test('a signed-in visitor gets the tab', () => {
  const { tabs } = mount({ user: { id: 'u1', plan: 'free' } });
  assert.equal(syncGalleryTab(), true);
  assert.equal(tabs[0].hidden, false);
});

test('a free account gets it too — the gallery is not a Stagify+ feature', () => {
  // Their own saved renders are still their renders. If this ever becomes a paid
  // feature it is a change to galleryTabVisible, not a class toggled somewhere else.
  const { tabs } = mount({ user: { id: 'u1', plan: 'free' } });
  syncGalleryTab();
  assert.equal(tabs[0].hidden, false);
});

test('a signed-out visitor does not, and the writer does not UNHIDE on the way past', () => {
  // The markup ships hidden, so this is really asserting the no-user branch leaves
  // it alone rather than revealing it before /api/auth/me has answered.
  const { tabs } = mount({ user: null });
  assert.equal(syncGalleryTab(), false);
  assert.equal(tabs[0].hidden, true);
});

test('signing out puts the tab away again', () => {
  // applyUserToUI() calls this from eight sites, and sign-out is one of them.
  const { tabs } = mount({ user: { id: 'u1' } });
  syncGalleryTab();
  assert.equal(tabs[0].hidden, false);

  globalThis.window.StagifyAuth = { user: null };
  assert.equal(syncGalleryTab(), false);
  assert.equal(tabs[0].hidden, true, 'a signed-out visitor must not keep the tab');
});

test('no StagifyAuth at all is treated as signed out', () => {
  const tabs = [makeTab()];
  globalThis.document = /** @type {any} */ ({
    querySelectorAll: (sel) => (sel === '[data-nav-gallery]' ? tabs : []),
    dispatchEvent: () => true,
  });
  globalThis.window = /** @type {any} */ ({});
  assert.equal(syncGalleryTab(), false);
  assert.equal(tabs[0].hidden, true);
});

test('no-ops on pages with no tab', () => {
  // admin.html has an empty .nav-center, and auth.js calls this unconditionally.
  mount({ user: { id: 'u1' }, tabs: [] });
  assert.doesNotThrow(() => syncGalleryTab());
  assert.equal(syncGalleryTab(), false);
});

// ---- the pre-paint class ---------------------------------------------------
//
// session-class.js shows the tab THROUGH the `.hidden` this writer owns, so the two must
// never disagree: a stale `has-session` leaves a tab on screen that this file believes it
// has just hidden, and dropping the class too early puts back the round-trip pop-in it
// exists to prevent. Neither shows up in the `.hidden` assertions above.

test('an in-flight visitor keeps the pre-paint class — the guess stands until answered', () => {
  // A token in storage, /api/auth/me not back yet. This is the whole window the class
  // covers; every call site today runs after the answer, but one optimistic call added
  // later would land exactly here and must not undo it.
  const { hasSession, tabs } = mount({ user: null, token: 'tok', sessionArmed: true });
  syncGalleryTab();
  assert.equal(hasSession(), true, 'the tab must not be pulled back out of the nav mid-load');
  assert.equal(tabs[0].hidden, true, 'while the writer still reports the shipped state');
});

test('a confirmed session keeps the class, and the writer agrees with it', () => {
  const { hasSession, tabs } = mount({ user: { id: 'u1' }, sessionArmed: true });
  syncGalleryTab();
  assert.equal(hasSession(), true);
  assert.equal(tabs[0].hidden, false, 'both halves now say the same thing');
});

test('an EXPIRED token loses the class, or the tab never leaves', () => {
  // The accepted cost of a presence check: the class is armed for anyone holding a token,
  // and only /api/auth/me can say it is dead. When it does, clear() drops the token — so
  // this is the settled-signed-out branch, and the CSS override has to stop applying or
  // hiding the tab does nothing at all.
  const { hasSession, tabs } = mount({ user: null, token: null, sessionArmed: true });
  assert.equal(syncGalleryTab(), false);
  assert.equal(hasSession(), false);
  assert.equal(tabs[0].hidden, true);
});

test('signing out takes the class with the tab', () => {
  const { hasSession } = mount({ user: { id: 'u1' }, sessionArmed: true });
  syncGalleryTab();
  assert.equal(hasSession(), true);

  globalThis.window.StagifyAuth = { user: null, getToken: () => null };
  syncGalleryTab();
  assert.equal(hasSession(), false, 'a signed-out visitor must not keep the pre-paint reveal');
});

test('a signed-in visitor whose page never armed it gets the class anyway', () => {
  // Storage can throw, and the class only lands on pages that load session-class.js. The
  // writer setting it on the way past costs nothing and keeps the two in step.
  const { hasSession } = mount({ user: { id: 'u1' }, sessionArmed: false });
  syncGalleryTab();
  assert.equal(hasSession(), true);
});

// ---- the nav-pill signal ---------------------------------------------------

test('announces the change so the nav pill can re-settle', () => {
  const { events } = mount({ user: { id: 'u1' } });
  syncGalleryTab();
  assert.deepEqual(events, [NAV_VISIBILITY_EVENT]);
});

test('but stays quiet when nothing moved', () => {
  // applyUserToUI() runs from eight sites and re-runs on every auth refresh. An
  // event per call would make the pill re-measure (and re-animate) for no reason.
  const { events } = mount({ user: { id: 'u1' } });
  syncGalleryTab();
  syncGalleryTab();
  syncGalleryTab();
  assert.deepEqual(events, [NAV_VISIBILITY_EVENT], 'only the call that actually revealed it');
});

test('and announces the reverse when the tab goes away', () => {
  const { events } = mount({ user: { id: 'u1' } });
  syncGalleryTab();
  globalThis.window.StagifyAuth = { user: null };
  syncGalleryTab();
  assert.deepEqual(events, [NAV_VISIBILITY_EVENT, NAV_VISIBILITY_EVENT]);
});

test('the event name is the one nav-pill.js listens for', async () => {
  // Two files, one string, and nothing else connects them: a rename on either side
  // is silent — the pill simply stops re-settling, on a code path that only runs
  // for signed-in visitors after a network round-trip.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const navPill = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'nav-pill.js'), 'utf8');
  assert.ok(
    navPill.includes(`"${NAV_VISIBILITY_EVENT}"`) || navPill.includes(`'${NAV_VISIBILITY_EVENT}'`),
    `nav-pill.js does not listen for ${NAV_VISIBILITY_EVENT} — the pill will not re-settle when the tab appears`,
  );
});
