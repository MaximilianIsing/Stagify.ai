// The advertising opt-out control (public/scripts/ad-optout.js) — the mechanism
// behind privacy.html §16.3.
//
// WHY THIS IS TESTED RATHER THAN LEDGERED AS UNTESTED. This is not a cosmetic
// widget: the policy now states that the site shares personal information for
// cross-context behavioral advertising and that this control is how you stop it.
// A button that silently fails to write the flag would make that statement false,
// and the visitor would have no way to tell — the page would say "you are opted
// out" while gtag.js kept loading on every subsequent page.
//
// Three states have to be distinguishable and are easy to conflate:
//   1. opted out — the flag is stored, the tag will not load next time;
//   2. opted in — no flag, the tag loads;
//   3. storage unavailable — the choice CANNOT be honored, and saying "saved"
//      would be a lie. Private-mode browsers are a real population, not a corner.
//
// A GPC browser is a fourth: it is opted out by gtag.js before this file parses,
// so the control must not offer a toggle that could not change the outcome. An
// EEA/UK/Swiss visitor is a fifth, and the one most easily conflated with the
// others: the tag is withheld there by the region gate in gtag.js regardless of
// what this control stores, so a toggle would be a button that changes nothing
// and a "you are opted in" message would be flatly wrong.
//
// DOM is a hand-built shim rather than jsdom, matching the other frontend tests
// (see test/helpers/plus-tips-dom.js for the same trade). The module is imported
// ONCE — node caches module bodies — and each test drives the exported `render`
// directly, which is why that export exists.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** A minimal element good enough for the handful of DOM calls the module makes. */
class FakeEl {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.type = '';
    this.className = '';
    /** @type {FakeEl[]} */
    this.children = [];
    /** Backing store for the textContent accessor below. */
    this._text = '';
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    /** @type {FakeEl | null} */
    this.parent = null;
  }

  // Real textContent semantics, and the module depends on them: `host.textContent
  // = ''` is how render() empties the box before redrawing. A plain property would
  // leave every previous button in place and the test would pass while the live
  // page accumulated controls.
  get textContent() { return this._text; }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  appendChild(/** @type {FakeEl} */ el) {
    el.parent = this;
    this.children.push(el);
    return el;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  click() {
    for (const fn of this.listeners.click ?? []) fn({ type: 'click' });
  }

  /** Every descendant of `tag`, in document order. */
  find(/** @type {string} */ tag) {
    const want = tag.toUpperCase();
    return this.children.flatMap((c) => (c.tagName === want ? [c] : c.find(tag)));
  }

  /** All text under this node, joined — what a reader would see. */
  get text() {
    return [this._text, ...this.children.map((c) => c.text)].filter(Boolean).join(' ');
  }
}

/** Storage that can be made to throw, the way a private-mode browser does. */
function makeStorage({ throws = false, initial = null } = {}) {
  let value = initial;
  const boom = () => { throw new Error('storage is disabled'); };
  return {
    read: () => value,
    getItem: throws ? boom : () => value,
    setItem: throws ? boom : (/** @type {string} */ _k, /** @type {string} */ v) => { value = v; },
    removeItem: throws ? boom : () => { value = null; },
  };
}

/**
 * Point the globals at a fresh world.
 * @param {{ stored?: string | null, gpc?: boolean, tagged?: boolean, storageThrows?: boolean, region?: boolean }} [opts]
 */
function world({ stored = null, gpc = false, tagged = true, storageThrows = false, region = false } = {}) {
  const storage = makeStorage({ throws: storageThrows, initial: stored });
  globalThis.window = /** @type {any} */ ({
    localStorage: storage,
    __gtagConfigured: region ? false : tagged,
    __gtagRegionBlocked: region,
  });
  // node 21+ ships a real `navigator` whose property is getter-only, so a plain
  // assignment throws — defineProperty is the way to shadow it.
  Object.defineProperty(globalThis, 'navigator', {
    value: /** @type {any} */ (gpc ? { globalPrivacyControl: true } : {}),
    configurable: true,
    writable: true,
  });
  globalThis.document = /** @type {any} */ ({
    getElementById: () => null, // the import-time wiring finds nothing; tests call render()
    createElement: (/** @type {string} */ tag) => new FakeEl(tag),
  });
  return { storage, host: new FakeEl('div') };
}

