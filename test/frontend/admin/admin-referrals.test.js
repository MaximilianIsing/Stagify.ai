// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/referrals.js.
//
// The Referrals tab is the ONLY place campaign links can be created or retired, so
// what's worth pinning is not markup but the things a wrong panel would do:
//   - "Delete" is offered only on an already-retired link, so the irreversible
//     button is never the one sitting next to a live campaign,
//   - the server's rejection text is shown verbatim ("/pro is already part of the
//     site…") instead of a generic failure, because that message is the only thing
//     telling the operator what to type instead,
//   - the copyable URL is built from this page's origin, so the link works on
//     staging as well as production,
//   - a link with zero clicks shows an explicit empty state instead of an axis-less
//     chart that reads as broken,
//   - excluded bot traffic is mentioned only when there IS some,
//   - day labels are formatted in UTC, matching the server's buckets. Parsed as
//     local time, '2026-07-01' renders as "Jun 30" for anyone west of Greenwich,
//     silently shifting the whole chart by a day.
//
// Same minimal stub `document` as admin-charts.test.js — no jsdom.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------

function makeEl(tag, ns) {
  const node = {
    tagName: tag,
    namespaceURI: ns || null,
    className: '',
    textContent: '',
    title: '',
    value: '',
    disabled: false,
    style: /** @type {Record<string, string>} */ ({}),
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    listeners: /** @type {Record<string, Function[]>} */ ({}),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); },
  };
  // `innerHTML = ''` is how every render clears its host, so the stub has to drop
  // the children like a real DOM does. Without this the panel looks like it never
  // clears anything and a stale card reads as a live one.
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set(v) { html = String(v); node.children.length = 0; },
  });
  return node;
}

/** The page's static elements, addressed by the same selectors the module uses. */
const els = {};
for (const id of [
  '#adm-referrals', '#adm-ref-detail', '#adm-ref-form-msg', '#adm-ref-count',
  '#adm-ref-slug', '#adm-ref-label', '#adm-ref-note', '#adm-ref-create',
  '#adm-ref-form', '#adm-ref-preview',
]) els[id] = makeEl('div');

globalThis.document = /** @type {any} */ ({
  createElement: (tag) => makeEl(tag),
  createElementNS: (ns, tag) => makeEl(tag, ns),
  createTextNode: (t) => ({ tagName: '#text', textContent: String(t), children: [] }),
  querySelector: (sel) => els[sel] || null,
});
globalThis.location = /** @type {any} */ ({ origin: 'http://127.0.0.1:3000' });
globalThis.confirm = () => true;

const { createReferralsPanel } = await import('../../../public/scripts/admin/referrals.js');

// ---- Helpers ---------------------------------------------------------------

function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children || []) flatten(child, out);
  return out;
}
const allText = (node) => flatten(node).map((n) => n.textContent || '').filter(Boolean).join(' | ');
const listText = () => allText(els['#adm-referrals']);
const detailText = () => allText(els['#adm-ref-detail']);
const msgText = () => els['#adm-ref-form-msg'].textContent;

/** Every action button rendered in the list, by label. */
const actionLabels = () =>
  flatten(els['#adm-referrals'])
    .filter((n) => String(n.className).indexOf('adm-ref-action') === 0)
    .map((n) => n.textContent);

const linkFixture = (over = {}) => ({
  slug: 'columbia',
  label: 'Columbia University',
  note: 'Campus outreach',
  path: '/columbia',
  active: true,
  clicks: 42,
  botHits: 7,
  windowClicks: 12,
  windowDays: 30,
  last7: 5,
  createdAt: Date.UTC(2026, 5, 1),
  deactivatedAt: null,
  firstClickAt: Date.UTC(2026, 6, 1, 9),
  lastClickAt: Date.UTC(2026, 6, 28, 9),
  series: [
    { date: '2026-07-01', value: 3 },
    { date: '2026-07-02', value: 0 },
    { date: '2026-07-03', value: 9 },
  ],
  referrers: [{ source: 'columbia.edu/housing', value: 8 }],
  ...over,
});

