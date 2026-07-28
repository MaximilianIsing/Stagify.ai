// Tier: frontend island logic (DOM-shimmed) — public/scripts/ai-designer/file-intake.js.
//
// Every route a file takes into the AI Designer chat: the picker, drag-and-drop,
// paste, HEIC conversion. It is the client half of an upload limit, and each of its
// caps fails in a way nobody notices locally:
//
//  1. THE CAPS ARE A CONTRACT WITH THE SERVER. Five files, 25MB each, a fixed
//     extension allowlist. The 25MB cap deliberately sits UNDER the server's 50MB
//     chat-upload limit so the user is told "too big" instantly instead of watching
//     a long upload get dropped. Raise or lose it and the failure moves from a
//     toast to a timeout.
//  2. PARTIAL BATCHES MUST STILL LAND. Drop six files with one bad one and the
//     other five must be added, with the skipped ones named. "All or nothing" and
//     "silently drop the excess" are both wrong and both look fine in a screenshot.
//  3. selectedFiles IS THE ENTRY'S ARRAY, MUTATED IN PLACE. The entry
//     (ai-designer-app.js) holds the same reference and reads it when the message
//     is sent. Reassigning it here detaches the two: the chips render, and the
//     message uploads nothing.
//  4. REMOVING A CHIP MUST REMOVE THAT CHIP. An off-by-one drops the wrong
//     attachment, and the preview redraws so convincingly that the only symptom is
//     the wrong file arriving.
//  5. THE PICKER MUST RESET. <input type=file> does not fire `change` when you pick
//     the same file twice; clearing .value is what makes re-adding work.
//
// Deliberately NOT asserted: the chip markup (class names, the icon's inline CSS),
// or how many listeners get registered. The DOM is a hand-rolled shim — house
// style, no jsdom (see test/helpers/mask-dom.js for the same note).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFileIntake } from '../../../public/scripts/ai-designer/file-intake.js';

const MB = 1024 * 1024;

// ── shim ───────────────────────────────────────────────────────────────────────

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.style = {};
    this.attrs = {};
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.classes = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => this.classes.add(x)),
      remove: (...n) => n.forEach((x) => this.classes.delete(x)),
      contains: (n) => this.classes.has(n),
    };
  }

  get innerHTML() { return this._html || ''; }
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
  emit(t, ev = {}) {
    const e = { preventDefault() {}, stopPropagation() {}, ...ev };
    (this.listeners.get(t) || []).forEach((fn) => fn(e));
  }
  contains(node) { return node === this || this.children.some((c) => c.contains?.(node)); }
  walk() { return [this, ...this.children.flatMap((c) => (c.walk ? c.walk() : [c]))]; }
}

const REAL = {
  document: globalThis.document,
  window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  createObjectURL: /** @type {any} */ (globalThis.URL).createObjectURL,
};
const openTimers = new Set();
const realClearTimeout = clearTimeout;
const realSetTimeout = setTimeout;

afterEach(() => {
  openTimers.forEach((id) => realClearTimeout(id));
  openTimers.clear();
  globalThis.document = REAL.document;
  globalThis.window = REAL.window;
  globalThis.requestAnimationFrame = REAL.requestAnimationFrame;
  if (REAL.createObjectURL) /** @type {any} */ (globalThis.URL).createObjectURL = REAL.createObjectURL;
  else delete (/** @type {any} */ (globalThis.URL)).createObjectURL;
});

/**
 * @param {{ selectedFiles?: any[], heic?: null | { isHeic: (f: any) => boolean, toDisplayableFile: (f: any) => Promise<any> } }} opts
 */
