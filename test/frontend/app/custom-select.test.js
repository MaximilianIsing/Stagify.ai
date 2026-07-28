// Tier: frontend island logic (DOM-shimmed) — public/scripts/app/custom-select.js.
//
// This is the Room type / Furniture style picker in the stage modal, so whatever it
// puts in `root.dataset.value` is what gets staged. Everything it can get wrong is
// silent — the dropdown still opens, still closes, still shows a word:
//
//  1. OPTION CHROME. Options may carry a trailing badge ("New" on Dorm). The label
//     is a nested .option-label span for exactly that reason; reading the option's
//     whole textContent renders the trigger as "DormNew".
//  2. THE i18n KEY MUST MOVE WITH THE LABEL. The trigger is authored with the
//     default room's data-lang key. If picking a room doesn't overwrite that key,
//     the trigger looks right until the user switches language — at which point the
//     translator rewrites it back to the DEFAULT room while dataset.value still
//     says the chosen one. The form then stages something different from what the
//     dropdown reads. (data-lang wiping textContent is a known trap in this repo.)
//  3. set() MUST NOT FIRE onChange. Callers use set() to sync the UI to state they
//     already hold; firing there re-enters the caller's own sync logic.
//  4. A MISSING ROOT MUST NOT THROW. The component is initialised on every page that
//     loads app.js, most of which have no stage modal.
//
// The DOM is a hand-rolled shim (house style — see test/helpers/mask-dom.js). It
// models dataset/classList/textContent/attributes and listener dispatch, not layout.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { initCustomSelect } from '../../../public/scripts/app/custom-select.js';

// ── shim ───────────────────────────────────────────────────────────────────────

class FakeEl {
  /** @param {string} cls */
  constructor(cls = '') {
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.dataset = {};
    this.attrs = {};
    this.children = [];
    this.textContent = '';
    this.listeners = new Map();
    this.classList = {
      add: (...n) => n.forEach((x) => this.classes.add(x)),
      remove: (...n) => n.forEach((x) => this.classes.delete(x)),
      contains: (n) => this.classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !this.classes.has(n) : !!force;
        if (on) this.classes.add(n); else this.classes.delete(n);
        return on;
      },
    };
  }

  append(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
  emit(t, ev = {}) { (this.listeners.get(t) || []).forEach((fn) => fn(ev)); }
  walk() { return [this, ...this.children.flatMap((c) => c.walk())]; }
  matches(sel) { return sel.startsWith('.') && this.classes.has(sel.slice(1)); }
  querySelector(sel) { return this.walk().slice(1).find((e) => e.matches(sel)) || null; }
  querySelectorAll(sel) { return this.walk().slice(1).filter((e) => e.matches(sel)); }
  contains(node) { return this.walk().includes(node); }
}

const REAL_DOCUMENT = globalThis.document;
afterEach(() => { globalThis.document = REAL_DOCUMENT; });

/**
 * Build a picker matching the shipped markup.
 * @param {Array<{ value: string, label: string, langKey?: string, badge?: string }>} options
 * @param {{ triggerLangKey?: string, present?: boolean }} [opts]
 */
