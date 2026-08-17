// A no-jsdom document shim for the Compare-plans row tooltips
// (public/scripts/stagify-plus-tips.js).
//
// Split out from plus-page-dom.js rather than bolted onto it: that helper hands
// stagify-plus.js four elements looked up by id, and this one needs a querySelectorAll,
// a createElement, a document.body and a requestAnimationFrame. Sharing one mount would
// have meant every checkout test carrying the tooltip machinery around.
//
// The rows are PARSED OUT of the real public/stagify-plus.html, the same trick
// guides-dom.js uses: the thing under test is the relationship between a button's
// aria-describedby and the span that holds the copy, so a fixture that restated that
// pairing itself would keep passing after the markup stopped matching.
//
// Geometry is data. Every rect the module measures — each trigger, and the bubble it
// positions — is a plain object a test can set, so "flips below near the top of the
// viewport" and "clamps at the right edge" are assertions about arithmetic rather than
// about a layout engine that is not present.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'public', 'stagify-plus.html');

/**
 * Every tooltip trigger in the shipped page, in document order.
 * @returns {Array<{ describes: string, tipId: string, text: string, label: string }>}
 */
export function pageTips() {
  const html = fs.readFileSync(PAGE, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const headers = [...html.matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  assert.ok(headers.length >= 12, `expected the compare rows in stagify-plus.html, found ${headers.length}`);

  return headers.map((header) => {
    const describes = /<button[^>]*class="sp-tip-btn"[^>]*aria-describedby="([^"]+)"/.exec(header);
    const tip = /<span class="sp-tip-text" id="([^"]+)"[^>]*>([^<]+)</.exec(header);
    const label = /<span class="sp-row-label"[^>]*>([^<]+)</.exec(header);
    assert.ok(describes && tip && label, `a compare row is missing its label, button or tip span: ${header}`);
    return { describes: describes[1], tipId: tip[1], text: tip[2].trim(), label: label[1].trim() };
  });
}

class FakeEl {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    /** @type {Record<string, string>} */
    this.attrs = {};
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    /** Whatever getBoundingClientRect should report. Tests write to this directly. */
    this.rect = { top: 400, left: 300, width: 17, height: 17, bottom: 417, right: 317 };
    const props = /** @type {Record<string, string>} */ ({});
    this.style = {
      props,
      /** @param {string} k @param {string} v */
      setProperty: (k, v) => { props[k] = v; },
      get left() { return props.left ?? ''; },
      set left(v) { props.left = v; },
      get top() { return props.top ?? ''; },
      set top(v) { props.top = v; },
    };
    const classes = new Set();
    this.classes = classes;
    this.classList = {
      add: (/** @type {string} */ c) => classes.add(c),
      remove: (/** @type {string} */ c) => classes.delete(c),
      contains: (/** @type {string} */ c) => classes.has(c),
      /** @param {string} c @param {boolean} [on] */
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    };
  }

  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, bottom: r.bottom ?? r.top + r.height, right: r.right ?? r.left + r.width };
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) { this.attrs[name] = String(value); }
  /** @param {string} name */
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  /** Node.contains — the outside-click check calls it. @param {any} other */
  contains(other) { return other === this; }

  /**
   * Fire every listener for `type`.
   * @param {string} type
   * @param {Record<string, any>} [event]
   */
  fire(type, event = {}) {
    const e = { type, target: this, preventDefault() { e.defaultPrevented = true; }, defaultPrevented: false, ...event };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
}

/**
 * Install `document` / `window` / `requestAnimationFrame` carrying the page's triggers.
 *
 * Call BEFORE importing the module: it wires everything up at import time.
 * @param {{ innerWidth?: number, popWidth?: number, popHeight?: number }} [opts]
 */
export function mountPlusTips({ innerWidth = 1200, popWidth = 280, popHeight = 96 } = {}) {
  const tips = pageTips();
  /** @type {Map<string, FakeEl>} */
  const byId = new Map();
  /** @type {FakeEl[]} */
  const buttons = [];
  /** @type {Record<string, Function[]>} */
  const docListeners = {};
  /** @type {Record<string, Function[]>} */
  const winListeners = {};
  /** @type {FakeEl[]} */
  const appended = [];
  /** @type {Function[]} */
  const frames = [];

  for (const tip of tips) {
    const span = new FakeEl('span');
    span.id = tip.tipId;
    span.className = 'sp-tip-text';
    span.textContent = tip.text;
    byId.set(tip.tipId, span);

    const btn = new FakeEl('button');
    btn.className = 'sp-tip-btn';
    btn.setAttribute('aria-describedby', tip.describes);
    buttons.push(btn);
  }

  globalThis.document = /** @type {any} */ ({
    readyState: 'complete',
    getElementById: (/** @type {string} */ id) => byId.get(id) ?? null,
    querySelectorAll: (/** @type {string} */ sel) => {
      assert.equal(sel, '.sp-tip-btn', `the shim only knows .sp-tip-btn, got ${sel}`);
      return buttons;
    },
    createElement: (/** @type {string} */ tag) => {
      const el = new FakeEl(tag);
      el.rect = { top: 0, left: 0, width: popWidth, height: popHeight, bottom: popHeight, right: popWidth };
      return el;
    },
    body: { appendChild: (/** @type {FakeEl} */ el) => { appended.push(el); return el; } },
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { (docListeners[type] ||= []).push(fn); },
  });

  globalThis.window = /** @type {any} */ ({
    innerWidth,
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { (winListeners[type] ||= []).push(fn); },
  });

  globalThis.requestAnimationFrame = /** @type {any} */ ((/** @type {Function} */ fn) => {
    frames.push(fn);
    return frames.length;
  });

  return {
    tips,
    buttons,
    /** The row whose label contains `text`, with its trigger and source span. */
    row(/** @type {string} */ text) {
      const i = tips.findIndex((t) => t.label.includes(text));
      assert.notEqual(i, -1, `no compare row labelled like "${text}"`);
      return { ...tips[i], button: buttons[i], source: /** @type {FakeEl} */ (byId.get(tips[i].tipId)) };
    },
    /** The portal bubble, once the module has created it. */
    pop: () => appended[0] ?? null,
    isOpen: () => !!appended[0]?.classList.contains('sp-tip-pop--open'),
    /** Fire a document-level listener (keydown, scroll, pointerdown). */
    fireDocument(/** @type {string} */ type, /** @type {Record<string, any>} */ event = {}) {
      for (const fn of docListeners[type] ?? []) fn({ type, target: null, ...event });
    },
    /** Fire a window-level listener (resize). */
    fireWindow(/** @type {string} */ type, /** @type {Record<string, any>} */ event = {}) {
      for (const fn of winListeners[type] ?? []) fn({ type, ...event });
    },
    /** Run the frames the module queued, the way a real rAF tick would. */
    flushFrames() {
      const queued = frames.splice(0, frames.length);
      for (const fn of queued) fn();
      return queued.length;
    },
    docListeners,
    winListeners,
  };
}