// Import-time wiring needs the globals to exist, even though it finds no host.
world();
const { render, STORAGE_KEY } = await import('../../public/scripts/ad-optout.js');

/** Render into a fresh world and hand back the pieces. */
function mount(opts) {
  const { storage, host } = world(opts);
  render(/** @type {any} */ (host));
  return { storage, host, button: host.find('button')[0] ?? null };
}

beforeEach(() => { world(); });

test('an opted-in visitor is told so, and offered the opt-out', () => {
  const { host, button } = mount({ stored: null });
  assert.match(host.text, /Advertising cookies are currently active/);
  assert.ok(button, 'the control must offer a button');
  assert.match(button.textContent, /Do not share my personal information/);
});

test('clicking it writes the exact flag gtag.js reads', () => {
  const { storage, button } = mount({ stored: null });
  button.click();
  // The whole contract in one assertion: gtag.js checks
  // localStorage[stagifyAdOptOut] === '1' before it configures anything.
  assert.equal(storage.read(), '1');
  assert.equal(STORAGE_KEY, 'stagifyAdOptOut');
});

test('after opting out the control says so and offers the way back', () => {
  const { host, button } = mount({ stored: '1' });
  assert.match(host.text, /You are opted out/);
  assert.match(button.textContent, /Turn advertising cookies back on/);
});

test('opting back in clears the flag rather than writing a falsy value', () => {
  const { storage, button } = mount({ stored: '1' });
  button.click();
  // A leftover '0' would read as "not opted out" to gtag.js today, but it is the
  // kind of value a later `=== '0'` check would misinterpret. Remove, don't unset.
  assert.equal(storage.read(), null);
});

test('the re-render after a click reflects the new state', () => {
  const { host } = mount({ stored: null });
  host.find('button')[0].click();
  assert.match(host.text, /You are opted out/);
  assert.equal(host.find('button').length, 1, 'the old button must not be left behind');
});

test('opting out while the tag already loaded says the reload is what matters', () => {
  const { host } = mount({ stored: null, tagged: true });
  host.find('button')[0].click();
  // Honesty about the one thing a visitor could reasonably misread: this page's tag
  // already ran and cannot be recalled.
  assert.match(host.text, /already loaded on this page/);
});

test('a GPC browser is told it is already covered, with nothing to click', () => {
  const { host, button } = mount({ gpc: true });
  assert.match(host.text, /Global Privacy Control/);
  assert.equal(button, null, 'a toggle here could not change the outcome, so it must not be offered');
});

test('GPC wins even when the stored flag says otherwise', () => {
  const { host, button } = mount({ gpc: true, stored: null });
  assert.match(host.text, /switched off on every page/);
  assert.equal(button, null);
});

test('a browser blocking storage is told the choice did not save', () => {
  const { host } = mount({ storageThrows: true });
  // Reads fail closed to "not opted out" (matching gtag.js, which loads the tag),
  // so the control renders — but the WRITE is where the truth has to come out.
  host.find('button')[0].click();
  assert.match(host.text, /could not be saved/);
  assert.match(host.text, /team@stagify\.ai/, 'the visitor needs a route that does work');
  assert.equal(host.find('button').length, 0, 'a button that cannot work must not stay clickable');
  assert.doesNotMatch(host.text, /Saved\./, 'it must never claim success it did not achieve');
});

test('an EEA visitor is told the tag never loads here, with nothing to click', () => {
  const { host, button } = mount({ region: true });
  assert.match(host.text, /EEA, the UK, or Switzerland/);
  assert.match(host.text, /nothing has been sent to Google/);
  assert.equal(button, null, 'the region gate cannot be toggled, so no button may be offered');
});

test('the region gate outranks a stored opt-in', () => {
  // The likeliest wrong outcome: an EEA visitor who once clicked "turn them back
  // on" being told advertising cookies are active when gtag.js never loaded.
  const { host, button } = mount({ region: true, stored: null });
  assert.doesNotMatch(host.text, /currently active/);
  assert.equal(button, null);
});
