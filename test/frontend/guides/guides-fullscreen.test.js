// Tier: unit + markup contract — the guides walkthroughs' expand control.
//
// This control had ZERO coverage, and it was broken on every iPhone as a result. Two
// independent faults, both of which this file now pins:
//
//   1. guides.css never restated `[hidden]`, which is a UA rule at (0,0,0) and loses
//      outright to the author `display: inline-flex`. So `btn.hidden = true` did
//      nothing, `@media (hover: none)` forced the button visible, and the branch had
//      already returned WITHOUT wiring a click handler — a permanent 44x44 tap target
//      that did nothing at all. home.css had carried the fix for its twin for months.
//
//   2. That branch fires wherever `document.fullscreenEnabled` is falsy, which is every
//      iPhone (Safari has no unprefixed element fullscreen). A phone is now exactly
//      where the control has a job — it opens the rotate-to-landscape view, which needs
//      no fullscreen support — so hiding it there is the opposite of right.
//
// The markup half is asserted against the shipped page; the behaviour half runs
// initGuides() against the DOM shim in test/helpers/guides-dom.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initGuides } from '../../../public/scripts/guides.js';
import { guidesDocument, pageSource } from '../../helpers/guides-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const guidesCss = () => read('public', 'styles', 'guides.css');
const guidesJs = () => read('public', 'scripts', 'guides.js');

/** The six controls, as they ship. */
function controls() {
  return [...pageSource().matchAll(/<button[^>]*data-guide-fullscreen[\s\S]*?<\/button>/g)].map((m) => m[0]);
}

// ---- the markup ----------------------------------------------------------------------

test('every walkthrough panel carries the control, identically wired', () => {
  const buttons = controls();
  assert.equal(buttons.length, 6, `expected one control per walkthrough, found ${buttons.length}`);
  for (const btn of buttons) {
    assert.match(btn, /type="button"/, 'not a submit button');
    // aria-pressed carries the state, so the label never changes shape mid-toggle.
    assert.match(btn, /aria-pressed="false"/, 'starts unpressed');
    // Guides borrows the homepage's namespace: one key, two pages, one translation.
    assert.match(btn, /data-lang-attr="home\.showcase\.fullscreen\|aria-label"/, 'localised label');
    for (const glyph of ['guide-demo-fs__open', 'guide-demo-fs__close', 'guide-demo-fs__rotate']) {
      assert.ok(btn.includes(`class="${glyph}"`), `carries the ${glyph} glyph`);
    }
  }
});

// ---- the CSS -------------------------------------------------------------------------

test('guides.css restates [hidden] so the script can actually hide the control', () => {
  assert.match(
    guidesCss(),
    /\.guide-demo-fs\[hidden\]\s*\{[^}]*display:\s*none/,
    'without this the author display: inline-flex beats the UA [hidden] rule outright'
  );
});

test('the rotate glyph is the phone default and yields to the close glyph once open', () => {
  const css = guidesCss().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.guide-demo-fs__rotate[^{]*\{[^}]*display:\s*none/, 'hidden by default');
  assert.match(
    css,
    /\.guide-demo-fs\.is-mobile-rotate \.guide-demo-fs__rotate\s*\{[^}]*display:\s*block/,
    'shown once immersive-view.js marks the button as a phone control'
  );
  assert.match(
    css,
    /\.guide-demo-fs\.is-mobile-rotate\.is-fs \.guide-demo-fs__rotate\s*\{[^}]*display:\s*none/,
    'and gives way once the view is open, where the button is a close affordance'
  );
});

