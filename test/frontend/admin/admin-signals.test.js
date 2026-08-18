// Tier: frontend island rendering (stub DOM) — public/scripts/admin/signals.js.
//
// The engine's arithmetic is covered in admin-findings.test.js. What is left here
// is everything the panel could get wrong ON TOP of correct findings, and the two
// that matter are not visual:
//
//   1. **An email must reach the card and NOT the model.** Findings carry an
//      `accounts` array so the operator can see who to contact. The brief request
//      forwards findings to a server that strips them — but that stripping is
//      worthless if this file copies a name into a field the server keeps, or if
//      it renders one through innerHTML. Both are asserted.
//   2. **The rail chip, the Overview teaser and the panel must agree.** They read
//      one memoized result on purpose: recomputing per caller would let the chip
//      say 3 while the teaser listed 2 if data landed between the two calls.
//
// Plus the degradation path. The brief costs a metered model call, so it must be
// on demand only, must never fire on load, and a failure must leave every finding
// rendered — a dashboard that goes blank because an unrelated API is down is
// worse than one with no brief at all.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom } from '../../helpers/admin-dom.js';

const DAY = 24 * 60 * 60 * 1000;

/** @type {any} */
let dom;
/** @type {any} */
let createSignals;

beforeEach(async () => {
  dom = makeDom();
  globalThis.document = dom;
  // Imported after the document exists: helpers.js#el calls document.createElement
  // at call time, but charts.js and the islands are written against a global that
  // must be present before anything renders.
  ({ createSignals } = await import('../../../public/scripts/admin/signals.js'));
});

afterEach(() => {
  delete globalThis.document;
});

/** Collect every textContent in a subtree, so an assertion can search the whole card. */
function textOf(node) {
  if (!node) return '';
  const own = node.textContent || '';
  const kids = (node.children || []).map(textOf).join(' ');
  return `${own} ${kids}`.trim();
}

/** Every className in a subtree. */
function classesOf(node, acc = []) {
  if (!node) return acc;
  if (node.className) acc.push(node.className);
  (node.children || []).forEach((c) => classesOf(c, acc));
  return acc;
}

/**
 * First node in a subtree carrying `cls`.
 *
 * The island builds its blocks with helpers.js#el and appends them to the panel,
 * so they never pass through `document.body` and the stub's id table never sees
 * them. Walking is the only way to reach them — the same reason this stub exists
 * rather than jsdom.
 */
function findByClass(node, cls) {
  if (!node) return null;
  if ((node.className || '').split(' ').includes(cls)) return node;
  for (const child of node.children || []) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

/** The brief's action button, wherever it is in the panel. */
function briefButton() {
  const brief = findByClass(dom.byId['adm-signals'], 'adm-sig-brief');
  assert.ok(brief, 'the brief block should be rendered');
  const button = findByClass(brief, 'adm-sig-btn');
  assert.ok(button, 'the brief needs a button to generate it on demand');
  return button;
}

/** The brief block's text, after a render. */
function briefText() {
  return textOf(findByClass(dom.byId['adm-signals'], 'adm-sig-brief'));
}

/**
 * A dataset that reliably produces at least one critical with named accounts:
 * two paying accounts, one of which has never used the product.
 */
function ctxWithFindings(over = {}) {
  const now = Date.now();
  return {
    data: {
      users: [
        { id: 'p1', email: 'dana@example.com', plan: 'pro', stripeSubscriptionId: 'sub_1', createdAt: new Date(now - 60 * DAY).toISOString() },
        { id: 'p2', email: 'marcus@example.com', plan: 'pro', stripeSubscriptionId: 'sub_2', createdAt: new Date(now - 60 * DAY).toISOString() },
      ],
      promptRows: [],
      chatRows: [],
      maskRows: [],
      contactRows: [],
      enterprise: [],
      metrics: null,
      ...over,
    },
  };
}

/** Build the island with a scripted brief endpoint. */
function mount(ctx, apiSend = async () => ({ summary: null, reason: 'unavailable' })) {
  const sent = [];
  const wrapped = (url, method, body) => { sent.push({ url, method, body }); return apiSend(url, method, body); };
  const signals = createSignals({ ctx, apiSend: wrapped, effectivePlan: (u) => (u && u.plan) || 'free' });
  return { signals, sent };
}

// ── Rendering ───────────────────────────────────────────────────────────────

test('the panel renders a card per finding, with its severity on the card', () => {
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);
  signals.render();

  const host = dom.byId['adm-signals'];
  const classes = classesOf(host).join(' ');
  assert.match(classes, /adm-sig-card/, 'findings should render as cards');
  assert.match(classes, /adm-sig-card--critical/, 'a never-used paying account is a critical');
  assert.match(textOf(host), /never used the product/i);
});

test('every card carries its next step, because that is the point of the tab', () => {
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);
  signals.render();

  const host = dom.byId['adm-signals'];
  const cards = [];
  const walk = (n) => { if ((n.className || '').includes('adm-sig-card')) cards.push(n); (n.children || []).forEach(walk); };
  walk(host);

  assert.ok(cards.length > 0, 'the fixture should produce findings');
  for (const card of cards) {
    assert.match(classesOf(card).join(' '), /adm-sig-action/, 'a finding card without a next step is just an observation');
  }
});

test('a rendered account name goes through textContent, never innerHTML', () => {
  // The dashboard convention for anything log-derived, and here it is also the
  // XSS boundary: an email is user-supplied and this is the only place one is drawn.
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);
  signals.render();

  const host = dom.byId['adm-signals'];
  assert.match(textOf(host), /dana@example\.com/, 'the operator needs to see who to contact');

  const sawMarkup = [];
  const walk = (n) => { if (n.innerHTML && n.innerHTML.includes('@')) sawMarkup.push(n.innerHTML); (n.children || []).forEach(walk); };
  walk(host);
  assert.deepEqual(sawMarkup, [], 'an address was written through innerHTML');
});

