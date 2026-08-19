// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/renders-panel.js.
//
// The strip that finally puts a picture next to a bug report. What matters here
// is not that it paints a grid — it is that the four states a render can be in
// stay distinguishable:
//
//   `ok` with bytes · `failed` · `pending` · **evicted** (row intact, bytes reaped)
//
// Three of those have no image, and painting any of them as a bare broken tile
// turns a working system into an apparent outage. Each has to say which it is.
//
// Also pinned: no `<canvas>` anywhere (presigned R2 URLs taint one, in production
// only — a trap that does not reproduce locally), and prompts set as text rather
// than markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeEl(tag) {
  const node = {
    tagName: tag, className: '', textContent: '', value: '', disabled: false,
    style: {}, attrs: /** @type {Record<string,string>} */ ({}),
    children: /** @type {any[]} */ ([]), handlers: /** @type {Record<string,Function[]>} */ ({}),
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); },
  };
  // Faithful enough to matter: the islands clear a container with innerHTML='',
  // and a stub that kept its children would let a stale "Loading…" placeholder
  // pass a test that is specifically about replacing it.
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set(v) { html = String(v); if (html === '') node.children.length = 0; },
  });
  return node;
}
globalThis.document = /** @type {any} */ ({
  createElement: makeEl,
  createTextNode: (t) => ({ tagName: '#text', textContent: String(t), children: [] }),
});

const { createRendersPanel } = await import('../../../public/scripts/admin/renders-panel.js');

// ---- Walkers ---------------------------------------------------------------

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}
const tags = (n) => walk(n).map((x) => x.tagName);
const text = (n) => walk(n).map((x) => x.textContent || '').join(' ');
const classes = (n) => walk(n).flatMap((x) => String(x.className || '').split(' ')).filter(Boolean);
const settle = () => new Promise((r) => setTimeout(r, 0));

const USER = { id: 'u_1', email: 'sam@example.com' };

function entry(over = {}) {
  return {
    id: 'r_1', createdAt: 1750000000000, status: 'ok', evicted: false, evictedAt: null,
    width: 1024, height: 768, roomType: 'Living Room', furnitureStyle: 'Modern',
    additionalPrompt: '', removeFurniture: false, model: 'gemini-x', variation: 0,
    batchId: '', name: '', bytes: 1234,
    urls: { after: 'https://cdn/a.webp', before: '', thumb: 'https://cdn/t.webp' },
    ...over,
  };
}

function mount(payload, opts = {}) {
  const calls = [];
  const apiSend = (url, method) => {
    calls.push({ url, method });
    return opts.reject ? Promise.reject(payload) : Promise.resolve(payload);
  };
  return { section: createRendersPanel({ apiSend })(USER), calls };
}

// ---- The request itself ----------------------------------------------------

test('it asks for exactly this account, and re-asks on every expand', async () => {
  const { section, calls } = mount({ enabled: true, total: 1, entries: [entry()] });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /^\/api\/admin\/renders\?userId=u_1&limit=\d+$/);
  assert.ok(section);

  // A second expand fetches again rather than reusing the first response: the
  // URLs it carries are short-lived credentials and must not be cached.
  const again = mount({ enabled: true, total: 1, entries: [entry()] });
  await settle();
  assert.equal(again.calls.length, 1);
});

test('a user id is escaped into the query string', async () => {
  const apiSend = (url) => { assert.ok(!url.includes('&evil'), url); return Promise.resolve({ entries: [] }); };
  createRendersPanel({ apiSend })({ id: 'u&evil=1', email: 'x@y.z' });
  await settle();
});

// ---- The four states -------------------------------------------------------

test('a finished render paints an image and never a canvas', async () => {
  const { section } = mount({ enabled: true, total: 1, entries: [entry()] });
  await settle();
  assert.ok(tags(section).includes('img'), 'the picture is an <img>');
  assert.ok(!tags(section).includes('canvas'), 'a canvas would be tainted by the presigned URL in production');
  const img = walk(section).find((n) => n.tagName === 'img');
  assert.equal(img.attrs.src, 'https://cdn/t.webp');
  assert.equal(img.attrs.loading, 'lazy');
});

test('failed, pending and evicted each say WHICH they are instead of showing a broken tile', async () => {
  for (const [over, label] of [
    [{ status: 'failed', urls: { after: '', before: '', thumb: '' } }, /Failed/],
    [{ status: 'pending', urls: { after: '', before: '', thumb: '' } }, /Pending/],
    [{ evicted: true, urls: { after: '', before: '', thumb: '' } }, /Reaped/],
  ]) {
    const { section } = mount({ enabled: true, total: 1, entries: [entry(over)] });
    await settle();
    assert.match(text(section), label, `expected ${label} in the card`);
    assert.ok(!tags(section).includes('img'), 'no image element for a render with no bytes');
    assert.ok(walk(section).some((n) => String(n.className).includes('adm-render-placeholder')));
    // ...and said exactly ONCE. The badge and the placeholder both carried the
    // word at first, so the tile read "Failed / Failed" — which looks like a
    // rendering bug rather than a state.
    const shown = walk(section).filter((n) => label.test(n.textContent || '')).length;
    assert.equal(shown, 1, 'the state is named once, not twice');
  }
});

