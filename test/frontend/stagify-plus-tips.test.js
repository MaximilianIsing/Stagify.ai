// Tier: frontend island logic (DOM-stubbed) — public/scripts/stagify-plus-tips.js.
//
// WHY THIS EXISTS
// The Compare-plans table used to be preceded by a feature grid that described six of
// its rows as cards. That grid is gone, and the long copy now lives behind the ⓘ button
// on the row it explains. So this module is the ONLY thing standing between a visitor
// and the page's entire explanation of what Stagify+ does: if the bubble never opens, or
// opens off-screen, the sales page silently says less than the free page does.
//
// Three of the behaviours below are not obvious and each was a real trap:
//
//   1. THE TAP SEQUENCE. A tap fires pointerenter, pointerdown, focus and click, and
//      three of those four would open the bubble — so the naive `click` toggle closes on
//      the FIRST tap and the button looks dead on every phone. What decides the toggle is
//      the state captured at pointerdown, before focus has run.
//   2. THE COPY IS READ AT SHOW TIME. language-loader.js rewrites the source spans when
//      the visitor switches language. A string cached at startup would be correct once
//      and stale in every language after.
//   3. THE BUBBLE IS CLAMPED, NOT CENTRED. It is `position: fixed` in <body> precisely
//      because both of the table's wrappers clip it, which means nothing else stops it
//      running off the viewport edge. The arrow offset has to chase the trigger when
//      that clamp bites, or a clamped bubble points at the wrong row.
//
// The module has no exports to call — it wires itself up at import time — so everything
// here is driven through the listeners the shim captured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPlusTips, pageTips } from '../helpers/plus-tips-dom.js';

const VIEWPORT = 1200;
const POP_W = 280;
const POP_H = 96;

// Import-time wiring, so the globals have to exist first. One mount per process: node's
// module cache means the module body runs exactly once.
const dom = mountPlusTips({ innerWidth: VIEWPORT, popWidth: POP_W, popHeight: POP_H });
await import('../../public/scripts/stagify-plus-tips.js');

/** Put a trigger at a known place in the viewport. */
function placeTrigger(button, { top = 400, left = 300, width = 17 } = {}) {
  button.rect = { top, left, width, height: 17, bottom: top + 17, right: left + width };
}

/** Reset to "nothing open" between tests without re-importing the module. */
function closeAll() {
  dom.fireDocument('keydown', { key: 'Escape' });
}

test('every trigger in the shipped page gets wired, and starts collapsed', () => {
  const tips = pageTips();
  assert.equal(dom.buttons.length, tips.length, 'the module skipped a trigger');
  for (const btn of dom.buttons) {
    assert.equal(btn.getAttribute('aria-expanded'), 'false', 'a trigger ships expanded');
    for (const type of ['pointerenter', 'pointerleave', 'pointerdown', 'focus', 'blur', 'click']) {
      assert.ok(btn.listeners[type]?.length, `no ${type} listener on a trigger`);
    }
  }
});

test('hover opens the bubble with the row’s own copy', () => {
  const row = dom.row('Remove existing furniture');
  placeTrigger(row.button);

  row.button.fire('pointerenter', { pointerType: 'mouse' });

  const pop = dom.pop();
  assert.ok(pop, 'no bubble was created');
  assert.ok(dom.isOpen(), 'the bubble is not open');
  assert.equal(pop.textContent, row.text, 'the bubble shows some other row’s explanation');
  assert.equal(row.button.getAttribute('aria-expanded'), 'true');
  // It must not be announced twice: the source span is already wired to the button by
  // aria-describedby, so the visual copy is hidden from assistive tech.
  assert.equal(pop.getAttribute('aria-hidden'), 'true');

  row.button.fire('pointerleave', { pointerType: 'mouse' });
  assert.equal(dom.isOpen(), false, 'the bubble survived the pointer leaving');
  assert.equal(row.button.getAttribute('aria-expanded'), 'false');
});

