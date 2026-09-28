// Tier: unit — the immersive ("rotate to landscape") view.
//
// This is the module that moves a live DOM node out of the page and puts it back, and
// that pins <body> while it is away. Both halves are unforgiving: a failed restore
// leaves the media in an overlay that is gone, and a failed unlock leaves the whole
// page stuck at `position: fixed` with no way to scroll. So the assertions here are
// mostly about the UNDO, not the DO.
//
// There is no jsdom in this repo (see test/helpers/guides-dom.js), so the document and
// window are hand-rolled below. That is not a limitation worth working around: the
// module takes `doc` and `win` as injected dependencies precisely so it can be driven
// this way, and a fake makes it possible to assert that every listener it registered
// was removed — something a real DOM will not tell you.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHONE_QUERY,
  PORTRAIT_QUERY,
  anyImmersiveOpen,
  createImmersive,
  isPhone,
  setLabel,
  wantsRotation,
} from '../../public/scripts/shared/immersive-view.js';

// ── the fake DOM ─────────────────────────────────────────────────────────────

/** Every (node, type) pair currently listening, so a leak is visible. */
function makeBus() {
  const live = new Map();
  const key = (node, type, fn) => `${node.__name || 'node'}:${type}:${fn.__id}`;
  let nextId = 0;
  return {
    live,
    add(node, type, fn) {
      if (fn.__id === undefined) fn.__id = (nextId += 1);
      live.set(key(node, type, fn), { node, type, fn });
    },
    remove(node, type, fn) {
      live.delete(key(node, type, fn));
    },
    /** Fire every listener registered for `type` on `node`. */
    fire(node, type, event = {}) {
      for (const e of [...live.values()]) {
        if (e.node === node && e.type === type) e.fn(event);
      }
    },
  };
}

class El {
  constructor(tag = 'div', bus) {
    this.tagName = String(tag).toUpperCase();
    this.bus = bus;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.inert = false;
    this.rect = { width: 640, height: 360, top: 0, left: 0, bottom: 360, right: 640 };
    this.focused = 0;
    const set = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => set.add(x)),
      remove: (...n) => n.forEach((x) => set.delete(x)),
      contains: (n) => set.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !set.has(n) : !!force;
        if (on) set.add(n); else set.delete(n);
        return on;
      },
    };
    // `className = 'imv'` and `classList.add('imv')` are the same thing in a real DOM,
    // and the module uses both — so the fake has to keep them in step or a lookup by
    // class silently misses everything the module named the other way.
    Object.defineProperty(this, 'className', {
      get: () => [...set].join(' '),
      set: (v) => {
        set.clear();
        String(v).split(/\s+/).filter(Boolean).forEach((x) => set.add(x));
      },
    });
    this.props = {};
    this.style = {
      setProperty: (k, v) => { this.props[k] = v; },
      removeProperty: (k) => { delete this.props[k]; },
    };
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
  addEventListener(t, fn) { this.bus.add(this, t, fn); }
  removeEventListener(t, fn) { this.bus.remove(this, t, fn); }
  getBoundingClientRect() { return this.rect; }
  focus() { this.focused += 1; }
}

/**
 * A page with one media element sitting between two siblings, so a restore that puts
 * it back in the WRONG place is detectable rather than merely "back under body".
 *
 * @param {{ portrait?: boolean, phone?: boolean, fullscreenEnabled?: boolean }} [opts]
 */
