// Tier: unit (hand-rolled document shim, no jsdom) —
// public/scripts/api-keys/create-key-dialog.js.
//
// WHAT THIS COVERS
// The dialog that shows a plaintext API key exactly once. Everything here is about that
// one fact being handled safely:
//   - the key reaches the DOM as textContent, never innerHTML,
//   - reopening the dialog NEVER shows the previous key — it is cleared out of the DOM,
//     not merely hidden, so it cannot be recovered from the page afterwards,
//   - Escape closes the form half but NOT the reveal, because dismissing an
//     unrecoverable secret has to be deliberate,
//   - focus returns to whatever opened the dialog rather than being dropped on <body>,
//   - a server error is shown in the dialog instead of closing it and losing the input.
//
// The element ids are read from the REAL public/api-keys.html, so renaming one in the
// page fails this spec rather than leaving it asserting against a stub that no longer
// ships — the same approach as test/helpers/gallery-dom.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyDialog } from '../../../public/scripts/api-keys/create-key-dialog.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PAGE = path.join(ROOT, 'public', 'api-keys.html');

/** Every id the shipped dialog markup declares. */
function pageIds() {
  return new Set([...fs.readFileSync(PAGE, 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

/** A minimal element: the classList, text and event surface the dialog touches. */
function makeEl(id) {
  const classes = new Set(id === 'ak-modal' || id === 'ak-modal-reveal' || id === 'ak-modal-error' ? ['hidden'] : []);
  return {
    id,
    value: '',
    textContent: '',
    focused: 0,
    handlers: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    focus() { this.focused += 1; },
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    fire(type, ev = {}) { (this.handlers[type] || []).forEach((fn) => fn(ev)); },
  };
}

let els;
let docHandlers;

beforeEach(() => {
  els = new Map();
  docHandlers = {};
  const ids = pageIds();
  // Only ids the page really ships — a typo in the source would produce an element
  // here that does not exist in the browser.
  for (const id of ids) els.set(id, makeEl(id));

  globalThis.document = {
    getElementById: (id) => els.get(id) || null,
    addEventListener: (type, fn) => { (docHandlers[type] ||= []).push(fn); },
  };
  setClipboard(async () => {});
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.navigator;
});

/**
 * Install a clipboard stub.
 *
 * defineProperty rather than assignment: Node exposes `globalThis.navigator` as a
 * getter-only accessor, so `globalThis.navigator = …` throws outright.
 * @param {() => Promise<void>} writeText - The stubbed write.
 */
function setClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText } },
    configurable: true,
    writable: true,
  });
}

const el = (id) => els.get(id);
const escape = () => (docHandlers.keydown || []).forEach((fn) => fn({ key: 'Escape' }));

test('the dialog markup this spec drives is really in the page', () => {
  const ids = pageIds();
  for (const id of ['ak-modal', 'ak-modal-form', 'ak-modal-reveal', 'ak-name', 'ak-confirm',
    'ak-cancel', 'ak-done', 'ak-copy', 'ak-reveal-key', 'ak-modal-error', 'ak-modal-close']) {
    assert.ok(ids.has(id), `public/api-keys.html no longer ships id="${id}"`);
  }
});

test('creating a key reveals it as text, and hides the form', async () => {
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: true, key: 'stg_live_secret' }) });
  dialog.open();
  el('ak-name').value = 'CI';

  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));

  // textContent, not innerHTML: a credential has no business going through an HTML parser.
  assert.equal(el('ak-reveal-key').textContent, 'stg_live_secret');
  assert.equal(el('ak-modal-form').classList.contains('hidden'), true);
  assert.equal(el('ak-modal-reveal').classList.contains('hidden'), false);
  assert.ok(el('ak-done').focused >= 1, 'focus moves to the only remaining action');
});

test('reopening never shows the previous key — it is cleared from the DOM', async () => {
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: true, key: 'stg_live_first' }) });
  dialog.open();
  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(el('ak-reveal-key').textContent, 'stg_live_first');

  dialog.close();
  assert.equal(el('ak-reveal-key').textContent, '', 'the key must not linger in the page');

  dialog.open();
  assert.equal(el('ak-reveal-key').textContent, '');
  assert.equal(el('ak-modal-reveal').classList.contains('hidden'), true, 'back to the form');
  assert.equal(el('ak-name').value, '', 'and the name field is fresh');
});

test('Escape closes the form half but NOT a revealed key', async () => {
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: true, key: 'stg_live_x' }) });

  dialog.open();
  escape();
  assert.equal(el('ak-modal').classList.contains('hidden'), true, 'the form half is dismissable');

  dialog.open();
  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));
  escape();
  assert.equal(
    el('ak-modal').classList.contains('hidden'),
    false,
    'a stray Escape must not throw away a key that can never be shown again',
  );
});

test('focus returns to whatever opened the dialog', () => {
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: true }) });
  const trigger = makeEl('ak-create');

  dialog.open(trigger);
  assert.ok(el('ak-name').focused >= 1, 'focus enters the panel on open');
  dialog.close();
  assert.equal(trigger.focused, 1, 'and comes back — not to <body>, where a keyboard user is stranded');
});

test('a server error is shown in the dialog and the input is kept', async () => {
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: false, error: 'Too many keys' }) });
  dialog.open();
  el('ak-name').value = 'CI';

  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));

  assert.equal(el('ak-modal-error').textContent, 'Too many keys');
  assert.equal(el('ak-modal-error').classList.contains('hidden'), false);
  assert.equal(el('ak-modal').classList.contains('hidden'), false, 'the dialog stays open');
  assert.equal(el('ak-name').value, 'CI', 'and does not eat what they typed');
});

test('a failure clears the busy latch so the second attempt is not ignored', async () => {
  let calls = 0;
  const dialog = createKeyDialog({
    onCreate: async () => { calls += 1; return calls === 1 ? { ok: false, error: 'nope' } : { ok: true, key: 'k' }; },
  });
  dialog.open();

  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));
  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));

  assert.equal(calls, 2, 'a user who fixes the problem and retries must get through');
});

test('Enter in the name field submits', async () => {
  let seen = null;
  const dialog = createKeyDialog({ onCreate: async (name) => { seen = name; return { ok: true, key: 'k' }; } });
  dialog.open();
  el('ak-name').value = 'From Enter';

  let prevented = false;
  el('ak-name').fire('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
  await new Promise((r) => setImmediate(r));

  assert.equal(seen, 'From Enter');
  assert.equal(prevented, true, 'the default would submit an enclosing form');
});

test('closing fires the after-close hook so the page can refresh', () => {
  let closed = 0;
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: true }), onClosed: () => { closed += 1; } });
  dialog.open();
  el('ak-cancel').fire('click');
  assert.equal(closed, 1);
});

test('a refused clipboard is reported rather than silently doing nothing', async () => {
  setClipboard(async () => { throw new Error('denied'); });
  const dialog = createKeyDialog({ onCreate: async () => ({ ok: true, key: 'stg_live_x' }) });
  dialog.open();
  el('ak-confirm').fire('click');
  await new Promise((r) => setImmediate(r));

  el('ak-copy').fire('click');
  await new Promise((r) => setImmediate(r));
  assert.match(el('ak-copy').textContent, /select/i, 'tell them to copy it by hand');
});