function harness({ selectedFiles = [], heic = null } = {}) {
  const byId = new Map();
  const previewContainer = new FakeEl('div');
  const previewList = new FakeEl('div');
  byId.set('file-preview-container', previewContainer);
  byId.set('file-preview-list', previewList);

  const body = new FakeEl('body');
  const docListeners = new Map();
  let activeElement = null;

  globalThis.document = {
    body,
    get activeElement() { return activeElement; },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (t, fn) => { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
  };
  globalThis.window = { LanguageSystem: null, StagifyHeic: heic };
  // showToast reveals on the next frame; run it inline so the message is
  // observable without waiting.
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  /** @type {any} */ (globalThis.URL).createObjectURL = (f) => `blob:${f.name}`;

  // The toast's removal timers are long; keep them out of the runner's way.
  const patchedSetTimeout = (fn, ms, ...rest) => {
    const id = realSetTimeout(fn, Math.min(ms || 0, 1), ...rest);
    openTimers.add(id);
    return id;
  };
  globalThis.setTimeout = patchedSetTimeout;

  const chatMessages = new FakeEl('div');
  const chatContainer = new FakeEl('div');
  chatContainer.offsetParent = body; // "visible", for the paste guard
  const chatInput = new FakeEl('textarea');
  const fileInput = new FakeEl('input');

  let sendButtonUpdates = 0;
  const api = createFileIntake({
    selectedFiles,
    chatMessages,
    chatContainer,
    chatInput,
    fileInput: /** @type {any} */ (fileInput),
    updateSendButtonState: () => { sendButtonUpdates += 1; },
  });

  const toasts = () => {
    const host = body.children.find((c) => c.attrs['aria-live']);
    return host ? host.children.map((t) => t.textContent) : [];
  };

  return {
    api, selectedFiles, previewContainer, previewList, chatMessages, chatContainer, fileInput,
    toasts,
    sendButtonUpdates: () => sendButtonUpdates,
    setActive: (el) => { activeElement = el; },
    /** Chip labels currently rendered, in order. */
    chipNames: () => previewList.children.map((item) => {
      const info = item.children.find((c) => c.className === 'file-info');
      const name = info?.children.find((c) => c.className === 'file-name');
      return name?.textContent;
    }),
    /** Click the remove button on the Nth chip. */
    removeChip: (i) => {
      const btn = previewList.children[i].children.find((c) => c.className === 'file-remove');
      btn.onclick();
    },
    // The change event's target IS the input, and the module clears its .value;
    // returning it lets a test observe that reset.
    pick: async (files) => {
      const target = { files, value: 'C:\\fakepath\\a.png' };
      fileInput.emit('change', { target });
      await tick();
      return target;
    },
    drop: async (files, on = chatMessages) => {
      on.emit('drop', { dataTransfer: { files, types: ['Files'] } });
      await tick();
    },
    dragEnter: (on = chatMessages) => on.emit('dragenter', { dataTransfer: { types: ['Files'] } }),
    dragLeave: (on = chatMessages, relatedTarget = null) => on.emit('dragleave', { dataTransfer: { types: ['Files'] }, relatedTarget }),
    paste: async (items) => {
      let defaultPrevented = false;
      (docListeners.get('paste') || []).forEach((fn) => fn({
        preventDefault() { defaultPrevented = true; },
        clipboardData: { items },
      }));
      await tick();
      return defaultPrevented;
    },
    dragHighlighted: () => chatMessages.classList.contains('drag-over'),
  };
}

const tick = () => new Promise((r) => realSetTimeout(r, 1));
const file = (name, { type = '', size = 1024 } = {}) => ({ name, type, size });
const img = (name, size = 1024) => file(name, { type: 'image/png', size });

// ── the caps ───────────────────────────────────────────────────────────────────

test('an unsupported file is skipped BY NAME while the rest of the batch lands', () => {
  const h = harness();
  h.drop([img('room.png'), file('macro.exe', { type: 'application/x-msdownload' }), file('plan.pdf')]);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['room.png', 'plan.pdf'],
    'one bad file must not discard the batch');
  assert.deepEqual(h.toasts(), ['Skipped: macro.exe (unsupported type)']);
});

test('the extension allowlist admits documents that carry no MIME type', () => {
  // Browsers report an empty `type` for plenty of real uploads; the allowlist is
  // what keeps those working.
  const h = harness();
  h.drop(['plan.pdf', 'notes.txt', 'brief.doc', 'brief.docx', 'shot.JPG', 'shot.webp', 'loop.gif'].map((n) => file(n)));
  assert.equal(h.selectedFiles.length, 5, 'capped at five, but every one of them was admitted');
  assert.deepEqual(h.toasts().filter((t) => /unsupported/.test(t)), []);
});