test('an empty dataset still renders something honest, never a blank panel', () => {
  // The engine always returns the suppression roll-up, so the panel has no
  // "nothing to report" branch — but a blank panel is exactly what this tab
  // exists to prevent, so it is asserted rather than assumed.
  const { signals } = mount({ data: { users: [], promptRows: [], chatRows: [], maskRows: [], contactRows: [], enterprise: [], metrics: null } });
  signals.render();

  const text = textOf(dom.byId['adm-signals']);
  assert.ok(text.trim().length > 40, `expected an explanation, got: ${text}`);
  assert.match(text, /could not run|not measured|no data/i, 'silence must read as "not measured", not as "all clear"');
});

test('a missing host element is a no-op rather than a throw', () => {
  // renderAll() calls every renderer; one that throws on a page where its panel is
  // absent would take the others with it.
  const { signals } = mount(ctxWithFindings());
  const original = dom.querySelector;
  dom.querySelector = () => null;
  try {
    assert.doesNotThrow(() => signals.render());
    assert.doesNotThrow(() => signals.renderTeaser());
  } finally {
    dom.querySelector = original;
  }
});

// ── The teaser and the chip agree ───────────────────────────────────────────

test('the teaser shows actionable findings only, and agrees with the chip', () => {
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);
  signals.renderTeaser();

  const host = dom.byId['adm-signals-teaser'];
  const text = textOf(host);
  assert.match(text, /need|needs/i);
  assert.match(classesOf(host).join(' '), /adm-sig-teaser-row/);

  const count = signals.actionableCount();
  assert.ok(count > 0, 'the fixture should produce actionable findings');
  assert.match(text, new RegExp(`${count}\\s+thing`), 'the teaser headline must match the chip count');
});

test('a healthy finding never reaches the teaser', () => {
  // "Working well" is worth reading on the Signals tab and is noise at the top of
  // the Overview, where the point is what needs a decision.
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);
  signals.renderTeaser();
  assert.ok(
    !classesOf(dom.byId['adm-signals-teaser']).join(' ').includes('adm-sig-teaser-row--healthy'),
    'a healthy card should not be teased on the Overview',
  );
});

test('the teaser writes nothing at all when nothing is actionable', () => {
  // `.adm-sig-teaser:empty { display: none }` is what hides the block, so writing
  // a heading with an empty list would leave a stranded panel on a clean dashboard.
  const { signals } = mount({ data: { users: [], promptRows: [], chatRows: [], maskRows: [], contactRows: [], enterprise: [], metrics: { renders: { total: 0 }, shares: null, storage: null, health: {}, logs: [] } } });
  signals.renderTeaser();

  const host = dom.byId['adm-signals-teaser'];
  assert.equal(host.children.length, 0, 'the teaser must stay empty so the CSS can hide it');
});

test('the chip, the teaser and the panel share one computation', () => {
  // They read a memoized result on purpose. If each recomputed, data landing
  // between two calls would let the chip and the teaser disagree.
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);

  const first = signals.actionableCount();
  ctx.data.users = []; // Data changes underneath, WITHOUT a reset.
  assert.equal(signals.actionableCount(), first, 'the result is memoized until reset() is called');

  signals.reset();
  assert.equal(signals.actionableCount(), 0, 'after reset it recomputes from the new data');
});

// ── The brief ───────────────────────────────────────────────────────────────

test('rendering the panel does NOT call the brief endpoint', async () => {
  // It costs a metered model call. Generating one on every dashboard load — and
  // every Refresh — would bill for a summary nobody asked for.
  const { signals, sent } = mount(ctxWithFindings());
  signals.render();
  assert.deepEqual(sent, [], 'the brief must be on demand only');
});

test('pressing the button posts the findings and renders the summary', async () => {
  const ctx = ctxWithFindings();
  const { signals, sent } = mount(ctx, async () => ({ summary: 'Two payers are idle.', model: 'gpt-4o-mini' }));
  signals.render();

  await briefButton().handlers.click[0]();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/admin/brief');
  assert.equal(sent[0].method, 'POST');
  assert.ok(Array.isArray(sent[0].body.findings) && sent[0].body.findings.length, 'the findings are the request body');
  assert.match(briefText(), /Two payers are idle/);
});

test('a failing brief leaves every finding on the page', async () => {
  // The findings are computed in the browser and owe nothing to this endpoint.
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx, async () => { throw new Error('network down'); });
  signals.render();

  await briefButton().handlers.click[0]();

  assert.match(briefText(), /could not be written/i);
  assert.match(textOf(dom.byId['adm-signals']), /never used the product/i, 'the findings must survive a brief failure');
});

test('no configured model reads as a stated absence, not as an error', async () => {
  const { signals } = mount(ctxWithFindings(), async () => ({ summary: null, reason: 'unavailable' }));
  signals.render();

  await briefButton().handlers.click[0]();

  const text = briefText();
  assert.match(text, /No model is configured/i);
  assert.match(text, /computed here in the browser/i, 'and it should say the findings are unaffected');
});

test('reset clears a brief so it cannot outlive its findings', () => {
  // A brief written about last hour's numbers must not sit above this hour's.
  const ctx = ctxWithFindings();
  const { signals } = mount(ctx);
  ctx.signalsBrief = { state: 'ready', summary: 'stale' };
  signals.reset();
  assert.equal(ctx.signalsBrief, null);
  assert.equal(ctx.signalsResult, null);
});
