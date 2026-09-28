// Tier: frontend behaviour + cross-file drift guard — public/scripts/home/faq-more.js and
// the three files that have to agree with it.
//
// Below 1001px the homepage FAQ opens on three questions instead of nine. That is one
// behaviour spread over four files: index.html marks the three with `data-featured` and
// carries the button, home.css hides the other six until `.faq-plan` is `.is-expanded`,
// the language packs carry both button labels, and this module owns the class. Any one
// of them alone is a bug — markup with no CSS shows nine, CSS with no module hides six
// with no way back, and a missing key ships an English button under a `ja` hreflang.
//
// THE SIX ARE HIDDEN, NOT REMOVED, which is the part worth pinning: #faq-jsonld still
// describes nine questions, `#faq-privacy` still resolves, and plan mode above 1001px
// still lays out nine rooms. So the tests below check both halves — that the collapsed
// list is three, and that nothing anywhere else lost a room.
//
// No jsdom, per the house style: the shim underneath implements exactly the DOM this
// module touches, so a call it does not support is a test that fails loudly rather than
// a green run against a fiction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initFaqMore } from '../../public/scripts/home/faq-more.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const HOME_CSS = fs.readFileSync(path.join(PUBLIC, 'styles', 'home.css'), 'utf8');

/** The rooms index.html shows before the visitor asks for the rest. */
const FEATURED = ['turnaround', 'pricing', 'disclosure'];

/* --------------------------------------------------------------------------
   A DOM the size of this module, and no larger
   -------------------------------------------------------------------------- */

function makeEl(tag, classes = [], attrs = {}) {
  const set = new Set(classes);
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    listeners: new Map(),
    attrs: { ...attrs },
    open: false,
    classList: {
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => {
        const want = on === undefined ? !set.has(c) : Boolean(on);
        if (want) set.add(c); else set.delete(c);
        return want;
      },
    },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name); },
    addEventListener(type, fn) {
      if (!node.listeners.has(type)) node.listeners.set(type, []);
      node.listeners.get(type).push(fn);
    },
    /** Fire every listener of `type` on THIS node with a synthetic event. */
    fire(type, event = {}) {
      for (const fn of node.listeners.get(type) || []) fn({ target: node, ...event });
    },
    /** The two selector shapes faq-more.js uses, and nothing else. */
    querySelector(sel) {
      const byClass = /^\.([\w-]+)$/.exec(sel);
      const byId = /^\[id="(.*)"\]$/.exec(sel);
      const match = (n) => {
        if (byClass) return n.classList.contains(byClass[1]);
        if (byId) return n.getAttribute('id') === byId[1].replace(/\\(.)/g, '$1');
        throw new Error(`the shim does not implement the selector ${sel}`);
      };
      const walk = (n) => {
        for (const child of n.children) {
          if (match(child)) return child;
          const deep = walk(child);
          if (deep) return deep;
        }
        return null;
      };
      return walk(node);
    },
  };
  return node;
}

/** The homepage FAQ, reduced to what this module reaches for. */
function makeFaq(hash = '') {
  const doc = makeEl('div');
  const plan = makeEl('div', ['faq-plan']);
  const sheet = makeEl('div', ['faq-plan__sheet', 'faq-accordion'], { id: 'faq-rooms' });
  const rooms = new Map();
  for (const room of ['basics', 'turnaround', 'pricing', 'studios', 'control', 'photos', 'disclosure', 'privacy', 'whystagify']) {
    const attrs = { id: `faq-${room}` };
    if (FEATURED.includes(room)) attrs['data-featured'] = '';
    const el = makeEl('details', ['faq-q', 'faq-room'], attrs);
    sheet.children.push(el);
    rooms.set(room, el);
  }
  const btn = makeEl('button', ['faq-more'], { 'aria-expanded': 'false' });
  plan.children.push(sheet, btn);
  doc.children.push(plan);

  const view = {
    location: { hash },
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!view.listeners.has(type)) view.listeners.set(type, []);
      view.listeners.get(type).push(fn);
    },
    fire(type) { for (const fn of view.listeners.get(type) || []) fn({}); },
  };
  doc.defaultView = view;

  return { doc, plan, btn, rooms, view };
}