function mount(options, { triggerLangKey = 'modal.room.living', present = true } = {}) {
  const root = new FakeEl('custom-select');
  const trigger = root.append(new FakeEl('select-trigger'));
  const valueEl = trigger.append(new FakeEl('select-value'));
  valueEl.textContent = 'Living room';
  valueEl.setAttribute('data-lang', triggerLangKey);
  const menu = root.append(new FakeEl('select-menu'));

  const optionEls = options.map((o) => {
    const opt = menu.append(new FakeEl('option'));
    opt.dataset.value = o.value;
    if (o.langKey || o.badge) {
      // The real markup for an option that carries chrome: label in its own span.
      const label = opt.append(new FakeEl('option-label'));
      label.textContent = o.label;
      if (o.langKey) label.setAttribute('data-lang', o.langKey);
      if (o.badge) { const b = opt.append(new FakeEl('option-badge')); b.textContent = o.badge; }
      // textContent of the option as a browser would report it: label + chrome.
      opt.textContent = o.label + (o.badge || '');
    } else {
      opt.textContent = o.label;
    }
    return opt;
  });

  const docListeners = new Map();
  globalThis.document = {
    querySelector: (sel) => (present && sel === '.custom-select' ? root : null),
    addEventListener: (t, fn) => { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
  };

  return {
    root, trigger, valueEl, menu, optionEls,
    clickOutside: (target = new FakeEl('elsewhere')) =>
      (docListeners.get('click') || []).forEach((fn) => fn({ target })),
    menuOpen: () => !menu.classList.contains('hidden'),
    selectedValues: () => optionEls.filter((o) => o.classList.contains('selected')).map((o) => o.dataset.value),
  };
}

const ROOMS = [
  { value: 'living', label: 'Living room' },
  { value: 'bedroom', label: 'Bedroom', langKey: 'modal.room.bedroom' },
  { value: 'dorm', label: 'Dorm', langKey: 'modal.room.dorm', badge: 'New' },
];

// ── option chrome ──────────────────────────────────────────────────────────────

test('an option with a badge shows its label alone, not "DormNew"', () => {
  const ui = mount(ROOMS);
  const select = initCustomSelect('.custom-select');
  ui.optionEls[2].emit('click');
  assert.equal(ui.valueEl.textContent, 'Dorm');
  assert.equal(select.value, 'dorm');
});

test('an option without a nested label still reads its own text', () => {
  const ui = mount(ROOMS);
  initCustomSelect('.custom-select');
  ui.optionEls[0].emit('click');
  assert.equal(ui.valueEl.textContent, 'Living room');
});

test('labels are trimmed, because the markup is indented', () => {
  const ui = mount([{ value: 'loft', label: '\n      Loft\n    ' }]);
  initCustomSelect('.custom-select');
  ui.optionEls[0].emit('click');
  assert.equal(ui.valueEl.textContent, 'Loft');
});

test('a value with no matching option falls back to the value itself, never blank', () => {
  const ui = mount(ROOMS);
  const select = initCustomSelect('.custom-select');
  select.set('studio');
  assert.equal(ui.valueEl.textContent, 'studio');
  assert.equal(select.value, 'studio', 'and the form still submits what was asked for');
});

// ── the i18n key travels with the label ────────────────────────────────────────

test("picking a room moves the label's data-lang key onto the trigger", () => {
  // Without this the trigger keeps the DEFAULT room's key, and the next language
  // switch rewrites the trigger to "Living room" while the form still stages a
  // bedroom. Nothing errors; the dropdown just lies.
  const ui = mount(ROOMS, { triggerLangKey: 'modal.room.living' });
  const select = initCustomSelect('.custom-select');
  ui.optionEls[1].emit('click');
  assert.equal(ui.valueEl.getAttribute('data-lang'), 'modal.room.bedroom');
  assert.equal(select.value, 'bedroom', 'and the key agrees with the value');
});

test('an option with no key of its own leaves the trigger key alone rather than clearing it', () => {
  const ui = mount(ROOMS, { triggerLangKey: 'modal.room.living' });
  initCustomSelect('.custom-select');
  ui.optionEls[0].emit('click'); // 'living' has no nested label / data-lang
  assert.equal(ui.valueEl.getAttribute('data-lang'), 'modal.room.living',
    'clearing the key would leave the translator with nothing to write');
});

// ── onChange contract ──────────────────────────────────────────────────────────

test('onChange fires on a user pick, with the value already committed', () => {
  const seen = [];
  const ui = mount(ROOMS);
  const select = initCustomSelect('.custom-select', { onChange: (v) => seen.push([v, select.value]) });
  ui.optionEls[1].emit('click');
  assert.deepEqual(seen, [['bedroom', 'bedroom']],
    'the handler must not observe the pre-click value');
});

test('onChange does NOT fire for a programmatic set()', () => {
  // Callers use set() to mirror state they already own; firing here re-enters
  // whatever sync logic they are in the middle of.
  const seen = [];
  const ui = mount(ROOMS);
  const select = initCustomSelect('.custom-select', { onChange: (v) => seen.push(v) });
  select.set('dorm');
  assert.deepEqual(seen, []);
  assert.equal(select.value, 'dorm', 'but the value and label do update');
  assert.equal(ui.valueEl.textContent, 'Dorm');
});

test('a picker created without an onChange does not throw when picked', () => {
  const ui = mount(ROOMS);
  initCustomSelect('.custom-select');
  ui.optionEls[1].emit('click');
  assert.equal(ui.root.dataset.value, 'bedroom');
});

// ── open/close ─────────────────────────────────────────────────────────────────

test('the trigger toggles the menu and picking an option closes it', () => {
  const ui = mount(ROOMS);
  initCustomSelect('.custom-select');
  assert.equal(ui.menuOpen(), true, 'the fixture starts open, so "closed" below is a real change');

  ui.trigger.emit('click');
  assert.equal(ui.menuOpen(), false);
  ui.trigger.emit('click');
  assert.equal(ui.menuOpen(), true);

  ui.optionEls[1].emit('click');
  assert.equal(ui.menuOpen(), false, 'a menu left open covers the rest of the modal');
});

test('a click elsewhere on the page closes the menu; a click inside it does not', () => {
  const ui = mount(ROOMS);
  initCustomSelect('.custom-select');
  ui.clickOutside();
  assert.equal(ui.menuOpen(), false);

  ui.trigger.emit('click');
  assert.equal(ui.menuOpen(), true);
  ui.clickOutside(ui.optionEls[0]); // the document handler also sees in-menu clicks
  assert.equal(ui.menuOpen(), true, 'closing on an inside click would race the option handler');
});

// ── selection state ────────────────────────────────────────────────────────────

test('exactly one option carries .selected, and it moves', () => {
  const ui = mount(ROOMS);
  const select = initCustomSelect('.custom-select');
  select.set('bedroom');
  assert.deepEqual(ui.selectedValues(), ['bedroom']);
  ui.optionEls[2].emit('click');
  assert.deepEqual(ui.selectedValues(), ['dorm'], 'the old highlight must be cleared');
});

// ── pages without a stage modal ────────────────────────────────────────────────

test('a missing root yields an inert handle instead of throwing', () => {
  // app.js runs on every page; most have no stage modal at all.
  mount(ROOMS, { present: false });
  const select = initCustomSelect('.custom-select');
  assert.equal(select.value, '');
  assert.doesNotThrow(() => select.set('bedroom'));
  assert.equal(select.value, '', 'still inert afterwards');
});
