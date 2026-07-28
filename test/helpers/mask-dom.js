// Minimal DOM stand-in for unit-testing the mask-editor behaviour slices
// (viewport pinning, processing overlay, reference photo).
//
// The repo has no jsdom and deliberately doesn't want one — the house style is a
// hand-rolled shim per surface (see test/frontend/masking-studio/mask-core.test.js,
// which shims `document` for @napi-rs/canvas). This is the same idea, sized to
// exactly what those three slices touch: classList, style, a couple of lookups,
// appendChild, getComputedStyle, matchMedia and visualViewport.
//
// It is NOT a browser. It models structure and attributes, not layout or CSS
// cascade, so it can prove "the module set top/left/width/height from the visual
// viewport" but never "the dialog actually fits". Anything about real geometry
// belongs in e2e (see e2e/stage-mask-*.spec.js).
import { createCanvas } from '@napi-rs/canvas';

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); this.sync(); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); this.sync(); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this.set.has(n) : !!force;
    if (on) this.set.add(n); else this.set.delete(n);
    this.sync();
    return on;
  }
  sync() { this.el._className = [...this.set].join(' '); }
}

let idSeq = 0;

export class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parent = null;
    // A real CSSStyleDeclaration reports '' for a property that was never set,
    // and the slices rely on that: clearing the mobile pin assigns '' and tests
    // compare against it. A bare object would report undefined and make "never
    // set" look different from "explicitly cleared".
    this.style = new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.dataset = {};
    this.attrs = {};
    this.listeners = new Map();
    this.textContent = '';
    this.disabled = false;
    this._className = '';
    this._uid = ++idSeq;
    this.classList = new ClassList(this);
  }

  get className() { return this._className; }
  set className(v) {
    this._className = String(v || '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  insertBefore(child, ref) {
    child.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = undefined; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }
  /** Fire every listener registered for `type`. Returns how many ran. */
  emit(type, event = {}) {
    const list = [...(this.listeners.get(type) || [])];
    list.forEach((fn) => fn(event));
    return list.length;
  }
  click() { this.emit('click', {}); }

  /** Depth-first descendants including self. */
  walk() {
    return [this, ...this.children.flatMap((c) => c.walk())];
  }
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { return this.walk().slice(1).find((el) => el.matches(sel)) || null; }
  querySelectorAll(sel) { return this.walk().slice(1).filter((el) => el.matches(sel)); }
}

/**
 * Install a fake document/window on globalThis and return handles plus a
 * restore(). Canvases come from @napi-rs/canvas so the reference-photo downscale
 * does real pixel work rather than being mocked away.
 */
export function installMaskDom({ mobile = false, visualViewport = null } = {}) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
    Image: globalThis.Image,
    FileReader: globalThis.FileReader,
  };

  const head = new FakeEl('head');
  const body = new FakeEl('body');
  const byId = new Map();

  const doc = {
    head,
    body,
    createElement(tag) {
      if (tag === 'canvas') {
        const c = createCanvas(1, 1);
        // The slices only ever set width/height then draw + toDataURL.
        return c;
      }
      return new FakeEl(tag);
    },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(sel) { return body.querySelector(sel) || head.querySelector(sel); },
    /** Register an element under an id so getElementById can find it. */
    _register(el, id) { el.id = id; byId.set(id, el); return el; },
  };

  const listeners = new Map();
  const win = {
    matchMedia: (q) => ({ matches: mobile && /max-width/.test(q), media: q }),
    visualViewport,
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener: (t, fn) => {
      const l = listeners.get(t) || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
    },
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.getComputedStyle = (el) => ({ position: (el.style && el.style.position) || 'static' });

  return {
    doc,
    win,
    head,
    body,
    /** Make an element, register its id, and attach it under body. */
    el(tag, id, className) {
      const e = new FakeEl(tag);
      if (className) e.className = className;
      if (id) doc._register(e, id);
      body.appendChild(e);
      return e;
    },
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.getComputedStyle = saved.getComputedStyle;
      globalThis.Image = saved.Image;
      globalThis.FileReader = saved.FileReader;
    },
  };
}

/**
 * Fake FileReader + Image pair for the reference-photo path, sized to `width` x
 * `height` so a test can drive the downscale branch without encoding a real JPEG.
 *
 * The fake Image is a real @napi-rs/canvas Canvas rather than a plain object:
 * the code under test passes it straight to ctx.drawImage(), which the native
 * canvas rejects for anything it doesn't recognise. A Canvas is drawable and
 * already carries width/height, so the downscale does genuine pixel work — the
 * output dimensions the tests assert are the ones actually rasterised. (A napi
 * Image would work too, but only accepts a Buffer for src, never the data URL
 * string the code assigns.)
 */
export function installFileStack({ width, height, failRead = false, failDecode = false }) {
  globalThis.FileReader = class {
    readAsDataURL() {
      queueMicrotask(() => {
        if (failRead) { if (this.onerror) this.onerror(); return; }
        this.result = 'data:image/png;base64,AAAA';
        if (this.onload) this.onload();
      });
    }
  };
  globalThis.Image = function FakeImage() {
    const c = createCanvas(width, height);
    // Paint something non-uniform so a downscale that silently produced an empty
    // canvas would still be distinguishable from a real one.
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#c33'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#3c3'; ctx.fillRect(0, 0, Math.max(1, width >> 1), Math.max(1, height >> 1));
    Object.defineProperty(c, 'src', {
      configurable: true,
      set() {
        queueMicrotask(() => {
          if (failDecode) { if (c.onerror) c.onerror(); return; }
          if (c.onload) c.onload();
        });
      },
    });
    return c;
  };
}

/** A File-shaped object; the slices only read `type` and `size`. */
export function fakeFile({ type = 'image/png', size = 1000 } = {}) {
  return { type, size, name: 'ref.png' };
}