test('the copy is re-read on every open, so a language switch is not stale', () => {
  // language-loader.js rewrites textContent on the source spans. Trap 2 in the header.
  const row = dom.row('AI Designer');
  placeTrigger(row.button);

  row.button.fire('pointerenter', { pointerType: 'mouse' });
  assert.equal(dom.pop().textContent, row.text);
  closeAll();

  row.source.textContent = 'Une fenêtre de discussion avec votre photo dedans.';
  row.button.fire('pointerenter', { pointerType: 'mouse' });
  assert.equal(
    dom.pop().textContent,
    'Une fenêtre de discussion avec votre photo dedans.',
    'the bubble is showing a string cached before the language changed',
  );
  closeAll();
});

test('opening one row closes the row that was open', () => {
  const first = dom.row('Masking tool');
  const second = dom.row('Exterior Studio');
  placeTrigger(first.button);
  placeTrigger(second.button, { top: 500 });

  first.button.fire('pointerenter', { pointerType: 'mouse' });
  second.button.fire('pointerenter', { pointerType: 'mouse' });

  assert.equal(first.button.getAttribute('aria-expanded'), 'false', 'two rows report themselves open');
  assert.equal(second.button.getAttribute('aria-expanded'), 'true');
  assert.equal(dom.pop().textContent, second.text);
  closeAll();
});

test('the bubble sits above the trigger, and flips below near the top of the viewport', () => {
  const row = dom.row('High quality image model');

  placeTrigger(row.button, { top: 600 });
  row.button.fire('pointerenter', { pointerType: 'mouse' });
  let pop = dom.pop();
  assert.equal(pop.style.top, `${600 - POP_H - 10}px`, 'the bubble should hang above the trigger');
  assert.equal(pop.classList.contains('sp-tip-pop--below'), false);
  closeAll();

  // The first row of the table is the one a visitor reads first, and it is the one with
  // no room above it — so the flip is not an edge case here, it is the common case.
  placeTrigger(row.button, { top: 40 });
  row.button.fire('pointerenter', { pointerType: 'mouse' });
  pop = dom.pop();
  assert.equal(pop.style.top, `${40 + 17 + 10}px`, 'the bubble should drop below the trigger');
  assert.ok(pop.classList.contains('sp-tip-pop--below'), 'the arrow must flip with it');
  closeAll();
});

test('a bubble that would overhang the viewport is clamped, and its arrow follows', () => {
  // Trap 3 in the header: fixed positioning in <body> means nothing else clamps it.
  const row = dom.row('Furniture references');
  const triggerLeft = VIEWPORT - 30; // a trigger hard against the right edge
  placeTrigger(row.button, { left: triggerLeft });

  row.button.fire('pointerenter', { pointerType: 'mouse' });
  const pop = dom.pop();

  const left = Number(pop.style.left.replace('px', ''));
  assert.equal(left, VIEWPORT - POP_W - 8, 'the bubble should stop 8px short of the right edge');
  assert.ok(left + POP_W <= VIEWPORT, 'the bubble runs off the right edge');

  // The arrow is measured from the bubble's own left edge, so it still lands on the
  // trigger's centre even though the bubble is no longer centred on it.
  const arrow = Number(pop.style.props['--sp-tip-arrow'].replace('px', ''));
  assert.equal(arrow, Math.round(triggerLeft + 17 / 2 - left), 'the arrow no longer points at its row');
  assert.ok(arrow > 0 && arrow < POP_W, 'the arrow is outside the bubble');
  closeAll();
});

test('a trigger at the left edge is clamped to the margin, not to a negative x', () => {
  const row = dom.row('Rooms saved in your gallery');
  placeTrigger(row.button, { left: 4 });
  row.button.fire('pointerenter', { pointerType: 'mouse' });
  assert.equal(dom.pop().style.left, '8px');
  closeAll();
});

