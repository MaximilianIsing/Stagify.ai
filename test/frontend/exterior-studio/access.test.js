// Tier: frontend island logic — public/scripts/exterior-studio/access.js.
//
// This page shows one of three views on a single URL, which no other Stagify+ surface
// does. Every other paid page loads a render-blocking gate that redirects anyone without
// a token; here the page stays put and changes shape, so that Googlebot and a curious
// visitor both get something real.
//
// The regressions worth holding down are the ones that look fine on screen:
//   • REVERSIBILITY — signing out must put the public pitch back. applyUserToUI() calls
//     this writer from eight sites, so a one-way writer leaves the tool on screen for a
//     signed-out visitor, whose every click then 401s.
//   • NO OVERLAY, EVER — a signed-in free account used to get a full-screen, undismissable
//     "your account is on the free plan" dialog the moment this page loaded, which for a
//     brand-new account was the first thing the product ever said to them. It is gone, and
//     the page must not grow another one: the assertion below is on the MARKUP, because
//     re-adding the overlay starts with re-adding the div, and a writer-only check would
//     pass right up until someone wired it back up.
//   • THE CTA'S data-lang — repainting the label without moving the key means the next
//     language switch re-renders the OLD label. Same trap custom-select.js shipped with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountExteriorPage, pageIds, hiddenPageIds, pageHtml } from '../../helpers/exterior-studio-dom.js';
import {
  exteriorView,
  applyExteriorView,
  syncExteriorAccess,
  PENDING_CLASS,
} from '../../../public/scripts/exterior-studio/access.js';

const PRO = { plan: 'pro' };
const FREE = { plan: 'free' };

// ---- the pure rule ---------------------------------------------------------

test('exteriorView maps every visitor to exactly one of the three views', () => {
  assert.equal(exteriorView(null), 'anonymous');
  assert.equal(exteriorView(undefined), 'anonymous');
  assert.equal(exteriorView(FREE), 'free');
  assert.equal(exteriorView(PRO), 'pro');
});

test('exteriorView treats an unknown plan as not Pro', () => {
  // Degrading to the pitch is the safe direction: the server refuses the render anyway,
  // so the worst case is a paying customer seeing a marketing page, not a free account
  // getting a paid feature.
  assert.equal(exteriorView({ plan: 'trialing' }), 'free');
  assert.equal(exteriorView({}), 'free');
});

// ---- the markup ships in the anonymous state -------------------------------

test('the shipped markup is the ANONYMOUS view — no-JS default, and what a crawler sees', () => {
  // If the tool shipped visible, every visitor would see the studio for a moment before
  // JS took it away — and Googlebot, which runs no auth, would index the wrong page.
  const hidden = hiddenPageIds();
  assert.ok(hidden.has('ex-tool'), 'the tool must ship hidden');
  assert.ok(!hidden.has('ex-features'), 'the public pitch must ship visible');

  const ids = pageIds();
  for (const id of ['ex-tool', 'ex-features', 'ex-hero-actions', 'ex-cta']) {
    assert.ok(ids.includes(id), `the page must carry #${id} — access.js looks it up by id`);
  }
});

// ---- the upgrade overlay stays deleted -------------------------------------

test('there is NO upgrade overlay on this page — not in the markup, not in the stylesheet', () => {
  // The dialog this replaces was full-screen, had no close button, and fired for any
  // signed-in free account the moment the page loaded — so the first thing a brand-new
  // account saw was a wall telling them what they had not bought. The hero's "Get
  // Stagify+ to use it" button makes the same ask without taking the page away.
  //
  // Asserted on the SOURCE rather than through the writer because that is the order the
  // regression happens in: the div comes back first, styled and translated, and only then
  // does something toggle it. A writer-only check would still be green at that point.
  const html = pageHtml();
  assert.ok(!/id="ex-pro-gate"/.test(html), 'the gate dialog is back in exterior-studio.html');
  assert.ok(!/\bex-gate\b/.test(html), 'gate markup is back in exterior-studio.html');
  assert.ok(
    !/exteriorStudio\.gate\./.test(html),
    'the gate copy is back — its keys were deleted from all eleven packs, so it would render as raw English',
  );

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const css = fs.readFileSync(path.join(root, 'public', 'styles', 'exterior-studio.css'), 'utf8');
  // Comments carry the words "gate" and "dialog" on purpose (they explain the removal), so
  // strip them first — otherwise the note left behind for the next reader is what keeps
  // this assertion passing, and it would keep passing with the rules restored underneath.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.ex-gate/.test(rules), '.ex-gate styles are back in exterior-studio.css');
});