function makePage({ portrait = true, phone = true, fullscreenEnabled = false } = {}) {
  const bus = makeBus();
  const el = (tag, name) => { const n = new El(tag, bus); n.__name = name; return n; };

  const body = el('body', 'body');
  const before = el('div', 'before');
  const host = el('div', 'host');
  const after = el('div', 'after');
  const target = el('div', 'target');
  const button = el('button', 'button');
  body.appendChild(before);
  body.appendChild(host);
  body.appendChild(after);
  host.appendChild(target);
  target.appendChild(button);

  const documentElement = el('html', 'html');
  documentElement.style = { ...documentElement.style };

  const mqs = new Map();
  const media = (q) => {
    if (!mqs.has(q)) {
      const m = {
        media: q,
        matches: q === PORTRAIT_QUERY ? portrait : q === PHONE_QUERY ? phone : false,
        addEventListener: (t, fn) => bus.add(m, t, fn),
        removeEventListener: (t, fn) => bus.remove(m, t, fn),
      };
      m.__name = q;
      mqs.set(q, m);
    }
    return mqs.get(q);
  };

  const rafs = [];
  const timers = [];
  const doc = {
    body,
    documentElement,
    fullscreenEnabled,
    fullscreenElement: null,
    createElement: (tag) => el(tag, tag),
    addEventListener: (t, fn) => bus.add(doc, t, fn),
    removeEventListener: (t, fn) => bus.remove(doc, t, fn),
    exitFullscreen: () => Promise.resolve(),
  };
  doc.__name = 'document';
  const win = {
    scrollY: 420,
    innerWidth: 390,
    innerHeight: 844,
    scrolledTo: [],
    matchMedia: media,
    requestAnimationFrame: (fn) => rafs.push(fn),
    setTimeout: (fn) => timers.push(fn),
    scrollTo: (x, y) => { win.scrolledTo.push([x, y]); win.scrollY = y; },
    history: {
      entries: 0,
      pushState() { win.history.entries += 1; },
      back() { win.history.entries -= 1; },
    },
    location: { href: 'https://stagify.ai/' },
    addEventListener: (t, fn) => bus.add(win, t, fn),
    removeEventListener: (t, fn) => bus.remove(win, t, fn),
  };
  win.__name = 'window';

  return {
    bus, doc, win, body, before, host, after, target, button, media,
    /** Drain the deferred work the module schedules, so onChange has actually run. */
    flush() {
      while (rafs.length) rafs.shift()();
      while (timers.length) timers.shift()();
    },
    overlay: () => body.children.find((c) => c.classList.contains('imv')) || null,
  };
}

/** A controller over the fake page, plus a record of every onChange edge. */
function mount(opts) {
  const page = makePage(opts);
  const edges = [];
  const ctrl = createImmersive({
    target: page.target,
    button: page.button,
    doc: page.doc,
    win: page.win,
    onChange: (open) => edges.push(open),
  });
  return { ...page, ctrl, edges };
}

// ── the queries ──────────────────────────────────────────────────────────────

test('the phone query needs BOTH a narrow viewport and a coarse pointer', () => {
  // A narrow desktop window must keep native fullscreen: it can actually do it, and a
  // "rotate your phone" affordance on a laptop is nonsense. Equally, a large tablet
  // with a coarse pointer has the room for the real thing.
  assert.match(PHONE_QUERY, /max-width:\s*900px/);
  assert.match(PHONE_QUERY, /pointer:\s*coarse/);
  assert.match(PHONE_QUERY, /\band\b/, 'both, not either');
  // 900px mirrors FLAT_QUERY in studio-showcase.js and the breakpoint in home.css.
  assert.ok(PHONE_QUERY.includes('900px'));
});

test('isPhone and wantsRotation read the live media queries, not a cached flag', () => {
  const page = makePage({ phone: true, portrait: true });
  assert.equal(isPhone(page.win), true);
  assert.equal(wantsRotation(page.win), true);
  // A tablet gets rotated, a window gets resized, a trackpad gets connected.
  page.media(PHONE_QUERY).matches = false;
  page.media(PORTRAIT_QUERY).matches = false;
  assert.equal(isPhone(page.win), false);
  assert.equal(wantsRotation(page.win), false);
});

// ── open ─────────────────────────────────────────────────────────────────────

test('open portals the target into an overlay on body', () => {
  const p = mount();
  p.ctrl.open();
  const ov = p.overlay();
  assert.ok(ov, 'the overlay is a direct child of body, not of the panel');
  assert.equal(ov.parentNode, p.body);
  const stage = ov.children[0];
  assert.equal(stage.className, 'imv__stage');
  assert.equal(p.target.parentNode, stage, 'the target moved into the stage');
  assert.ok(p.target.classList.contains('is-immersive'));
  assert.equal(ov.getAttribute('role'), 'dialog');
  assert.equal(ov.getAttribute('aria-modal'), 'true');
  assert.equal(anyImmersiveOpen(), true);
  p.ctrl.close();
});