const expanded = (plan, btn) => {
  const cls = plan.classList.contains('is-expanded');
  assert.equal(btn.getAttribute('aria-expanded'), String(cls),
    'aria-expanded and .is-expanded disagree, so the button lies to a screen reader');
  return cls;
};

/* --------------------------------------------------------------------------
   Behaviour
   -------------------------------------------------------------------------- */

test('the list starts collapsed and the button expands and collapses it', () => {
  const { doc, plan, btn } = makeFaq();
  initFaqMore(doc);

  assert.equal(expanded(plan, btn), false, 'the list must not start expanded');
  btn.fire('click');
  assert.equal(expanded(plan, btn), true);
  btn.fire('click');
  assert.equal(expanded(plan, btn), false, 'the button has to work in both directions');
});

test('opening one of the six hidden rooms expands the list around it', () => {
  const { doc, plan, btn, rooms } = makeFaq();
  initFaqMore(doc);

  const privacy = rooms.get('privacy');
  privacy.open = true;
  plan.fire('toggle', { target: privacy });
  assert.equal(expanded(plan, btn), true,
    'a room opened by a deep link would otherwise open inside display:none');
});

test('the three featured rooms open without expanding anything', () => {
  const { doc, plan, btn, rooms } = makeFaq();
  initFaqMore(doc);

  for (const room of FEATURED) {
    const el = rooms.get(room);
    el.open = true;
    plan.fire('toggle', { target: el });
  }
  assert.equal(expanded(plan, btn), false,
    'the visible three are already visible — opening one must not unfold the rest');
});

test('closing a room never expands the list', () => {
  const { doc, plan, btn, rooms } = makeFaq();
  initFaqMore(doc);

  const privacy = rooms.get('privacy');
  privacy.open = false;
  plan.fire('toggle', { target: privacy });
  assert.equal(expanded(plan, btn), false, 'a close event is not a request to expand');
});

test('a fragment naming a hidden room expands the list before the visitor sees it', () => {
  const { doc, plan, btn } = makeFaq('#faq-photos');
  initFaqMore(doc);
  assert.equal(expanded(plan, btn), true);
});

test('a fragment naming a featured room, or nothing at all, leaves it collapsed', () => {
  for (const hash of ['', '#faq-pricing', '#pricing-section']) {
    const { doc, plan, btn } = makeFaq(hash);
    initFaqMore(doc);
    assert.equal(expanded(plan, btn), false, `hash ${hash || '(none)'} should not expand`);
  }
});

test('a later hashchange into a hidden room expands it too', () => {
  const { doc, plan, btn, view } = makeFaq();
  initFaqMore(doc);
  assert.equal(expanded(plan, btn), false);

  view.location.hash = '#faq-whystagify';
  view.fire('hashchange');
  assert.equal(expanded(plan, btn), true);
});

test('a page without the FAQ is left alone', () => {
  const doc = makeEl('div');
  assert.doesNotThrow(() => initFaqMore(doc), 'every other page imports nothing and must not throw');
});

/* --------------------------------------------------------------------------
   The three other files that have to agree
   -------------------------------------------------------------------------- */

test('index.html features exactly three rooms, and still ships all nine', () => {
  const details = INDEX.match(/<details class="faq-q faq-room"[^>]*>/g) || [];
  assert.equal(details.length, 9, 'the FAQ must still carry nine rooms');

  const featured = details.filter((tag) => tag.includes('data-featured'));
  assert.equal(featured.length, 3, 'three is the point — a fourth is another 50px of phone scroll');
  for (const room of FEATURED) {
    assert.ok(featured.some((tag) => tag.includes(`data-room="${room}"`)),
      `${room} is one of the three questions that answer an objection, and must be featured`);
  }

  // The nine are hidden, never removed, so everything keyed to the full set is intact.
  for (const room of ['basics', 'turnaround', 'pricing', 'studios', 'control', 'photos', 'disclosure', 'privacy', 'whystagify']) {
    assert.ok(INDEX.includes(`https://stagify.ai/#faq-${room}`),
      `#faq-jsonld lost ${room} — the schema and the markup have to describe the same nine`);
  }
});

