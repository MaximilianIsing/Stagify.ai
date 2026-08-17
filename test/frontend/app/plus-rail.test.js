// Tier: unit — public/scripts/app/plus-rail.js, the "What Stagify+ could add" rail at the
// foot of the staging toolbar.
//
// Exercised against a minimal fake DOM (no jsdom), matching the other island suites.
// The markup half is checked by reading index.html as a STRING, the way
// staging-menu.test.js does — index.html is never parsed into a DOM here.
//
// What would rot without this file:
//   • the rail shipping `hidden`, which would hide it from the free and signed-out
//     visitors it exists for whenever auth.js is slow or absent;
//   • the rail shipping OPEN, which would push the free controls up the modal;
//   • a data-lang creeping onto a wrapper that holds an icon — language-loader.js sets
//     textContent wholesale, so the icon would vanish on the first translation pass;
//   • a label reworded in the markup without its key (or the reverse), which shows the
//     authored English until language-loader.js runs and then silently flips to whatever
//     the stale key actually says — this happened once already during development;
//   • the list drifting into features with no control in this modal, which is the
//     pricing page's job, not the staging toolbar's;
//   • the permanent opt-out losing its "permanent": the flag is only read on the
//     syncPlusRail path, so a future caller that shows the rail without going through
//     it would resurrect a rail somebody switched off, and nothing on screen would say
//     why. The storage-refused case is covered too, because it is the one where the
//     button appears to do nothing and the temptation is to hide the rail optimistically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Newlines normalised because the block sentinel below is anchored to one. Git stores
// this file LF, but core.autocrlf checks it out CRLF on Windows, so without this the
// slice silently finds nothing and every markup assertion here fails on a dev machine
// while passing in CI — the worst possible split.
const INDEX_HTML = fs
  .readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/\r\n/g, '\n');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/languages/english.json'), 'utf8'));

/** The rail's markup block, isolated so no assertion can accidentally match the page. */
const RAIL_HTML = (() => {
  const start = INDEX_HTML.indexOf('<div class="plus-rail" id="plus-rail">');
  assert.notEqual(start, -1, 'index.html should contain the #plus-rail block');
  const end = INDEX_HTML.indexOf('</div>\n                </div>', start);
  assert.notEqual(end, -1, 'the #plus-rail block should close before the toolbar does');
  return INDEX_HTML.slice(start, end);
})();

// --- fake DOM ---------------------------------------------------------------

function makeToggle() {
  /** @type {Record<string, string>} */
  const attrs = { 'aria-expanded': 'false' };
  /** @type {Array<() => void>} */
  const listeners = [];
  return {
    attrs,
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    addEventListener(_type, fn) {
      listeners.push(fn);
    },
    click() {
      listeners.forEach((fn) => fn());
    },
  };
}

function makeRail() {
  const classes = new Set();
  /** @type {Record<string, string>} */
  const attrs = {};
  const toggle = makeToggle();
  const hide = makeToggle();
  return {
    toggle,
    hide,
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    querySelector(sel) {
      if (sel === '.plus-rail__bar') return toggle;
      if (sel === '.plus-rail__hide') return hide;
      return null;
    },
  };
}

/**
 * A localStorage stand-in. `mode: 'throw'` is the private-mode / storage-disabled
 * browser, which throws on BOTH getItem and setItem — the case the module has to fail
 * open on rather than hiding the rail it could not record a decision about.
 * @param {{ seeded?: boolean, mode?: 'ok' | 'throw' }} [opts]
 */
function makeStorage({ seeded = false, mode = 'ok' } = {}) {
  /** @type {Record<string, string>} */
  const store = seeded ? { plusRailDismissed: '1' } : {};
  return {
    store,
    getItem(k) {
      if (mode === 'throw') throw new Error('storage disabled');
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      if (mode === 'throw') throw new Error('storage disabled');
      store[k] = String(v);
    },
  };
}

/**
 * @param {{ plan?: string, withRail?: boolean, storage?: any }} [opts] - omit `plan` for
 *   a signed-out visitor (no StagifyAuth at all), which is a state the rail must show in.
 */
