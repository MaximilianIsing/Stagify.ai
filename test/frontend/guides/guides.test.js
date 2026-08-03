// The guides page's walkthrough tablist.
//
// WHAT THIS COVERS
// Two things that were broken and invisible.
//
// 1. DEEP LINKS. The page emits HowTo structured data naming
//    `guides.html#guide-demo-<key>` as the URL of every step, so search engines are
//    already serving those links. Every panel but the first ships `hidden`, so the
//    browser had nothing to scroll to and the visitor was shown the Free walkthrough
//    whichever result they clicked. Nothing failed; the page just answered the wrong
//    question.
//
// 2. THE TABLIST WAS ONLY A TABLIST BY NAME. role="tab" with no aria-controls, no ids to
//    point aria-labelledby at, no arrow keys and six independent tab stops. The role told
//    assistive tech to expect tabs and then gave it none of the wiring that makes them
//    navigable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initGuides, demoFromHash } from '../../../public/scripts/guides.js';
import { guidesDocument, pageTabs, pageSource } from '../../helpers/guides-dom.js';

const selected = (ctx) => ctx.tabs.find((t) => t.getAttribute('aria-selected') === 'true');
const visible = (ctx) => ctx.panels.filter((p) => !p.hidden);

/** Boot against the real page's tabs, with the URL already carrying `hash`. */
function boot(hash = '', opts = {}) {
  const ctx = guidesDocument({ hash, ...opts });
  initGuides({ doc: ctx.document, win: ctx.window });
  return ctx;
}

// ---- the markup contract the structured data depends on ------------------------------