test('the button is wired to the sheet, labelled in both states, and loaded early', () => {
  const btn = /<button class="faq-more"[\s\S]*?<\/button>/.exec(INDEX);
  assert.ok(btn, 'index.html has no show-all control, so the six rooms are unreachable on a phone');
  const html = btn[0];

  assert.match(html, /aria-expanded="false"/, 'the collapsed state has to be announced');
  assert.match(html, /aria-controls="faq-rooms"/);
  assert.ok(INDEX.includes('class="faq-plan__sheet faq-accordion" id="faq-rooms"'),
    'aria-controls points at an id the sheet does not have');

  assert.match(html, /data-lang="faq\.more\.show"/);
  assert.match(html, /data-lang="faq\.more\.hide"/);

  assert.ok(INDEX.includes('<script type="module" src="scripts/home/faq-more.js"></script>'),
    'the toggle must ship with the head modules, not after load where a tap is swallowed');
  assert.ok(!INDEX.includes('scripts/home/faq-more.js" defer'),
    'a module is already deferred; a second attribute means it was copied from a classic tag');
});

test('home.css hides the six below 1001px and restores them for print', () => {
  const css = HOME_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = /@media \(max-width: 1000px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(mobile, 'no mobile block, so the phone still renders nine full-size cards');

  assert.match(mobile[1], /\.faq-plan:not\(\.is-expanded\) \.faq-q:not\(\[data-featured\]\) \{\s*display: none;/,
    'the six are not hidden, so the section saves nothing');
  assert.match(mobile[1], /\.faq-more \{[\s\S]*?display: flex;/,
    'the button is display:none outside this block — it has to be shown inside it');

  // Without this the three sit 2nd, 3rd and 7th of nine, so expanding inserts rooms
  // ABOVE and BETWEEN them and every question the visitor was reading moves.
  assert.match(mobile[1], /\.faq-plan \.faq-q\[data-featured\] \{\s*order: -1;/,
    'the three are not pinned to the top, so expanding reshuffles the visible list');
  assert.ok(!/\.faq-plan[^{]*\.faq-q \+ \.faq-q/.test(css),
    'a sibling border is drawn between DOM neighbours, which `order` has just stopped being');

  // 1001px is where faq-plan.css turns the sheet back into a drawing. One pixel of
  // overlap and a 1000px tablet gets a floor plan with a Show-all button under it.
  assert.ok(!/@media \(max-width: 100[1-9]px\)/.test(css),
    'the mobile FAQ block must stop below the 1001px plan gate');

  const print = /@media print \{([\s\S]*?)\n\}/g;
  const blocks = [...css.matchAll(print)].map((m) => m[1]);
  assert.ok(blocks.some((b) => /\.faq-plan:not\(\.is-expanded\) \.faq-q:not\(\[data-featured\]\) \{\s*display: block;/.test(b)),
    'a sheet of paper is about 816px wide, so print matches the mobile block and would print three questions');
  assert.ok(blocks.some((b) => /\.faq-more \{\s*display: none;/.test(b)),
    'a control nobody can press must not print');
});

test('both button labels exist in all eleven language packs', () => {
  const dir = path.join(PUBLIC, 'languages');
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(packs.length, 11, 'the language set changed — this sweep counts on all of them');

  for (const pack of packs) {
    const faq = JSON.parse(fs.readFileSync(path.join(dir, pack), 'utf8')).faq;
    assert.ok(faq && faq.more, `${pack} has no faq.more, so the button ships in English`);
    for (const key of ['show', 'hide']) {
      assert.equal(typeof faq.more[key], 'string', `${pack}: faq.more.${key} is missing`);
      assert.ok(faq.more[key].trim().length > 0, `${pack}: faq.more.${key} is empty`);
    }
    assert.notEqual(faq.more.show, faq.more.hide,
      `${pack}: both states say the same thing, so the button never appears to change`);
  }
});