// ---- the writer ------------------------------------------------------------

/** Run the writer against a fresh page and return the elements it touched. */
function render(view) {
  const page = mountExteriorPage();
  const els = {
    features: page.els['ex-features'],
    tool: page.els['ex-tool'],
    heroActions: page.els['ex-hero-actions'],
  };
  const revealed = applyExteriorView(view, els);
  page.restore();
  return { ...els, revealed, cta: page.els['ex-cta'] };
}

test('anonymous: the pitch, and a Stagify+ link', () => {
  const r = render('anonymous');
  assert.equal(r.features.hidden, false, 'the pitch is the page');
  assert.equal(r.tool.hidden, true);
  assert.equal(r.heroActions.hidden, false, 'and the call to action is on offer');
  assert.equal(r.revealed, false);
});

test('the hero call to action is a STATIC sales link, not a control JS repoints', () => {
  // It used to change job between views — "get Stagify+" for a visitor, "jump to the
  // uploader" for a subscriber. One control with two meanings is one more thing that has
  // to stay true through every language switch, so it is markup now and the Pro view
  // simply hides it.
  const html = pageHtml();
  const cta = /<a[^>]*id="ex-cta"([^>]*)>/.exec(html);
  assert.ok(cta, 'the CTA is missing');
  assert.match(cta[1], /href="stagify-plus\.html"/, 'it only ever points at the plan');
});

test('signed-in free: byte for byte the page an anonymous visitor gets', () => {
  // Signing up must not change this page. It used to: creating an account swapped the
  // pitch for a full-screen dialog about not having paid.
  const free = render('free');
  const anon = render('anonymous');
  assert.equal(free.features.hidden, false, 'the pitch is still the page');
  assert.equal(free.tool.hidden, true, 'the tool is still the paid half');
  assert.equal(free.heroActions.hidden, false, 'and the ask is still the hero button');
  assert.equal(free.revealed, false);

  assert.deepEqual(
    [free.features.hidden, free.tool.hidden, free.heroActions.hidden],
    [anon.features.hidden, anon.tool.hidden, anon.heroActions.hidden],
    'a signed-in free account and an anonymous visitor see the same page',
  );
});

test('pro: the tool, and both the pitch and the sales button are taken away', () => {
  const r = render('pro');
  assert.equal(r.tool.hidden, false);
  assert.equal(r.features.hidden, true, 'someone who bought it does not need selling');
  assert.equal(r.heroActions.hidden, true, 'nor a button offering to sell it again');
  assert.equal(r.revealed, true);
});

test('the writer is idempotent and REVERSIBLE — signing out puts the pitch back', () => {
  const page = mountExteriorPage();
  const els = {
    features: page.els['ex-features'], tool: page.els['ex-tool'],
    heroActions: page.els['ex-hero-actions'],
  };

  applyExteriorView('pro', els);
  applyExteriorView('pro', els);
  assert.equal(els.tool.hidden, false, 'running twice changes nothing');

  applyExteriorView('anonymous', els);
  assert.equal(els.tool.hidden, true, 'the tool goes away again');
  assert.equal(els.features.hidden, false, 'and the pitch comes back');
  assert.equal(els.heroActions.hidden, false, 'along with the button that sells it');

  // free → pro is the upgrade path: someone who subscribes in another tab and comes back
  // must get the tool, not the pitch they already paid to skip.
  applyExteriorView('free', els);
  assert.equal(els.tool.hidden, true);
  applyExteriorView('pro', els);
  assert.equal(els.tool.hidden, false, 'upgrading reveals the tool');
  assert.equal(els.features.hidden, true);
  page.restore();
});