test('touch: the first tap opens and the second closes', () => {
  // Trap 1 in the header. The whole sequence is replayed, in order, because it is the
  // ORDER that broke the naive version — asserting on `click` alone would pass either way.
  const row = dom.row('Multiple variations per generation');
  placeTrigger(row.button);

  const tap = () => {
    row.button.fire('pointerenter', { pointerType: 'touch' });
    row.button.fire('pointerdown', { pointerType: 'touch' });
    row.button.fire('focus');
    return row.button.fire('click', { detail: 1 });
  };

  const first = tap();
  assert.ok(first.defaultPrevented, 'the click must not fall through to the page');
  assert.equal(dom.isOpen(), true, 'the first tap left the button looking dead');
  assert.equal(dom.pop().textContent, row.text);

  tap();
  assert.equal(dom.isOpen(), false, 'a second tap should dismiss it');
  closeAll();
});

test('a mouse click does not take away the bubble the hover just opened', () => {
  const row = dom.row('Masking Studio');
  placeTrigger(row.button);

  row.button.fire('pointerenter', { pointerType: 'mouse' });
  row.button.fire('pointerdown', { pointerType: 'mouse' });
  row.button.fire('focus');
  row.button.fire('click', { detail: 1 });

  assert.equal(dom.isOpen(), true, 'clicking the ⓘ under the cursor closed it');
  closeAll();
});

test('keyboard focus opens it and Escape closes it', () => {
  const row = dom.row('Customizable staging');
  placeTrigger(row.button);

  row.button.fire('focus');
  assert.equal(dom.isOpen(), true, 'a tab stop that reveals nothing is a dead control');

  dom.fireDocument('keydown', { key: 'Escape' });
  assert.equal(dom.isOpen(), false);
  assert.equal(row.button.getAttribute('aria-expanded'), 'false');
});

test('a tap anywhere else dismisses it — the only way out on touch', () => {
  const row = dom.row('Fast image model');
  placeTrigger(row.button);
  row.button.fire('pointerenter', { pointerType: 'mouse' });
  assert.equal(dom.isOpen(), true);

  // Something that is not the trigger. FakeEl.contains is identity, as Node.contains is
  // for a leaf, so this is the real check the module runs.
  dom.fireDocument('pointerdown', { target: dom.row('Masking tool').button });
  assert.equal(dom.isOpen(), false);
});

test('scrolling repositions the bubble instead of dropping it', () => {
  // <main> is the scroll container on this site, so the listener is registered in the
  // capture phase; the shim fires whatever was registered either way. What matters here
  // is that the bubble tracks rather than vanishing under a trackpad nudge.
  const row = dom.row('Unlimited staging generations');
  placeTrigger(row.button, { top: 600 });
  row.button.fire('pointerenter', { pointerType: 'mouse' });
  const before = dom.pop().style.top;

  placeTrigger(row.button, { top: 520 });
  dom.fireDocument('scroll');
  assert.equal(dom.flushFrames(), 1, 'the reposition should be coalesced into one frame');

  assert.notEqual(dom.pop().style.top, before, 'the bubble stayed behind when the page scrolled');
  assert.equal(dom.pop().style.top, `${520 - POP_H - 10}px`);
  assert.equal(dom.isOpen(), true, 'scrolling should not close it');
  closeAll();
});

test('repeated scroll events coalesce into a single frame, and none is queued when closed', () => {
  const row = dom.row('Unlimited staging generations');
  placeTrigger(row.button, { top: 600 });
  row.button.fire('pointerenter', { pointerType: 'mouse' });

  dom.fireDocument('scroll');
  dom.fireDocument('scroll');
  dom.fireDocument('scroll');
  assert.equal(dom.flushFrames(), 1, 'a scroll burst should not queue a frame each');

  closeAll();
  dom.fireDocument('scroll');
  dom.fireWindow('resize');
  assert.equal(dom.flushFrames(), 0, 'a closed bubble should do no work on scroll');
});