test('the hole the target leaves is frozen at its measured size', () => {
  // Without this the showcase's ResizeObserver sees the panel collapse and shrinks the
  // stage — and the section stays the wrong height for the rest of the session.
  const p = mount();
  p.target.rect = { width: 812, height: 457, top: 0, left: 0, bottom: 457, right: 812 };
  p.ctrl.open();
  const slot = p.host.children[0];
  assert.equal(slot.className, 'imv-slot');
  assert.equal(slot.style.width, '812px');
  assert.equal(slot.style.height, '457px');
  assert.equal(slot.getAttribute('aria-hidden'), 'true');
  p.ctrl.close();
});

test('open rotates while the phone is upright and locks the page behind', () => {
  const p = mount({ portrait: true });
  p.ctrl.open();
  assert.ok(p.overlay().classList.contains('imv--rotated'));
  // staging-studio.js reads this to map a before/after drag onto the right axis.
  assert.equal(p.doc.documentElement.dataset.imvRotate, '90');
  assert.ok(p.doc.documentElement.classList.contains('imv-lock'));
  // `overflow: hidden` alone does not hold on iOS; the fixed body is what does.
  assert.equal(p.doc.body.style.position, 'fixed');
  assert.equal(p.doc.body.style.top, '-420px', 'pinned at the scroll offset it froze');
  p.ctrl.close();
});

test('open does not rotate a phone already held sideways', () => {
  const p = mount({ portrait: false });
  p.ctrl.open();
  assert.equal(p.overlay().classList.contains('imv--rotated'), false);
  assert.equal(p.doc.documentElement.dataset.imvRotate, undefined);
  p.ctrl.close();
});

test('the viewport metrics are published in px, and swap over under rotation', () => {
  // Not 100dvh: dvh is unsupported below iOS 15.4 and lies during the URL-bar
  // collapse, and the duplicated sizing rules need an exact number to compute a
  // ratio against. --imv-box is the stage's OWN height, which rotation swaps.
  const p = mount({ portrait: true });
  p.ctrl.open();
  const ov = p.overlay();
  assert.equal(ov.props['--imv-vw'], '390px');
  assert.equal(ov.props['--imv-vh'], '844px');
  assert.equal(ov.props['--imv-box'], '390px', 'rotated, the box is as tall as the viewport is wide');
  p.ctrl.close();

  const q = mount({ portrait: false });
  q.ctrl.open();
  assert.equal(q.overlay().props['--imv-box'], '844px', 'upright, it is the viewport height');
  q.ctrl.close();
});

test('everything outside the overlay goes inert, and comes back', () => {
  const p = mount();
  p.ctrl.open();
  assert.equal(p.before.inert, true);
  assert.equal(p.after.inert, true);
  assert.equal(p.overlay().inert, false, 'the overlay itself stays reachable');
  p.ctrl.close();
  assert.equal(p.before.inert, false);
  assert.equal(p.after.inert, false);
});

test('open pushes a history entry so the back gesture closes the view', () => {
  const p = mount();
  p.ctrl.open();
  assert.equal(p.win.history.entries, 1);
  p.ctrl.close();
  assert.equal(p.win.history.entries, 0, 'and close unwinds it rather than leaving a dead entry');
});

test('the button becomes a close affordance while the view is open', () => {
  const p = mount();
  p.ctrl.open();
  assert.ok(p.button.classList.contains('is-fs'), 'is-fs is what swaps in the close glyph');
  assert.equal(p.button.getAttribute('aria-pressed'), 'true');
  // Rewriting the KEY, not the label: language-loader.js re-applies data-lang-attr on
  // every subtree insertion, and the portal is one — a hand-set aria-label is stomped.
  assert.equal(p.button.getAttribute('data-lang-attr'), 'home.showcase.fullscreen|aria-label');
  p.ctrl.close();
  assert.equal(p.button.classList.contains('is-fs'), false);
  assert.equal(p.button.getAttribute('aria-pressed'), 'false');
  assert.equal(p.button.getAttribute('data-lang-attr'), 'home.showcase.rotate|aria-label');
});