test('a missing region is a no-op, not a throw', () => {
  // The writer runs from applyUserToUI() on all ten nav-bearing pages, nine of which have
  // none of these elements.
  assert.doesNotThrow(() => applyExteriorView('pro', {
    features: null, tool: null, heroActions: null,
  }));
});

// ---- the live-document writer ---------------------------------------------

test('syncExteriorAccess no-ops on a page with no Exterior Studio', () => {
  const prevDoc = globalThis.document;
  globalThis.document = /** @type {any} */ ({ getElementById: () => null });
  assert.doesNotThrow(() => syncExteriorAccess());
  assert.equal(syncExteriorAccess(), false);
  globalThis.document = prevDoc;
});

// ---- handing back from the head gate's cached guess ------------------------
//
// The predicate that decides WHEN is shared with the nav's Gallery tab and tested in
// test/frontend/session-state.test.js. What belongs here is that this page wires it up:
// the writer must not strip the class on the optimistic first sync, and must strip it the
// moment the answer lands.

test('the optimistic first sync leaves the gate class alone; the answer takes it off', () => {
  // exterior-studio-app.js calls syncExteriorAccess() BEFORE /api/auth/me is even sent, so
  // at that moment the writer reads "anonymous" for a subscriber. If that call stripped the
  // class, the pitch would paint — which is the exact bug the gate exists to prevent.
  const inFlight = mountExteriorPage({ user: null, token: 'tok', pending: true });
  syncExteriorAccess();
  assert.ok(
    inFlight.root.classList.contains(PENDING_CLASS),
    'the cached guess must stand until the plan is actually known',
  );
  inFlight.restore();

  const answered = mountExteriorPage({ user: PRO, token: 'tok', pending: true });
  syncExteriorAccess();
  assert.ok(!answered.root.classList.contains(PENDING_CLASS), 'the live plan takes over');
  assert.equal(answered.els['ex-tool'].hidden, false, 'and it agrees with what was painted');
  assert.equal(answered.els['ex-features'].hidden, true);
  answered.restore();
});

test('a stale cache is corrected: the class comes off and the pitch comes back', () => {
  // Someone who cancelled still has `stagifyPlan: 'pro'` in storage until /api/auth/me
  // answers, so they get the tool for one round trip. Cosmetic only — requireProAccount
  // refuses the render — but the correction has to actually land.
  const page = mountExteriorPage({ user: FREE, token: 'tok', pending: true });
  syncExteriorAccess();
  assert.ok(!page.root.classList.contains(PENDING_CLASS), 'the CSS override must stop applying');
  assert.equal(page.els['ex-tool'].hidden, true, 'and the tool goes away with it');
  assert.equal(page.els['ex-features'].hidden, false, 'leaving the pitch');
  page.restore();
});

test('signing out disarms the class as well as restoring the pitch', () => {
  // clear() drops the token, the user AND the cached plan together, so this is the
  // "no token" branch of settled — the one that must not wait for an answer that is
  // never coming.
  const page = mountExteriorPage({ user: null, token: null, pending: true });
  syncExteriorAccess();
  assert.ok(!page.root.classList.contains(PENDING_CLASS));
  assert.equal(page.els['ex-features'].hidden, false);
  page.restore();
});

test('syncExteriorAccess reads the live plan off window.StagifyAuth', () => {
  const pro = mountExteriorPage({ user: PRO });
  assert.equal(syncExteriorAccess(), true);
  assert.equal(pro.els['ex-tool'].hidden, false);
  pro.restore();

  const free = mountExteriorPage({ user: FREE });
  assert.equal(syncExteriorAccess(), false);
  assert.equal(free.els['ex-tool'].hidden, true);
  assert.equal(free.els['ex-features'].hidden, false, 'a free account gets the pitch, not a wall');
  free.restore();

  const anon = mountExteriorPage({ user: null });
  assert.equal(syncExteriorAccess(), false);
  assert.equal(anon.els['ex-tool'].hidden, true);
  assert.equal(anon.els['ex-features'].hidden, false);
  anon.restore();
});
