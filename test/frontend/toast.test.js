// Tier: frontend island logic (DOM-shimmed) — public/scripts/toast.js.
//
// The app's single user-facing message channel: it replaced nine native alert()s in
// the staging flow plus two byte-identical copies elsewhere. Everything that goes
// wrong here is a message the user never sees, which is indistinguishable from the
// app having silently done nothing.
//
// THE BUG IT WAS WRITTEN TO FIX. A toast is inserted invisible and flipped to its
// visible state one frame later, so the CSS transition actually runs. Both
// implementations this replaced used requestAnimationFrame alone for that flip —
// and rAF is deferred INDEFINITELY while the document is hidden, whereas the
// removal timer is a setTimeout and keeps counting. So an error raised on a
// backgrounded tab was removed having never been shown. Nothing throws; the user
// switches back to a tab that looks like nothing happened. The 50ms timer is the
// backstop for exactly that, and the first test below is that scenario.
//
// The second property is that the message is text. Toast copy includes server
// error strings, so an innerHTML assignment here is a live injection sink.
//
// Time is virtual (a manual queue), because the 4200ms/320ms lifecycle is the point
// and cannot be waited out. rAF is controlled separately from the timers — that
// separation IS the bug above.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { showToast, showErrorToast } from '../../public/scripts/toast.js';

// ── shim ───────────────────────────────────────────────────────────────────────

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.textContent = '';
    this.className = '';
    this.classes = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => this.classes.add(x)),
      remove: (...n) => n.forEach((x) => this.classes.delete(x)),
      contains: (n) => this.classes.has(n),
    };
  }

  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
}

const REAL = {
  document: globalThis.document,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  setTimeout: globalThis.setTimeout,
};
afterEach(() => { Object.assign(globalThis, REAL); });

/** @param {{ existingHost?: FakeEl | null }} [opts] */
function shim({ existingHost = null } = {}) {
  const body = new FakeEl('body');
  const byId = new Map();
  if (existingHost) { existingHost.id = 'toast-host'; byId.set('toast-host', existingHost); body.appendChild(existingHost); }

  globalThis.document = {
    body,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      const e = new FakeEl(tag);
      // A real appendChild of an element with an id makes it findable; the module
      // relies on that to reuse the host it created a moment ago.
      const originalAppend = body.appendChild.bind(body);
      body.appendChild = (c) => { if (c.id) byId.set(c.id, c); return originalAppend(c); };
      return e;
    },
  };

  /** @type {Array<{ at: number, fn: () => void }>} */
  let timers = [];
  let now = 0;
  globalThis.setTimeout = (fn, ms) => { timers.push({ at: now + (ms || 0), fn }); return timers.length; };

  /** @type {Array<() => void>} */
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

  return {
    body,
    host: () => body.children.find((c) => c.id === 'toast-host') || null,
    toasts: () => (body.children.find((c) => c.id === 'toast-host')?.children) || [],
    /** Run the frame callbacks the browser has been withholding. */
    paintFrame: () => { const q = frames.splice(0); q.forEach((fn) => fn()); },
    pendingFrames: () => frames.length,
    /** Advance virtual time, running whatever comes due (including nested timers). */
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        const next = due[0];
        timers = timers.filter((t) => t !== next);
        now = next.at;
        next.fn();
      }
      now = target;
    },
  };
}

const shown = (t) => t.classList.contains('toast--show');

// ── the shipped bug ────────────────────────────────────────────────────────────

test('a toast raised on a BACKGROUNDED tab still becomes visible', () => {
  // rAF never runs here — that is what a hidden document does. The message must
  // still be revealed before the removal timer takes it away.
  const s = shim();
  showToast('Your daily limit is reached.');
  const toast = s.toasts()[0];
  assert.equal(shown(toast), false, 'inserted invisible, so the transition can run');

  s.advance(60);
  assert.equal(s.pendingFrames(), 1, 'the frame is still owed — the tab never painted');
  assert.equal(shown(toast), true, 'the message must not sit invisible until it is removed');
});

