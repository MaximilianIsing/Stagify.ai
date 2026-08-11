// Tier: frontend island logic — public/scripts/exterior-studio/controls.js.
//
// The opt-in panel. The first build showed a "Time of day" and a "Sky" dropdown that both
// defaulted to "Keep as photographed" — functionally a no-op, but it read as a form to
// fill in, so someone who only wanted the bin bags gone still had to understand and
// decide against two controls about the weather.
//
// Two properties carry that fix, and both fail silently:
//   • AN UNTICKED ROW SENDS 'keep', whatever its select happens to say. The select keeps a
//     preselected value so ticking the row asks for something concrete — read it
//     unconditionally and every request quietly carries a golden-hour relight.
//   • hasRequest() GATES THE SUBMIT BUTTON. An empty request is not rejected by the
//     server; it falls through to a generic correction pass, which is a real render,
//     really billed, that nobody asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls, KEEP } from '../../../public/scripts/exterior-studio/controls.js';
import { pageHtml } from '../../helpers/exterior-studio-dom.js';

/** A stand-in for one form control. */
function field(id, props = {}) {
  const attrs = { ...props.attrs };
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  return {
    id,
    checked: false,
    value: '',
    hidden: false,
    ...props,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    hasAttribute: (k) => k in attrs,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
    type: props.type || '',
  };
}

/**
 * A root exposing the controls the island queries, plus a recorder for onChange.
 * The ids are the real page's — see the markup assertion at the bottom.
 */
function mount() {
  const els = {
    'ex-use-time': field('ex-use-time', { type: 'checkbox', attrs: { 'data-ex-reveals': 'ex-time-body' } }),
    'ex-use-sky': field('ex-use-sky', { type: 'checkbox', attrs: { 'data-ex-reveals': 'ex-sky-body' } }),
    'ex-time-body': field('ex-time-body'),
    'ex-sky-body': field('ex-sky-body'),
    'ex-time': field('ex-time', { value: 'goldenHour' }),
    'ex-sky': field('ex-sky', { value: 'clearBlue' }),
    'ex-vehicles': field('ex-vehicles', { type: 'checkbox' }),
    'ex-clutter': field('ex-clutter', { type: 'checkbox' }),
    'ex-people': field('ex-people', { type: 'checkbox' }),
    'ex-snow': field('ex-snow', { type: 'checkbox' }),
    'ex-wet': field('ex-wet', { type: 'checkbox' }),
    'ex-notes': field('ex-notes', { value: '' }),
  };
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  const root = {
    querySelector: (sel) => els[sel.replace('#', '')] || null,
    querySelectorAll: (sel) => {
      if (sel === '[data-ex-reveals]') return [els['ex-use-time'], els['ex-use-sky']];
      if (sel === 'input[type="checkbox"]') {
        return Object.values(els).filter((e) => e.type === 'checkbox');
      }
      return [];
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
  };
  let changes = 0;
  const api = createControls({ root, onChange: () => { changes += 1; } });
  return { api, els, root, changes: () => changes };
}

// ---- the default state ------------------------------------------------------

test('nothing is requested until something is ticked', () => {
  const m = mount();
  assert.equal(m.api.hasRequest(), false, 'a fresh panel asks for nothing');
  const r = m.api.read();
  assert.equal(r.timeOfDay, KEEP);
  assert.equal(r.sky, KEEP);
  assert.equal(r.removeVehicles, false);
  assert.equal(r.removeClutter, false);
});

test('the reveal bodies start hidden and follow their checkbox', () => {
  const m = mount();
  assert.equal(m.els['ex-time-body'].hidden, true);

  m.els['ex-use-time'].checked = true;
  m.root.fire('change');
  assert.equal(m.els['ex-time-body'].hidden, false);
  assert.equal(m.els['ex-sky-body'].hidden, true, 'rows are independent');

  m.els['ex-use-time'].checked = false;
  m.root.fire('change');
  assert.equal(m.els['ex-time-body'].hidden, true, 'and it goes away again');
});

// ---- the read contract ------------------------------------------------------

test('an UNTICKED preset sends `keep`, whatever its select says', () => {
  // The bug this prevents is invisible: the select is preselected so that ticking the row
  // asks for something concrete, which means a naive read sends `goldenHour` on every
  // request — relighting the photo of someone who only wanted the bins gone.
  const m = mount();
  m.els['ex-time'].value = 'dusk';
  m.els['ex-sky'].value = 'dramatic';
  const r = m.api.read();
  assert.equal(r.timeOfDay, KEEP);
  assert.equal(r.sky, KEEP);
});

test('a TICKED preset sends its select value', () => {
  const m = mount();
  m.els['ex-use-time'].checked = true;
  m.els['ex-time'].value = 'dusk';
  assert.equal(m.api.read().timeOfDay, 'dusk');
  assert.equal(m.api.read().sky, KEEP, 'the other row is untouched');
});

test('the cleanup toggles are independent of the presets', () => {
  const m = mount();
  m.els['ex-clutter'].checked = true;
  const r = m.api.read();
  assert.equal(r.removeClutter, true);
  assert.equal(r.removeVehicles, false);
  assert.equal(r.timeOfDay, KEEP, 'clearing the bins does not relight the scene');
  assert.equal(r.sky, KEEP);
});

// ---- hasRequest -------------------------------------------------------------

test('hasRequest is true for ANY single change, and only then', () => {
  // "I just want to remove trash bags" has to be a complete, submittable request on its
  // own — that is the whole point of the redesign.
  for (const set of [
    (m) => { m.els['ex-use-time'].checked = true; },
    (m) => { m.els['ex-use-sky'].checked = true; },
    (m) => { m.els['ex-vehicles'].checked = true; },
    (m) => { m.els['ex-clutter'].checked = true; },
    (m) => { m.els['ex-people'].checked = true; },
    (m) => { m.els['ex-snow'].checked = true; },
    (m) => { m.els['ex-wet'].checked = true; },
    (m) => { m.els['ex-notes'].value = 'remove the bin bags'; },
  ]) {
    const m = mount();
    assert.equal(m.api.hasRequest(), false);
    set(m);
    assert.equal(m.api.hasRequest(), true);
  }
});

test('whitespace-only free text is not a request', () => {
  const m = mount();
  m.els['ex-notes'].value = '   \n  ';
  assert.equal(m.api.hasRequest(), false, 'the server would fall through to a billed no-op');
});

// ---- change notification ----------------------------------------------------

test('onChange fires on a checkbox change and on TYPING in the notes box', () => {
  // `change` on a textarea only fires on blur, so without the extra `input` listener the
  // submit button stays disabled while somebody types the only thing they wanted — they
  // have to click elsewhere before the tool believes them.
  const m = mount();
  const before = m.changes();
  m.root.fire('change');
  assert.equal(m.changes(), before + 1, 'a ticked box re-evaluates the button');

  m.els['ex-notes'].value = 'remove the bin bags';
  m.els['ex-notes'].fire('input');
  assert.equal(m.changes(), before + 2, 'and so does a keystroke in the notes box');
});

// There was a `reset()` here too, which unticked everything and closed the revealed
// bodies. It existed for one caller — the "Start over" button — and went when that button
// did. Nothing else ever wanted the options cleared: the whole point of what replaced it
// is that a finished render keeps the request and asks only for the next photo.

// ---- the markup this island is wired to ------------------------------------

test('the real page carries every id the island queries', () => {
  // The island resolves its controls by id from the live form. A rename in the markup
  // makes each lookup null, which degrades to "nothing is ever requested" — a silent
  // no-op rather than an error.
  const html = pageHtml();
  for (const id of ['ex-use-time', 'ex-use-sky', 'ex-time-body', 'ex-sky-body', 'ex-time', 'ex-sky', 'ex-vehicles', 'ex-clutter', 'ex-notes']) {
    assert.ok(html.includes(`id="${id}"`), `the page must carry #${id}`);
  }
  // And the reveal wiring is declarative, so a third row is markup only.
  assert.match(html, /data-ex-reveals="ex-time-body"/);
  assert.match(html, /data-ex-reveals="ex-sky-body"/);
});

/**
 * The removal rows the shipped page actually carries, as `{ id, name }`.
 *
 * Only the removals: the two preset toggles are `<input type="checkbox">` as well, but they
 * carry `data-ex-reveals` and no `name`, because what goes on the wire for those is the
 * select's value rather than the box's state.
 */
function markupRemovals() {
  return [...pageHtml().matchAll(/<input type="checkbox"([^>]*)>/g)]
    .map((m) => ({
      id: /\sid="([^"]+)"/.exec(m[1])?.[1] || '',
      name: /\sname="([^"]+)"/.exec(m[1])?.[1] || '',
    }))
    .filter((row) => row.name);
}