test('an image is admitted on its MIME type even with an unlisted extension', () => {
  const h = harness();
  h.drop([file('scan.heif', { type: 'image/heif' })]);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['scan.heif']);
});

test('a file over 25MB is refused before the upload starts, not during it', () => {
  // The cap sits under the server's 50MB limit on purpose: the point is to fail
  // instantly rather than after a long upload the server then drops.
  const h = harness();
  h.drop([img('huge.png', 25 * MB + 1), img('exactly.png', 25 * MB), img('fine.png', 25 * MB - 1)]);
  assert.deepEqual(
    h.selectedFiles.map((f) => f.name),
    ['exactly.png', 'fine.png'],
    'the cap is inclusive — a file of exactly 25MB is allowed',
  );
  assert.deepEqual(h.toasts(), ['Skipped: huge.png (over 25MB)']);
});

test('the sixth file is refused and the user is told how many were added', () => {
  const h = harness();
  h.drop([1, 2, 3, 4, 5, 6, 7].map((i) => img(`a${i}.png`)));
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['a1.png', 'a2.png', 'a3.png', 'a4.png', 'a5.png']);
  assert.equal(h.toasts().length, 1);
  assert.match(h.toasts()[0], /Added 5.*2 not added/, 'silently dropping the excess is the failure mode here');
});

test('adding to an already-full list adds nothing and says so', () => {
  const h = harness({ selectedFiles: [1, 2, 3, 4, 5].map((i) => img(`a${i}.png`)) });
  h.drop([img('extra.png')]);
  assert.equal(h.selectedFiles.length, 5);
  assert.equal(h.selectedFiles.some((f) => f.name === 'extra.png'), false);
  assert.match(h.toasts()[0], /Maximum of 5 files/);
});

test('a batch of only-bad files leaves the list untouched', () => {
  const h = harness({ selectedFiles: [img('kept.png')] });
  h.drop([file('a.exe'), file('b.dmg')]);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['kept.png']);
});

// ── the shared array ───────────────────────────────────────────────────────────

test('the entry\'s array is mutated in place, never replaced', () => {
  // The entry holds this exact reference and reads it when the message is sent.
  // A reassignment here renders chips for files that never get uploaded.
  const shared = [];
  const h = harness({ selectedFiles: shared });
  h.drop([img('a.png'), img('b.png')]);
  assert.equal(h.selectedFiles, shared, 'same reference');
  assert.deepEqual(shared.map((f) => f.name), ['a.png', 'b.png']);

  h.removeChip(0);
  assert.deepEqual(shared.map((f) => f.name), ['b.png'], 'removal must reach the entry too');
});

test('removing a chip removes THAT file, not a neighbour', () => {
  const h = harness();
  h.drop([img('a.png'), img('b.png'), img('c.png')]);
  assert.deepEqual(h.chipNames(), ['a.png', 'b.png', 'c.png']);

  h.removeChip(1);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['a.png', 'c.png']);
  assert.deepEqual(h.chipNames(), ['a.png', 'c.png'], 'the preview must redraw against the new list');

  // Removing again exercises the re-bound indices: the chip at 1 is now c.png.
  h.removeChip(1);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['a.png']);
});

test('emptying the list clears the preview and drops its has-files state', () => {
  const h = harness();
  h.drop([img('a.png')]);
  assert.equal(h.previewContainer.classList.contains('has-files'), true);
  h.removeChip(0);
  assert.equal(h.previewContainer.classList.contains('has-files'), false);
  assert.deepEqual(h.chipNames(), []);
});

test('the send button is re-evaluated whenever the attachment list changes', () => {
  // Without this the Send button stays disabled with files attached, or enabled
  // with none — the only visible symptom of a missed call.
  const h = harness();
  const before = h.sendButtonUpdates();
  h.drop([img('a.png')]);
  const afterAdd = h.sendButtonUpdates();
  assert.ok(afterAdd > before, 'adding a file must refresh the send button');
  h.removeChip(0);
  assert.ok(h.sendButtonUpdates() > afterAdd, 'and so must removing one');
});