/** Reset the page and mount the panel over a scripted api. */
function mount(handler) {
  for (const key of Object.keys(els)) {
    els[key].children = [];
    els[key].innerHTML = '';
    els[key].textContent = '';
    els[key].value = '';
    els[key].listeners = {};
  }
  /** @type {Array<{url: string, method: string, body: any}>} */
  const calls = [];
  const panel = createReferralsPanel({
    apiSend: (url, method, body) => {
      calls.push({ url, method, body });
      return Promise.resolve(handler(url, method, body));
    },
  });
  panel.init();
  return { panel, calls };
}

const settle = () => new Promise((r) => setImmediate(r));

/** Mount with a fixed link set and wait for the first render. */
async function withLinks(links) {
  const m = mount(() => ({ days: 30, links }));
  m.panel.ensureLoaded();
  await settle();
  return m;
}

// ---- List ------------------------------------------------------------------

test('the list shows each link with its own numbers', async () => {
  await withLinks([
    linkFixture(),
    linkFixture({ slug: 'nyu', label: 'NYU', path: '/nyu', clicks: 9, last7: 2 }),
  ]);
  const text = listText();
  assert.match(text, /\/columbia/);
  assert.match(text, /Columbia University/);
  assert.match(text, /\/nyu/);
  assert.match(text, /NYU/);
  assert.equal(els['#adm-ref-count'].textContent, '2');
});

test('an empty account is told what to do, not shown a blank table', async () => {
  await withLinks([]);
  assert.match(listText(), /No links yet/);
  assert.equal(els['#adm-ref-count'].textContent, '0');
});

// ---- Retire vs delete ------------------------------------------------------

test('a live link offers Retire but never Delete', async () => {
  // The two-step is the whole safety story: the irreversible button must not sit
  // next to a running campaign.
  await withLinks([linkFixture({ active: true })]);
  const labels = actionLabels();
  assert.ok(labels.includes('Retire'), `expected a Retire button, saw: ${labels.join(', ')}`);
  assert.equal(labels.includes('Delete'), false, 'Delete must not be reachable on a live link');
});

test('a retired link offers Restore and Delete', async () => {
  await withLinks([linkFixture({ active: false, deactivatedAt: Date.UTC(2026, 6, 20) })]);
  const labels = actionLabels();
  assert.ok(labels.includes('Restore'));
  assert.ok(labels.includes('Delete'));
  assert.equal(labels.includes('Retire'), false);
  assert.match(listText(), /retired/, 'and the row is marked');
});

test('Retire calls deactivate, not delete', async () => {
  const m = mount((url) => (url.indexOf('/api/admin/referrals') === 0 ? { days: 30, links: [linkFixture()] } : {}));
  m.panel.ensureLoaded();
  await settle();

  flatten(els['#adm-referrals']).filter((n) => n.textContent === 'Retire')[0].click();
  await settle();

  const mutations = m.calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, '/api/admin/referrals/columbia/deactivate');
  assert.equal(mutations[0].method, 'POST', 'never DELETE — that would erase the history');
});

test('Delete warns with the click count it is about to destroy', async () => {
  let warned = '';
  globalThis.confirm = (text) => { warned = text; return true; };
  const m = mount(() => ({ days: 30, links: [linkFixture({ active: false, clicks: 42 })] }));
  m.panel.ensureLoaded();
  await settle();

  flatten(els['#adm-referrals']).filter((n) => n.textContent === 'Delete')[0].click();
  await settle();

  assert.match(warned, /42 recorded click/, 'the confirm names what is lost');
  assert.match(warned, /cannot be undone/);
  const mutations = m.calls.filter((c) => c.method === 'DELETE');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, '/api/admin/referrals/columbia');
  globalThis.confirm = () => true;
});