test('onChange fires on both edges', () => {
  const p = mount();
  p.ctrl.open();
  p.flush();
  assert.ok(p.edges.length >= 1);
  assert.equal(p.edges[0], true);
  p.edges.length = 0;
  p.ctrl.close();
  p.flush();
  assert.ok(p.edges.length >= 1);
  assert.equal(p.edges[0], false);
  // Twice per edge on purpose: iOS reports a stale size on the first frame after an
  // orientation change, and the second pass is what catches it.
  assert.ok(p.edges.length >= 2, 'and a second, delayed pass');
});

// ── close ────────────────────────────────────────────────────────────────────

test('close puts the target back in its exact original position', () => {
  const p = mount();
  const wasAt = p.host.children.indexOf(p.target);
  p.ctrl.open();
  p.ctrl.close();
  assert.equal(p.target.parentNode, p.host, 'back under its own host, not under body');
  assert.equal(p.host.children.indexOf(p.target), wasAt, 'and at the same index');
  assert.equal(p.host.children.some((c) => c.className === 'imv-slot'), false, 'the slot is gone');
  assert.equal(p.target.classList.contains('is-immersive'), false);
  assert.equal(p.overlay(), null, 'and so is the overlay');
  assert.equal(anyImmersiveOpen(), false);
});

test('close releases the scroll lock completely and restores the offset', () => {
  // The single worst failure mode: a body left at position:fixed is an unusable page.
  const p = mount();
  p.ctrl.open();
  p.ctrl.close();
  assert.equal(p.doc.documentElement.classList.contains('imv-lock'), false);
  assert.equal(p.doc.body.style.position, '');
  assert.equal(p.doc.body.style.top, '');
  assert.equal(p.doc.body.style.width, '');
  assert.deepEqual(p.win.scrolledTo, [[0, 420]], 'and puts the reader back where they were');
  assert.equal(p.doc.documentElement.dataset.imvRotate, undefined);
});

test('close removes every listener open added', () => {
  const p = mount();
  const before = p.bus.live.size;
  p.ctrl.open();
  assert.ok(p.bus.live.size > before, 'open registers listeners');
  p.ctrl.close();
  assert.equal(p.bus.live.size, before, 'and close removes all of them');
});

test('open / close / open leaks nothing', () => {
  const p = mount();
  const before = p.bus.live.size;
  for (let i = 0; i < 3; i += 1) {
    p.ctrl.open();
    p.ctrl.close();
  }
  assert.equal(p.bus.live.size, before);
  assert.equal(p.body.children.filter((c) => c.classList.contains('imv')).length, 0);
  assert.equal(p.host.children.length, 1, 'no accumulated slots');
  assert.equal(anyImmersiveOpen(), false);
});

test('a second open while already open is a no-op, and close is idempotent', () => {
  const p = mount();
  p.ctrl.open();
  p.ctrl.open();
  assert.equal(p.body.children.filter((c) => c.classList.contains('imv')).length, 1);
  p.ctrl.close();
  p.ctrl.close();
  assert.equal(anyImmersiveOpen(), false);
  assert.equal(p.target.parentNode, p.host);
});

// ── the exits ────────────────────────────────────────────────────────────────

test('Escape closes the view', () => {
  // There is no native fullscreen here to consume the key, so the module must.
  const p = mount();
  p.ctrl.open();
  p.bus.fire(p.doc, 'keydown', { key: 'a' });
  assert.equal(p.ctrl.isOpen, true, 'and only Escape');
  p.bus.fire(p.doc, 'keydown', { key: 'Escape' });
  assert.equal(p.ctrl.isOpen, false);
});