function mount({ plan, withRail = true, storage = makeStorage() } = {}) {
  const rail = withRail ? makeRail() : null;
  globalThis.document = /** @type {any} */ ({
    getElementById: (id) => (id === 'plus-rail' ? rail : null),
  });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth:
      plan === undefined ? undefined : { isProUser: () => plan === 'pro', user: { plan } },
    localStorage: storage,
  });
  return rail;
}

const { plusRailVisible, plusRailDismissed, syncPlusRail, initPlusRail } = await import(
  '../../../public/scripts/app/plus-rail.js'
);

// --- the rule ---------------------------------------------------------------

test('plusRailVisible is the inverse of the pro plan', () => {
  assert.equal(plusRailVisible(false), true, 'free and signed-out visitors get the rail');
  assert.equal(plusRailVisible(true), false, 'a subscriber is not sold what they already have');
});

test('plusRailVisible treats the dismissal as a second, independent veto', () => {
  // Two different reasons, and the rule must not collapse them into one: the plan
  // reverses itself when a subscription lapses, the dismissal never does.
  assert.equal(plusRailVisible(false, true), false, 'a free visitor who dismissed it stays clear');
  assert.equal(plusRailVisible(true, true), false, 'pro AND dismissed is still hidden');
  assert.equal(plusRailVisible(false, false), true, 'not pro, not dismissed — the rail shows');
});

// --- the writer -------------------------------------------------------------

test('syncPlusRail shows the rail for free, signed-out and enterprise-free visitors', () => {
  for (const plan of ['free', undefined]) {
    const rail = mount({ plan });
    assert.equal(syncPlusRail(), true, `plan=${plan} should see the rail`);
    assert.equal(rail.classList.contains('hidden'), false, `plan=${plan} rail should not be hidden`);
  }
});

test('syncPlusRail hides the rail for a pro plan', () => {
  const rail = mount({ plan: 'pro' });
  assert.equal(syncPlusRail(), false, 'a pro account should not see the rail');
  assert.equal(rail.classList.contains('hidden'), true, 'the rail should carry .hidden');
});

test('hiding the rail also collapses it', () => {
  // Open it as a free user, then upgrade mid-session. Without the collapse, signing back
  // out would spring the rail open again — still expanded, still selling what was bought.
  const rail = mount({ plan: 'free' });
  initPlusRail();
  rail.toggle.click();
  assert.equal(rail.hasAttribute('data-open'), true, 'clicking should open the rail');

  mountOnto(rail, 'pro');
  syncPlusRail();
  assert.equal(rail.hasAttribute('data-open'), false, 'hiding should drop data-open');
  assert.equal(
    rail.toggle.getAttribute('aria-expanded'),
    'false',
    'aria-expanded must follow data-open, never disagree with it',
  );
});

/** Swap the plan without rebuilding the rail, so open state survives the change. */
function mountOnto(rail, plan, storage = makeStorage()) {
  globalThis.document = /** @type {any} */ ({
    getElementById: (id) => (id === 'plus-rail' ? rail : null),
  });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: { isProUser: () => plan === 'pro', user: { plan } },
    localStorage: storage,
  });
}

test('syncPlusRail and initPlusRail no-op on pages without the stage modal', () => {
  mount({ plan: 'free', withRail: false });
  assert.equal(syncPlusRail(), false, 'no rail means nothing to show');
  assert.doesNotThrow(() => initPlusRail(), 'initPlusRail must survive a page with no rail');
});

// --- the disclosure ---------------------------------------------------------

test('initPlusRail toggles data-open and aria-expanded together', () => {
  const rail = mount({ plan: 'free' });
  initPlusRail();

  rail.toggle.click();
  assert.equal(rail.hasAttribute('data-open'), true, 'first click opens');
  assert.equal(rail.toggle.getAttribute('aria-expanded'), 'true', 'and announces open');

  rail.toggle.click();
  assert.equal(rail.hasAttribute('data-open'), false, 'second click shuts');
  assert.equal(rail.toggle.getAttribute('aria-expanded'), 'false', 'and announces shut');
});