test('declining the delete confirm sends nothing', async () => {
  globalThis.confirm = () => false;
  const m = mount(() => ({ days: 30, links: [linkFixture({ active: false })] }));
  m.panel.ensureLoaded();
  await settle();

  flatten(els['#adm-referrals']).filter((n) => n.textContent === 'Delete')[0].click();
  await settle();

  assert.equal(m.calls.filter((c) => c.method === 'DELETE').length, 0);
  globalThis.confirm = () => true;
});

// ---- Creating --------------------------------------------------------------

test('creating posts the trimmed, lowercased values and reloads', async () => {
  const m = mount((url, method) => (method === 'POST'
    ? { ok: true, link: linkFixture({ slug: 'nyu', path: '/nyu' }) }
    : { days: 30, links: [] }));
  m.panel.ensureLoaded();
  await settle();

  els['#adm-ref-slug'].value = '  NYU  ';
  els['#adm-ref-label'].value = '  NYU  ';
  els['#adm-ref-note'].value = ' Instagram ';
  els['#adm-ref-create'].click();
  await settle();
  await settle();

  const post = m.calls.filter((c) => c.method === 'POST')[0];
  assert.deepEqual(post.body, { slug: 'nyu', label: 'NYU', note: 'Instagram' });
  assert.equal(els['#adm-ref-slug'].value, '', 'the form is cleared on success');
  assert.match(msgText(), /works right now/);
  assert.ok(m.calls.filter((c) => c.method === 'GET').length >= 2, 'the list is refetched');
});

test("a rejected slug shows the server's exact reason", async () => {
  // "/pro is already part of the site" is the only thing telling the operator what
  // to type instead; a generic "Could not create the link" would strand them.
  const m = mount((url, method) => {
    if (method === 'POST') return Promise.reject(new Error('/pro is already part of the site, so a link there would never be counted.'));
    return { days: 30, links: [] };
  });
  m.panel.ensureLoaded();
  await settle();

  els['#adm-ref-slug'].value = 'pro';
  els['#adm-ref-label'].value = 'Pricing push';
  els['#adm-ref-create'].click();
  await settle();
  await settle();

  assert.match(msgText(), /already part of the site/);
  assert.equal(els['#adm-ref-slug'].value, 'pro', 'the typed value survives so it can be edited');
  assert.equal(els['#adm-ref-create'].disabled, false, 'and the button is usable again');
});

test('creating without a name or a url never reaches the server', async () => {
  const m = await withLinks([]);
  const before = m.calls.length;

  els['#adm-ref-slug'].value = '';
  els['#adm-ref-label'].value = 'No url';
  els['#adm-ref-create'].click();
  await settle();
  assert.match(msgText(), /Enter a URL/);

  els['#adm-ref-slug'].value = 'nyu';
  els['#adm-ref-label'].value = '';
  els['#adm-ref-create'].click();
  await settle();
  assert.match(msgText(), /name/);

  assert.equal(m.calls.length, before, 'no POST was attempted');
});

test('the URL preview updates as the slug is typed', async () => {
  await withLinks([]);
  els['#adm-ref-slug'].value = 'Columbia';
  els['#adm-ref-slug'].listeners.input[0]();
  assert.equal(els['#adm-ref-preview'].textContent, 'http://127.0.0.1:3000/columbia');

  els['#adm-ref-slug'].value = '';
  els['#adm-ref-slug'].listeners.input[0]();
  assert.equal(els['#adm-ref-preview'].textContent, '');
});

// ---- Detail ----------------------------------------------------------------

test('selecting a link opens its detail; selecting again closes it', async () => {
  await withLinks([linkFixture()]);
  assert.equal(detailText(), '', 'nothing is open to begin with');

  const row = flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0];
  row.click();
  assert.match(detailText(), /Columbia University/);

  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();
  assert.equal(detailText(), '', 'clicking the open row closes it');
});