test('the three no-image states are told apart by class, not just by words', async () => {
  const states = [
    [{ status: 'failed' }, 'adm-render-item--failed'],
    [{ status: 'pending' }, 'adm-render-item--pending'],
    [{ evicted: true }, 'adm-render-item--evicted'],
  ];
  for (const [over, cls] of states) {
    const { section } = mount({ enabled: true, total: 1, entries: [entry({ ...over, urls: { after: '', before: '', thumb: '' } })] });
    await settle();
    assert.ok(classes(section).includes(cls), `expected ${cls}`);
  }
});

test('an evicted render still shows the parameters it was made with', async () => {
  // The row survives eviction; only its bytes are gone. That is the whole reason
  // it is worth showing at all.
  const { section } = mount({
    enabled: true,
    total: 1,
    entries: [entry({ evicted: true, urls: { after: '', before: '', thumb: '' }, additionalPrompt: 'warmer lighting' })],
  });
  await settle();
  const t = text(section);
  assert.match(t, /Living Room/);
  assert.match(t, /warmer lighting/);
  assert.match(t, /Reaped/);
});

// ---- Empty and degraded states ---------------------------------------------

test('no renders is a sentence, not an empty grid', async () => {
  const { section } = mount({ enabled: true, total: 0, entries: [] });
  await settle();
  assert.match(text(section), /No renders found/);
  assert.ok(!classes(section).includes('adm-renders-grid'));
});

test('an unconfigured object store reads as "storage is off", not as an error', async () => {
  const { section } = mount({ enabled: false, total: 0, entries: [] });
  await settle();
  assert.match(text(section), /not configured/);
  assert.ok(!/Could not load/.test(text(section)), 'this is not a failure');
});

test('a failed fetch says so instead of hanging on "Loading"', async () => {
  const { section } = mount(new Error('boom'), { reject: true });
  await settle();
  assert.match(text(section), /Could not load renders: boom/);
  assert.ok(!/Loading/.test(text(section)));
});

// ---- Counting and truncation ----------------------------------------------

test('the heading carries the TOTAL, and truncation is stated rather than silent', async () => {
  const entries = Array.from({ length: 3 }, (_, i) => entry({ id: `r_${i}` }));
  const { section } = mount({ enabled: true, total: 57, entries });
  await settle();
  const t = text(section);
  assert.match(t, /Renders \(57 total\)/, 'the drawer must not imply 3 is all they have');
  assert.match(t, /Showing the 3 most recent of 57/);
});

test('no truncation notice when the page IS everything', async () => {
  const entries = [entry()];
  const { section } = mount({ enabled: true, total: 1, entries });
  await settle();
  assert.ok(!/most recent of/.test(text(section)));
});

// ---- User-supplied strings -------------------------------------------------

test('a prompt is set as text, never as markup', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const { section } = mount({ enabled: true, total: 1, entries: [entry({ additionalPrompt: nasty })] });
  await settle();
  const promptNode = walk(section).find((n) => (n.textContent || '') === nasty);
  assert.ok(promptNode, 'the prompt survives verbatim as text');
  // Nothing anywhere in the tree assembled it into markup.
  assert.ok(walk(section).every((n) => !String(n.innerHTML || '').includes('onerror')));
});

// ---- Which tool made it ----------------------------------------------------

test('the panel names the source, and names the plain studio too', () => {
  // The console deliberately labels EVERY source, including `interior`, which
  // render-name.js leaves blank on purpose for customers. "Which of our five surfaces
  // produced this" is the operator's question; the customer's card answers a different one.
  const cases = [
    ['api', 'API'],
    ['interior', 'Staging studio'],
    ['exterior', 'Exterior Studio'],
    ['designer', 'AI Designer'],
    ['masking', 'Masking Studio'],
  ];
  return Promise.all(cases.map(async ([source, label]) => {
    const { section } = mount({ enabled: true, total: 1, entries: [entry({ source })] });
    await settle();
    assert.match(text(section), new RegExp(`Made with:\\s*${label}`), `${source} should read ${label}`);
  }));
});

test('an unrecognised source shows the raw id rather than going blank', async () => {
  // A retired studio's rows keep flowing through the console long after the rule is gone.
  // Blank would read as "we do not know", when in fact we know exactly and it is stale.
  const { section } = mount({ enabled: true, total: 1, entries: [entry({ source: 'retired-studio' })] });
  await settle();
  assert.match(text(section), /retired-studio/);
});

test('a row with no source omits the row rather than printing an empty one', async () => {
  const { section } = mount({ enabled: true, total: 1, entries: [entry({ source: '', sourceName: '' })] });
  await settle();
  assert.ok(!/Made with/.test(text(section)));
  assert.ok(!/From:/.test(text(section)));
});

test('the source photo stem is shown, because it is what tells two houses apart', async () => {
  const { section } = mount({
    enabled: true,
    total: 1,
    entries: [entry({ source: 'api', sourceName: '412-rosewood' })],
  });
  await settle();
  assert.match(text(section), /From:\s*412-rosewood/);
});