// --- the permanent opt-out --------------------------------------------------

test('the hide button writes the flag and takes the rail away', () => {
  const storage = makeStorage();
  const rail = mount({ plan: 'free', storage });
  initPlusRail();
  assert.equal(rail.classList.contains('hidden'), false, 'it starts on screen');

  rail.hide.click();
  assert.equal(storage.store.plusRailDismissed, '1', 'the choice is recorded, not just applied');
  assert.equal(rail.classList.contains('hidden'), true, 'and the rail leaves immediately');
  assert.equal(rail.hasAttribute('data-open'), false, 'leaving collapses it, like the plan path');
});

test('a dismissed rail never comes back on a later load', () => {
  // The reason initPlusRail() syncs at all. auth.js calls syncPlusRail() on boot for the
  // plan, but the dismissal has no such caller — without the sync here the rail would
  // flash back on every page load until applyUserToUI() happened to run.
  const storage = makeStorage({ seeded: true });
  const rail = mount({ plan: 'free', storage });
  initPlusRail();
  assert.equal(rail.classList.contains('hidden'), true, 'a seeded flag hides it before any click');
  assert.equal(syncPlusRail(), false, 'and every later sync agrees');
});

test('the dismissal outlives signing out', () => {
  // A signed-in free user hides the rail, then signs out. Signing out is exactly the
  // transition that brings the rail BACK for the plan, so it is the one that would undo
  // the dismissal if the two vetoes were ever folded into one.
  const storage = makeStorage();
  const rail = mount({ plan: 'free', storage });
  initPlusRail();
  rail.hide.click();

  mountOnto(rail, undefined, storage);
  assert.equal(syncPlusRail(), false, 'signed out and dismissed is still dismissed');
});

test('storage refusing the write leaves the rail alone', () => {
  // Private mode. The button appears to do nothing, and that is correct: hiding the rail
  // optimistically would give a reader a panel that vanishes now and is back next load
  // with nothing on screen to explain it.
  const rail = mount({ plan: 'free', storage: makeStorage({ mode: 'throw' }) });
  initPlusRail();
  assert.doesNotThrow(() => rail.hide.click(), 'a throwing localStorage must not break the click');
  assert.equal(rail.classList.contains('hidden'), false, 'an unrecorded choice is not applied');
});

test('plusRailDismissed fails open when storage is unreadable', () => {
  mount({ plan: 'free', storage: makeStorage({ mode: 'throw' }) });
  assert.equal(plusRailDismissed(), false, 'the safe direction is showing a dismissable rail');
  assert.equal(syncPlusRail(), true, 'so the rail is still reachable');
});

test('the hide button is wired even if the disclosure bar is missing', () => {
  // Guards the order inside initPlusRail: an early `return` on a missing toggle used to
  // be correct when the bar was the only control, and would now silently drop the opt-out.
  const rail = makeRail();
  rail.querySelector = (sel) => (sel === '.plus-rail__hide' ? rail.hide : null);
  const storage = makeStorage();
  globalThis.document = /** @type {any} */ ({
    getElementById: (id) => (id === 'plus-rail' ? rail : null),
  });
  globalThis.window = /** @type {any} */ ({ localStorage: storage });

  initPlusRail();
  rail.hide.click();
  assert.equal(storage.store.plusRailDismissed, '1', 'the opt-out does not depend on the bar');
});

// --- the markup -------------------------------------------------------------

test('the rail ships visible and collapsed', () => {
  assert.doesNotMatch(
    RAIL_HTML,
    /<div class="plus-rail[^"]*hidden/,
    'the rail must NOT ship hidden: free and signed-out is the default state, and ' +
      'plus-rail.js only ever takes the rail away',
  );
  assert.match(
    RAIL_HTML,
    /id="plus-rail-toggle"[^>]*aria-expanded="false"/,
    'the rail must ship collapsed, so it never pushes the free controls down the modal',
  );
  assert.doesNotMatch(RAIL_HTML, /\sdata-open/, 'data-open belongs to plus-rail.js, not the markup');
});