test('DRIFT GUARD: read() reports exactly the removal rows the real page ships', () => {
  // THE HOLE THIS CLOSES. A removal has to be spelled the same way in five files —
  // the clause table, the markup, eleven language packs, this island, and the FormData in
  // enhance.js. test/i18n/exterior-options-i18n.test.js already pins the first three
  // against each other, so a row can reach the page fully translated, with a working
  // prompt clause behind it, and still do NOTHING because the island never learned to read
  // it. There is no error, no warning and no failed request: the user ticks "clear the
  // snow", pays for a render, and gets their photo back with the snow still on it.
  //
  // Driven off the shipped markup rather than a list here, so the guard cannot be satisfied
  // by updating the test alongside the page and forgetting the island — which is the exact
  // order those two get edited in.
  const rows = markupRemovals();
  assert.ok(rows.length >= 5, `expected the page's removal rows, found ${rows.length}`);

  // A root exposing exactly the page's own ids, every box ticked.
  /** @type {Record<string, any>} */
  const els = {};
  for (const { id } of rows) els[id] = field(id, { type: 'checkbox', checked: true });
  const api = createControls({
    root: {
      querySelector: (sel) => els[sel.replace('#', '')] || null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  });
  const request = api.read();

  for (const { id, name } of rows) {
    assert.equal(
      request[name], true,
      `#${id} posts as "${name}", but read() does not report it — the tickbox does nothing`,
    );
  }

  // And the other direction: a row deleted from the page must not leave the island still
  // posting a field for it, which would resurrect the clause server-side for anyone whose
  // browser cached the old markup.
  const reported = Object.keys(request).filter((k) => typeof request[k] === 'boolean');
  assert.deepEqual(
    reported.sort(),
    rows.map((r) => r.name).sort(),
    'read() and the markup must agree on the removal set exactly, in both directions',
  );

  assert.equal(api.hasRequest(), true, 'and a ticked removal is a submittable request on its own');
});