test('the back gesture closes the view without unwinding twice', () => {
  const p = mount();
  p.ctrl.open();
  assert.equal(p.win.history.entries, 1);
  // popstate means the browser ALREADY popped our entry; calling back() again would
  // take the reader off the page entirely.
  p.bus.fire(p.win, 'popstate', {});
  assert.equal(p.ctrl.isOpen, false);
  assert.equal(p.win.history.entries, 1, 'the entry is not unwound a second time');
});

test('pagehide force-closes, so bfcache cannot restore a locked page', () => {
  const p = mount();
  p.ctrl.open();
  p.bus.fire(p.win, 'pagehide', {});
  assert.equal(p.ctrl.isOpen, false);
  assert.equal(p.doc.body.style.position, '');
});

test('toggle is the button behaviour: the same control gets you back out', () => {
  const p = mount();
  p.ctrl.toggle();
  assert.equal(p.ctrl.isOpen, true);
  p.ctrl.toggle();
  assert.equal(p.ctrl.isOpen, false);
});

// ── turning the phone ────────────────────────────────────────────────────────

test('physically rotating the phone drops the CSS rotation and re-reflows', () => {
  const p = mount({ portrait: true });
  p.ctrl.open();
  p.flush();
  assert.ok(p.overlay().classList.contains('imv--rotated'));
  p.edges.length = 0;

  p.media(PORTRAIT_QUERY).matches = false;
  p.bus.fire(p.media(PORTRAIT_QUERY), 'change', {});
  assert.equal(p.overlay().classList.contains('imv--rotated'), false, 'the device did the turning');
  assert.equal(p.doc.documentElement.dataset.imvRotate, undefined);
  assert.equal(p.overlay().props['--imv-box'], '844px', 'and the box is the viewport height again');
  p.flush();
  assert.ok(p.edges.length >= 1, 'the callout cards are re-placed for the new geometry');

  // Turning back restores it.
  p.media(PORTRAIT_QUERY).matches = true;
  p.bus.fire(p.media(PORTRAIT_QUERY), 'change', {});
  assert.ok(p.overlay().classList.contains('imv--rotated'));
  p.ctrl.close();
});

test('an orientationchange is honoured even without a matchMedia change event', () => {
  // Safari has historically fired one and not the other.
  const p = mount({ portrait: true });
  p.ctrl.open();
  p.media(PORTRAIT_QUERY).matches = false;
  p.bus.fire(p.win, 'orientationchange', {});
  assert.equal(p.overlay().classList.contains('imv--rotated'), false);
  p.ctrl.close();
});

test('a visual-viewport resize re-publishes the metrics', () => {
  // The iOS URL bar collapsing changes the usable height without any other event.
  const p = mount({ portrait: true });
  p.ctrl.open();
  p.win.innerHeight = 900;
  p.bus.fire(p.win, 'resize', {});
  assert.equal(p.overlay().props['--imv-vh'], '900px');
  p.ctrl.close();
});

// ── the label helper ─────────────────────────────────────────────────────────

test('setLabel writes both the binding and a usable value', () => {
  const bus = makeBus();
  const btn = new El('button', bus);
  setLabel(btn, 'home.showcase.rotate', 'Rotate to landscape', {});
  assert.equal(btn.getAttribute('data-lang-attr'), 'home.showcase.rotate|aria-label');
  assert.equal(btn.getAttribute('aria-label'), 'Rotate to landscape', 'English until the packs land');

  setLabel(btn, 'home.showcase.rotate', 'Rotate to landscape', {
    LanguageSystem: { isLoaded: () => true, getText: () => 'Girar a horizontal' },
  });
  assert.equal(btn.getAttribute('aria-label'), 'Girar a horizontal');
});

test('setLabel falls back to English when the pack lookup throws', () => {
  const bus = makeBus();
  const btn = new El('button', bus);
  setLabel(btn, 'home.showcase.rotate', 'Rotate to landscape', {
    LanguageSystem: { isLoaded: () => true, getText() { throw new Error('not loaded'); } },
  });
  assert.equal(btn.getAttribute('aria-label'), 'Rotate to landscape');
});