test('the five labels are the rail’s own keys, in the chosen order', () => {
  // The rail does NOT reuse the homepage bullets or the pricing-page cards. An earlier
  // draft did, and the failure mode is silent and ugly: relabelling an item in the markup
  // while leaving the old key on it renders the authored English until the first
  // translation pass, then flips to whatever that key actually says. Pinning both the key
  // list AND each key's English value is what catches that.
  const keys = [...RAIL_HTML.matchAll(/class="plus-rail__label" data-lang="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    keys,
    [
      'modal.staging.plusRail.items.remove',
      'modal.staging.plusRail.items.model',
      'modal.staging.plusRail.items.variations',
      'modal.staging.plusRail.items.references',
      'modal.staging.plusRail.items.mask',
      'modal.staging.plusRail.items.gallery',
    ],
    'the rail should list its own six item keys, in order',
  );

  for (const key of keys) {
    const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ENGLISH);
    assert.equal(
      typeof value,
      'string',
      `${key} must exist in english.json — getText() returns undefined on a miss, which ` +
        'leaves the inline English standing and hides the gap until another locale loads',
    );
  }

  assert.match(
    RAIL_HTML,
    /data-lang="modal\.staging\.plusRail\.title"/,
    'the disclosure bar carries the rail heading',
  );
  assert.equal(
    typeof ENGLISH.modal.staging.plusRail.title,
    'string',
    'modal.staging.plusRail.title must exist in english.json',
  );
});

test('every label matches the inline English beside it', () => {
  // The guard for the drift above: if a label is reworded in the markup but its key is
  // not, or vice versa, these two disagree and the item silently changes wording the
  // moment language-loader.js runs.
  const pairs = [
    ...RAIL_HTML.matchAll(/class="plus-rail__label" data-lang="([^"]+)">([^<]+)</g),
  ].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 6, 'all six items should be matched');
  for (const [key, inline] of pairs) {
    const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ENGLISH);
    assert.equal(
      inline,
      value,
      `the inline English for ${key} must equal its english.json value — they are the ` +
        'same string shown before and after translation, so a mismatch is a visible flip',
    );
  }
});

test('the rail promises this modal, plus exactly one thing beyond it', () => {
  // Five of the six map to a Stagify+ control a free account cannot see in THIS modal:
  // #remove-furniture-row, #stagify-model-select, #stagify-variation-count,
  // #stagify-furniture-file, and the mask FAB on the result. Those five are the whole
  // set — there is no sixth hidden control in the toolbar to name.
  //
  // `gallery` is therefore a deliberate exception, and the ONLY one: it is where this
  // modal's output lands, so it is still about the render being configured. The studios
  // and the daily cap stay on the pricing page. Adding a second exception means the rail
  // has started selling a different page to somebody mid-render — so this list is pinned
  // exactly, not merely checked for the five.
  const items = ENGLISH.modal.staging.plusRail.items;
  assert.deepEqual(
    Object.keys(items),
    ['remove', 'model', 'variations', 'references', 'mask', 'gallery'],
    'the rail is the five in-modal controls plus gallery, and nothing else',
  );
  for (const id of [
    'remove-furniture-row',
    'stagify-model-select',
    'stagify-variation-count',
    'stagify-furniture-file',
  ]) {
    assert.match(
      INDEX_HTML,
      new RegExp(`id="${id}"`),
      `the rail promises a control that no longer exists: #${id}`,
    );
  }
});

test('the free gallery really is capped, so "Unlimited gallery" is a real difference', () => {
  // The one claim on this rail whose backing lives outside the modal. If the free cap were
  // ever lifted, the rail would be selling something every account already has.
  const store = fs.readFileSync(path.join(ROOT, 'lib/data/staged-renders.js'), 'utf8');
  const cap = store.match(/FREE_GALLERY_LIMIT\s*=\s*Number\(process\.env\.FREE_GALLERY_LIMIT\)\s*\|\|\s*(\d+)/);
  assert.notEqual(cap, null, 'FREE_GALLERY_LIMIT should still be defined in staged-renders.js');
  assert.ok(
    Number(cap[1]) > 0 && Number.isFinite(Number(cap[1])),
    'the free tier must still be capped for the gallery item to be an honest claim',
  );
});

