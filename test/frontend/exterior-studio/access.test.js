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
//   • THE MODAL AUDIENCE — an anonymous visitor must NOT get the upgrade dialog. They
//     have not been told what the tool does yet; a modal over the pitch is how a landing
//     page stops converting.
//   • THE CTA'S data-lang — repainting the label without moving the key means the next
//     language switch re-renders the OLD label. Same trap custom-select.js shipped with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountExteriorPage, pageIds, hiddenPageIds, pageHtml } from '../../helpers/exterior-studio-dom.js';
import { exteriorView, applyExteriorView, syncExteriorAccess } from '../../../public/scripts/exterior-studio/access.js';

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
  for (const id of ['ex-tool', 'ex-features', 'ex-hero-actions', 'ex-cta', 'ex-pro-gate']) {
    assert.ok(ids.includes(id), `the page must carry #${id} — access.js looks it up by id`);
  }
});

// ---- the writer ------------------------------------------------------------

/** Run the writer against a fresh page and return the elements it touched. */
function render(view) {
  const page = mountExteriorPage();
  const els = {
    features: page.els['ex-features'],
    tool: page.els['ex-tool'],
    heroActions: page.els['ex-hero-actions'],
    gate: page.els['ex-pro-gate'],
  };
  const revealed = applyExteriorView(view, els);
  page.restore();
  return { ...els, revealed, cta: page.els['ex-cta'] };
}

test('anonymous: the pitch, a Stagify+ link, and NO modal', () => {
  const r = render('anonymous');
  assert.equal(r.features.hidden, false, 'the pitch is the page');
  assert.equal(r.tool.hidden, true);
  assert.equal(r.gate.classList.contains('active'), false, 'never interrupt a first-time reader');
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

test('signed-in free: the same pitch, plus the upgrade dialog', () => {
  const r = render('free');
  assert.equal(r.features.hidden, false);
  assert.equal(r.tool.hidden, true);
  assert.equal(r.gate.classList.contains('active'), true, 'they have an account, so the ask is concrete');
  assert.equal(r.revealed, false);
});

test('pro: the tool, and both the pitch and the sales button are taken away', () => {
  const r = render('pro');
  assert.equal(r.tool.hidden, false);
  assert.equal(r.features.hidden, true, 'someone who bought it does not need selling');
  assert.equal(r.heroActions.hidden, true, 'nor a button offering to sell it again');
  assert.equal(r.gate.classList.contains('active'), false);
  assert.equal(r.revealed, true);
});

test('the writer is idempotent and REVERSIBLE — signing out puts the pitch back', () => {
  const page = mountExteriorPage();
  const els = {
    features: page.els['ex-features'], tool: page.els['ex-tool'],
    heroActions: page.els['ex-hero-actions'], gate: page.els['ex-pro-gate'],
  };

  applyExteriorView('pro', els);
  applyExteriorView('pro', els);
  assert.equal(els.tool.hidden, false, 'running twice changes nothing');

  applyExteriorView('anonymous', els);
  assert.equal(els.tool.hidden, true, 'the tool goes away again');
  assert.equal(els.features.hidden, false, 'and the pitch comes back');
  assert.equal(els.heroActions.hidden, false, 'along with the button that sells it');
  assert.equal(els.gate.classList.contains('active'), false);

  // free → pro must also clear the modal, or a visitor who upgrades in another tab and
  // returns finds the tool behind a dialog they cannot dismiss.
  applyExteriorView('free', els);
  assert.equal(els.gate.classList.contains('active'), true);
  applyExteriorView('pro', els);
  assert.equal(els.gate.classList.contains('active'), false, 'upgrading must dismiss the gate');
  page.restore();
});

test('a missing region is a no-op, not a throw', () => {
  // The writer runs from applyUserToUI() on all ten nav-bearing pages, nine of which have
  // none of these elements.
  assert.doesNotThrow(() => applyExteriorView('pro', {
    features: null, tool: null, heroActions: null, gate: null,
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

test('syncExteriorAccess reads the live plan off window.StagifyAuth', () => {
  const pro = mountExteriorPage({ user: PRO });
  assert.equal(syncExteriorAccess(), true);
  assert.equal(pro.els['ex-tool'].hidden, false);
  pro.restore();

  const free = mountExteriorPage({ user: FREE });
  assert.equal(syncExteriorAccess(), false);
  assert.equal(free.els['ex-tool'].hidden, true);
  assert.equal(free.els['ex-pro-gate'].classList.contains('active'), true);
  free.restore();

  const anon = mountExteriorPage({ user: null });
  assert.equal(syncExteriorAccess(), false);
  assert.equal(anon.els['ex-pro-gate'].classList.contains('active'), false);
  anon.restore();
});