test('the backstop and the frame do not double up, in either order', () => {
  // Both paths flip the same class; whichever runs second must be a no-op, and in
  // particular must not re-show a toast that has already faded out.
  const frameFirst = shim();
  showToast('a');
  frameFirst.paintFrame();
  frameFirst.advance(60);
  assert.equal(shown(frameFirst.toasts()[0]), true);

  const timerFirst = shim();
  showToast('b');
  timerFirst.advance(60);
  timerFirst.paintFrame();
  assert.equal(shown(timerFirst.toasts()[0]), true);

  // And a very late frame, arriving after the toast has been dismissed.
  const late = shim();
  showToast('c');
  late.advance(60);
  const toast = late.toasts()[0];
  late.advance(4200);
  assert.equal(shown(toast), false, 'faded out');
  late.paintFrame();
  assert.equal(shown(toast), false, 'a stale frame must not resurrect it');
});

// ── lifecycle ──────────────────────────────────────────────────────────────────

test('a toast fades out and is then removed from the DOM', () => {
  const s = shim();
  showToast('done');
  s.paintFrame();
  const toast = s.toasts()[0];

  s.advance(4000);
  assert.equal(shown(toast), true, 'still up well before the 4200ms mark');
  assert.equal(s.toasts().length, 1);

  s.advance(300); // past 4200: fade starts
  assert.equal(shown(toast), false);
  assert.equal(s.toasts().length, 1, 'still in the DOM while the CSS transition runs');

  s.advance(400); // past the 320ms fade
  assert.equal(s.toasts().length, 0, 'a toast left in the DOM stacks up over a session');
});

test('several toasts coexist rather than replacing one another', () => {
  const s = shim();
  showToast('first');
  showToast('second');
  s.paintFrame();
  assert.deepEqual(s.toasts().map((t) => t.textContent), ['first', 'second']);
});

// ── the message is text ────────────────────────────────────────────────────────

test('the message is set as text, never parsed as markup', () => {
  // Toast copy includes server-supplied error strings.
  const s = shim();
  showToast('<img src=x onerror="alert(1)">');
  const toast = s.toasts()[0];
  assert.equal(toast.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(toast.innerHTML, undefined, 'nothing may be assigned to innerHTML');
  assert.equal(toast.children.length, 0, 'and no elements parsed out of it');
});

// ── announcement ───────────────────────────────────────────────────────────────

test('errors interrupt a screen reader; ordinary toasts do not', () => {
  // The deliberate split: the host is aria-live="polite" so a routine toast
  // accompanying a visible change does not cut the reader off mid-sentence, while
  // an error carries role="alert" and does.
  const s = shim();
  showErrorToast('Upload failed');
  showToast('Saved', 'success');
  s.paintFrame();

  assert.equal(s.host().getAttribute('aria-live'), 'polite');
  assert.equal(s.host().getAttribute('aria-atomic'), 'false');
  assert.equal(s.toasts()[0].getAttribute('role'), 'alert');
  assert.equal(s.toasts()[1].getAttribute('role'), 'status');
});

test('the type reaches the class name, so error and success look different', () => {
  const s = shim();
  showErrorToast('boom');
  showToast('yay', 'success');
  showToast('plain');
  assert.deepEqual(s.toasts().map((t) => t.className), ['toast toast--error', 'toast toast--success', 'toast']);
});

test('showErrorToast is showToast with the error treatment', () => {
  const s = shim();
  showErrorToast('boom');
  assert.equal(s.toasts()[0].className, 'toast toast--error');
  assert.equal(s.toasts()[0].getAttribute('role'), 'alert');
});

// ── the host ───────────────────────────────────────────────────────────────────

test('the host is created once and shared, so a page needs no markup for it', () => {
  const s = shim();
  showToast('a');
  showToast('b');
  assert.equal(s.body.children.filter((c) => c.id === 'toast-host').length, 1);
  assert.equal(s.toasts().length, 2);
});

test("a page that ships its own #toast-host is reused, not duplicated", () => {
  // masking-studio.html has a static one, positioned by that page's own CSS.
  const existing = new FakeEl('div');
  const s = shim({ existingHost: existing });
  showToast('a');
  assert.equal(s.body.children.length, 1, 'a second host would be positioned wrong');
  assert.equal(existing.children.length, 1);
  assert.equal(existing.getAttribute('aria-live'), null, "the page's own markup is left as authored");
});