test('no data-lang sits on an element that wraps an icon', () => {
  // language-loader.js does `el.textContent = value`, which destroys every child node.
  // A data-lang on a wrapper holding an <svg> eats the icon on the first translation
  // pass — the same trap as the room-type badge and the dropzone.
  assert.doesNotMatch(
    RAIL_HTML,
    /data-lang="[^"]*"[^>]*>\s*<svg/,
    'a data-lang element must not contain an <svg> — put the icon in a sibling span',
  );
  const icons = [...RAIL_HTML.matchAll(/<span class="plus-rail__ico"([^>]*)>/g)].map((m) => m[1]);
  assert.equal(icons.length, 6, 'every one of the six items should carry an icon');
  for (const attrs of icons) {
    assert.match(attrs, /aria-hidden="true"/, 'icons are decorative; the label carries the meaning');
    assert.doesNotMatch(attrs, /data-lang/, 'an icon span must never carry a data-lang');
  }
});

test('the opt-out sits inside the body, below the CTA, and is a real button', () => {
  // Placement is the whole safety argument. The dismissal cannot be undone from the UI,
  // so the reader has to open the rail to reach it — an × on the collapsed bar would sit
  // beside the disclosure chevron, where a mis-tap destroys the panel permanently.
  const body = RAIL_HTML.slice(RAIL_HTML.indexOf('<div class="plus-rail__body"'));
  const hide = body.indexOf('id="plus-rail-hide"');
  assert.notEqual(hide, -1, 'the opt-out must live inside the rail BODY, not on the bar');
  assert.ok(
    hide > body.indexOf('plus-rail__cta'),
    'the opt-out comes after the CTA — it is the quiet exit, not the offer',
  );
  assert.match(
    RAIL_HTML,
    /<button type="button" class="plus-rail__hide" id="plus-rail-hide" data-lang="modal\.staging\.plusRail\.hide">/,
    'a <button type="button"> — inside a <form>less modal a bare <button> still defaults ' +
      'to submit, and it must carry its own key, not reuse a label key',
  );
  assert.equal(
    typeof ENGLISH.modal.staging.plusRail.hide,
    'string',
    'modal.staging.plusRail.hide must exist in english.json',
  );

  const inline = RAIL_HTML.match(/id="plus-rail-hide" data-lang="[^"]+">([^<]+)</);
  assert.equal(
    inline[1],
    ENGLISH.modal.staging.plusRail.hide,
    'the inline English must equal its english.json value, or the wording flips on the ' +
      'first translation pass',
  );
});

test('nothing offers to bring a dismissed rail back', () => {
  // "Permanently" is the requirement, and the tempting follow-up is a "show tips again"
  // control somewhere. There is deliberately none: the flag is only ever written to '1'.
  const src = fs.readFileSync(path.join(ROOT, 'public/scripts/app/plus-rail.js'), 'utf8');
  assert.doesNotMatch(
    src,
    /removeItem|setItem\(DISMISS_KEY,\s*['"](?!1)/,
    'the opt-out is one-way by design — nothing may clear or unset plusRailDismissed',
  );
});

test('the CTA keeps the plus-cta interception', () => {
  // plus-cta-auth.js opens the register modal for signed-OUT visitors before sending them
  // on. The rail is shown to signed-out visitors, so unlike #staging-error-viewer-cta this
  // one genuinely wants that behaviour — you need an account before you can subscribe.
  assert.match(
    RAIL_HTML,
    /<a class="plus-cta plus-rail__cta" href="stagify-plus\.html"/,
    'the rail CTA must keep class="plus-cta" and point at the pricing page',
  );
});