test('every advertised HowTo deep link names a panel that exists', () => {
  // The failure this catches is a rename: the ids are published in JSON-LD, so changing
  // one silently breaks a URL Google is already serving.
  const src = pageSource();
  const advertised = [...new Set([...src.matchAll(/guides\.html#(guide-demo-[a-z]+)/g)].map((m) => m[1]))];
  assert.ok(advertised.length >= 5, `expected the HowTo blocks to publish deep links, found ${advertised.length}`);

  const panelIds = pageTabs().map((t) => t.controls);
  for (const id of advertised) {
    assert.ok(panelIds.includes(id), `structured data advertises #${id}, which no tab controls`);
    assert.match(src, new RegExp(`id="${id}"`), `#${id} is advertised but no element has that id`);
  }
});

test('each tab names the panel it controls, and each panel names its tab', () => {
  const tabs = pageTabs();
  assert.equal(tabs.length, 6);
  const src = pageSource();
  for (const tab of tabs) {
    assert.ok(tab.id, `the ${tab.demo} tab has no id for aria-labelledby to point at`);
    assert.equal(tab.controls, `guide-demo-${tab.demo}`, `${tab.demo}: aria-controls does not match its panel`);
    assert.match(src, new RegExp(`aria-labelledby="${tab.id}"`), `no panel points back at #${tab.id}`);
  }
});

test('exactly one tab ships selected and in the tab order', () => {
  // Roving tabindex: the tablist is ONE stop. Six 0s is the bug this pins.
  const tabs = pageTabs();
  assert.deepEqual(tabs.filter((t) => t.selected === 'true').map((t) => t.demo), ['free']);
  assert.deepEqual(tabs.filter((t) => t.tabindex === '0').map((t) => t.demo), ['free']);
  assert.equal(tabs.filter((t) => t.tabindex === '-1').length, 5);
});

// ---- deep links ----------------------------------------------------------------------

test('demoFromHash reads only a well-formed walkthrough hash', () => {
  const at = (hash) => demoFromHash({ location: { hash } });
  assert.equal(at('#guide-demo-masking'), 'masking');
  assert.equal(at('#guide-demo-free'), 'free');
  assert.equal(at(''), '');
  assert.equal(at('#th-billing'), '', 'a troubleshooting anchor is not a walkthrough');
  assert.equal(at('#guide-demo-'), '');
  assert.equal(at('#guide-demo-masking-extra'), '');
});

test('landing on a published deep link opens THAT walkthrough, not the first one', () => {
  const ctx = boot('#guide-demo-masking');

  assert.equal(selected(ctx).getAttribute('data-demo'), 'masking');
  assert.deepEqual(visible(ctx).map((p) => p.getAttribute('data-demo')), ['masking']);
});

test('and scrolls it into view, because the browser could not', () => {
  // The hash target was `hidden` when the browser processed it, so it scrolled nowhere.
  const ctx = boot('#guide-demo-prompt');
  assert.ok(ctx.panelFor('prompt').scrolledIntoView, 'the deep-linked panel was never brought into view');
});

test('a hash naming no walkthrough leaves the default alone', () => {
  // #th-billing is a troubleshooting card — a real anchor on this page that must not be
  // mistaken for a demo key.
  const ctx = boot('#th-billing');
  assert.equal(selected(ctx).getAttribute('data-demo'), 'free');
  assert.deepEqual(visible(ctx).map((p) => p.getAttribute('data-demo')), ['free']);
});

test('changing the hash later switches walkthrough too', () => {
  const ctx = boot('');
  ctx.window.location.hash = '#guide-demo-furniture';
  ctx.window.fire('hashchange');

  assert.equal(selected(ctx).getAttribute('data-demo'), 'furniture');
  assert.equal(ctx.document.activeElement, ctx.tabFor('furniture'), 'focus should follow a hash jump');
});

test('picking a tab publishes a link to it, without stacking history entries', () => {
  // replaceState, not location.hash: assigning the hash scrolls the page out from under
  // the click AND pushes an entry, so six presses would need six presses of Back.
  const ctx = boot('');
  ctx.tabFor('designer').fire('click');

  assert.deepEqual(ctx.replacedUrls, ['#guide-demo-designer']);
  assert.equal(selected(ctx).getAttribute('data-demo'), 'designer');
});

// ---- keyboard ------------------------------------------------------------------------

test('arrow keys move along the tablist and open as they go', () => {
  const ctx = boot('');
  ctx.document.activeElement = ctx.tabFor('free');

  ctx.picker.fire('keydown', { key: 'ArrowRight' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'plus');
  assert.equal(ctx.document.activeElement, ctx.tabFor('plus'), 'focus must follow the selection');

  ctx.picker.fire('keydown', { key: 'ArrowRight' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'designer');
});

test('the tablist wraps at both ends', () => {
  const ctx = boot('');
  ctx.document.activeElement = ctx.tabFor('free');

  ctx.picker.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'furniture', 'left from the first wraps to the last');

  ctx.picker.fire('keydown', { key: 'ArrowRight' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'free', 'right from the last wraps to the first');
});

test('Home and End jump to the ends', () => {
  const ctx = boot('');
  ctx.document.activeElement = ctx.tabFor('designer');

  ctx.picker.fire('keydown', { key: 'End' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'furniture');

  ctx.picker.fire('keydown', { key: 'Home' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'free');
});

test('keys that are not navigation are left to the browser', () => {
  // Swallowing Tab here would trap focus in the tablist.
  const ctx = boot('');
  ctx.document.activeElement = ctx.tabFor('free');

  let prevented = false;
  ctx.picker.fire('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(selected(ctx).getAttribute('data-demo'), 'free');
});

test('a keypress with focus outside the tablist is ignored', () => {
  const ctx = boot('');
  ctx.document.activeElement = null;
  ctx.picker.fire('keydown', { key: 'ArrowRight' });
  assert.equal(selected(ctx).getAttribute('data-demo'), 'free');
});

// ---- roving tabindex is maintained, not just shipped ---------------------------------

test('switching tabs moves the single tab stop with the selection', () => {
  const ctx = boot('');
  ctx.tabFor('masking').fire('click');

  const stops = ctx.tabs.filter((t) => t.getAttribute('tabindex') === '0');
  assert.deepEqual(stops.map((t) => t.getAttribute('data-demo')), ['masking']);
  assert.equal(ctx.tabs.filter((t) => t.getAttribute('tabindex') === '-1').length, 5);
});

test('only one panel is ever visible', () => {
  const ctx = boot('');
  for (const demo of ['plus', 'masking', 'free', 'furniture']) {
    ctx.tabFor(demo).fire('click');
    assert.deepEqual(visible(ctx).map((p) => p.getAttribute('data-demo')), [demo]);
    assert.equal(selected(ctx).getAttribute('data-demo'), demo);
  }
});