// ── the picker ─────────────────────────────────────────────────────────────────

test('the picker is reset after a change so the same file can be picked twice', async () => {
  // <input type=file> fires no `change` when re-picking an identical file. This
  // is the only thing that makes "remove it, add it back" work.
  const h = harness();
  const input = await h.pick([img('a.png')]);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['a.png']);
  assert.equal(input.value, '', 'the input still holding the old path swallows the next identical pick');
});

// ── HEIC ───────────────────────────────────────────────────────────────────────

test('an iPhone HEIC is converted before it enters the list', async () => {
  // Most browsers cannot decode HEIC, so an unconverted one produces a broken
  // preview chip and an upload the model cannot read.
  const heic = {
    isHeic: (f) => /\.heic$/i.test(f.name),
    toDisplayableFile: async (f) => img(f.name.replace(/\.heic$/i, '.jpg')),
  };
  const h = harness({ heic });
  await h.drop([file('IMG_0001.HEIC', { type: 'image/heic' }), img('b.png')]);
  assert.deepEqual(h.selectedFiles.map((f) => f.name), ['IMG_0001.jpg', 'b.png']);
});

test('a HEIC that will not convert is reported, and nothing half-converted is added', async () => {
  const heic = {
    isHeic: () => true,
    toDisplayableFile: async () => { throw new Error('decode failed'); },
  };
  const h = harness({ heic });
  await h.drop([file('IMG_0001.HEIC', { type: 'image/heic' })]);
  assert.deepEqual(h.selectedFiles, []);
  assert.equal(h.toasts().length, 1);
  assert.match(h.toasts()[0], /HEIC/);
});

// ── paste ──────────────────────────────────────────────────────────────────────

test('pasting an image attaches it', async () => {
  const h = harness();
  const blob = { type: 'image/png', name: 'blob' };
  const prevented = await h.paste([{ type: 'image/png', getAsFile: () => blob }]);
  assert.equal(h.selectedFiles.length, 1);
  assert.match(h.selectedFiles[0].name, /^pasted-image-\d+\.png$/);
  assert.equal(prevented, true, 'the paste must not also land in the textarea');
});

test('pasting text is left alone', async () => {
  const h = harness();
  const prevented = await h.paste([{ type: 'text/plain', getAsFile: () => null }]);
  assert.deepEqual(h.selectedFiles, []);
  assert.equal(prevented, false, 'a text paste must still reach the input the user is typing in');
});

test('a paste while typing in another input is not hijacked', async () => {
  // The bug report shape: pasting into the bug-report or search field and having
  // the image silently attached to the chat instead.
  const h = harness();
  h.setActive({ tagName: 'INPUT', type: 'text' });
  await h.paste([{ type: 'image/png', getAsFile: () => ({ type: 'image/png' }) }]);
  assert.deepEqual(h.selectedFiles, []);
});

test('a multi-image paste attaches one image, not a burst of them', async () => {
  const h = harness();
  const item = (n) => ({ type: 'image/png', getAsFile: () => ({ type: 'image/png', name: n }) });
  await h.paste([item('a'), item('b'), item('c')]);
  assert.equal(h.selectedFiles.length, 1);
});

// ── drag highlight ─────────────────────────────────────────────────────────────

test('dragging over a nested child does not drop the highlight early', () => {
  // dragenter/dragleave fire per element, so crossing a child inside the drop
  // zone emits a leave. Counting is what stops the zone flickering off mid-drag.
  const h = harness();
  h.dragEnter();
  assert.equal(h.dragHighlighted(), true);
  h.dragEnter(); // entering a nested child
  h.dragLeave(); // leaving that child
  assert.equal(h.dragHighlighted(), true, 'still over the drop zone');
  h.dragLeave();
  assert.equal(h.dragHighlighted(), false);
});

test('a completed drop clears the highlight even after unbalanced enters', () => {
  const h = harness();
  h.dragEnter();
  h.dragEnter();
  h.drop([img('a.png')]);
  assert.equal(h.dragHighlighted(), false, 'a stuck highlight covers the chat');
});