test('the detail carries the copyable URL and the headline numbers', async () => {
  await withLinks([linkFixture()]);
  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();

  const urls = flatten(els['#adm-ref-detail']).filter((n) => n.className === 'adm-host-url');
  assert.equal(urls[0].textContent, 'http://127.0.0.1:3000/columbia', 'built from this origin, not a hardcoded domain');
  const text = detailText();
  assert.match(text, /All time: 42/);
  assert.match(text, /Last 30 days: 12/);
  assert.match(text, /Last 7 days: 5/);
  assert.match(text, /columbia\.edu\/housing/);
});

test('excluded bot traffic is reported only when there is some', async () => {
  await withLinks([linkFixture({ botHits: 7 })]);
  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();
  assert.match(detailText(), /7 bot hits excluded/);

  await withLinks([linkFixture({ botHits: 0 })]);
  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();
  assert.equal(/bot hits/.test(detailText()), false, 'no confusing "0 bot hits" chip on a clean link');
});

test('a link with no clicks gets an explicit empty state, not an empty chart', async () => {
  await withLinks([linkFixture({
    clicks: 0, windowClicks: 0, last7: 0, botHits: 0,
    lastClickAt: null, firstClickAt: null, referrers: [], series: [],
  })]);
  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();

  const text = detailText();
  assert.match(text, /No clicks recorded yet/);
  assert.match(text, /No referring sites recorded/);
  assert.match(text, /Last click: —/);
  assert.equal(
    flatten(els['#adm-ref-detail']).some((n) => n.className === 'adm-chart-svg'),
    false,
    'no chart is drawn for a link with nothing to draw',
  );
});

test('day labels are formatted in UTC, matching the server buckets', async () => {
  // Parsed as local time instead, '2026-07-01' renders as "Jun 30" anywhere west of
  // Greenwich and the whole chart silently slides by a day.
  await withLinks([linkFixture()]);
  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();

  const labels = flatten(els['#adm-ref-detail'])
    .flatMap((n) => (n.children || []).filter((c) => c.tagName === '#text'))
    .map((n) => n.textContent);
  assert.ok(labels.some((t) => /Jul 1\b/.test(t)), `expected a "Jul 1" axis label, saw: ${labels.join(', ')}`);
  assert.equal(labels.some((t) => /Jun 30/.test(t)), false, 'no off-by-one-day drift');
});

test('a selected link that disappears drops the selection instead of erroring', async () => {
  // The delete button does exactly this: removes the link that is currently open.
  const m = mount(() => ({ days: 30, links: [linkFixture()] }));
  m.panel.ensureLoaded();
  await settle();
  flatten(els['#adm-referrals']).filter((n) => n.className.indexOf('adm-ref-row') === 0)[0].click();
  assert.notEqual(detailText(), '');

  const gone = mount(() => ({ days: 30, links: [] }));
  gone.panel.ensureLoaded();
  await settle();
  assert.equal(detailText(), '');
});

// ---- Lifecycle -------------------------------------------------------------

test('a failed fetch reports the error instead of spinning forever', async () => {
  const m = mount(() => Promise.reject(new Error('HTTP 403')));
  m.panel.ensureLoaded();
  await settle();
  await settle();
  assert.match(listText(), /Could not load referral links: HTTP 403/);
});

test('the panel is fetched once, and again after a reset', async () => {
  const m = mount(() => ({ days: 30, links: [linkFixture()] }));
  m.panel.ensureLoaded();
  m.panel.ensureLoaded(); // second tab open — must not refetch
  await settle();
  assert.equal(m.calls.length, 1, 'lazy-loaded once');

  // Refresh and sign-out both go through reset(); the next open must refetch, or
  // the dashboard would keep showing the previous session's numbers.
  m.panel.reset();
  m.panel.ensureLoaded();
  await settle();
  assert.equal(m.calls.length, 2);
});