test('the immersive block derives the frame width from the stage height', () => {
  // Same regression the :fullscreen block above it guards: width-driven overflows and
  // a pinned height crops (the step images are object-fit: cover). Under rotation a
  // literal 100vh is the WRONG axis, which is what --imv-box exists to carry.
  const css = guidesCss().replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/\.guide-demo-panel\.is-immersive \.sdp__frame\s*\{([^}]*)\}/);
  assert.ok(rule, '.sdp__frame is sized under .is-immersive');
  assert.match(rule[1], /var\(--imv-box/, 'from the overlay stage height, not a literal vh');
  assert.match(rule[1], /var\(--ar/, 'and the demo aspect ratio');
  assert.match(rule[1], /height:\s*auto/, 'so aspect-ratio computes the height back');
  // The dots are brand blue for the page and all but vanish on the dark backdrop.
  assert.match(css, /\.guide-demo-panel\.is-immersive \.sdp__dot\s*\{/, 'the dots are re-coloured too');
});

// ---- the behaviour -------------------------------------------------------------------

/** Boot the page against the shim. `phone` drives the PHONE_QUERY match. */
function boot({ fullscreenEnabled = true, phone = false } = {}) {
  const ctx = guidesDocument();
  ctx.document.fullscreenEnabled = fullscreenEnabled;
  const real = ctx.window.matchMedia;
  ctx.window.matchMedia = (q) => (/pointer:\s*coarse/.test(q) ? { matches: phone, addEventListener() {} } : real(q));
  initGuides({ doc: ctx.document, win: ctx.window });
  return ctx;
}

test('a desktop click enters native fullscreen on the panel', () => {
  const ctx = boot({ fullscreenEnabled: true, phone: false });
  const panel = ctx.panels[0];
  panel.fsButton.fire('click');
  assert.equal(ctx.document.fullscreenElement, panel, 'the PANEL goes fullscreen, not the frame');
  // The panel is the player's root, so the frame, the callout card and the dots all
  // travel together — that is why the target is the panel and not .sdp__frame.
  assert.equal(panel.fsButton.getAttribute('aria-pressed'), 'true');
  assert.equal(panel.fsButton.classList.contains('is-fs'), true);
});

test('a second desktop click exits again — the control toggles', () => {
  const ctx = boot({ fullscreenEnabled: true, phone: false });
  const panel = ctx.panels[0];
  panel.fsButton.fire('click');
  panel.fsButton.fire('click');
  assert.equal(ctx.document.fullscreenElement, null);
  assert.equal(panel.fsButton.getAttribute('aria-pressed'), 'false');
});

test('the control is hidden where fullscreen is unavailable AND there is no phone path', () => {
  const ctx = boot({ fullscreenEnabled: false, phone: false });
  for (const panel of ctx.panels) {
    assert.equal(panel.fsButton.hidden, true, 'an embed with no allowfullscreen gets no dead button');
  }
});

test('a phone keeps the control even with no fullscreen support at all', () => {
  // The whole point. This is the iPhone case: document.fullscreenEnabled is falsy and
  // the rotate path does not care, because it never calls requestFullscreen.
  const ctx = boot({ fullscreenEnabled: false, phone: true });
  for (const panel of ctx.panels) {
    assert.equal(panel.fsButton.hidden, false, 'the rotate control must survive on iPhone');
  }
  assert.equal(
    ctx.panels[0].fsButton.getAttribute('data-lang-attr'),
    'home.showcase.rotate|aria-label',
    'and it says what it now does'
  );
});

test('a phone click does not attempt native fullscreen', () => {
  const ctx = boot({ fullscreenEnabled: true, phone: true });
  ctx.panels[0].fsButton.fire('click');
  assert.equal(ctx.document.fullscreenElement, null, 'the rotate path never requests fullscreen');
});

// ---- the source contract -------------------------------------------------------------

test('the hide branch is gated on the phone check, not on fullscreenEnabled alone', () => {
  const js = guidesJs();
  const guard = js.match(/if \(!doc\.fullscreenEnabled[^)]*\)/);
  assert.ok(guard, 'the guard exists');
  assert.match(guard[0], /phone\(\)/, 'and must not fire on a phone');
});

test('switching walkthroughs is blocked while a panel is portaled away', () => {
  // A hashchange landing mid-view would leave the old panel floating in an overlay that
  // no longer belongs to the active tab, and restoring it on close would put it back
  // beside a panel that has since taken over.
  const js = guidesJs().replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(js, /function setDemo\([\s\S]{0,200}?if \(anyImmersiveOpen\(\)\) return;/, 'setDemo bails');
});
