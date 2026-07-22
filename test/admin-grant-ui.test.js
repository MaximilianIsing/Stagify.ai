// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/grant.js.
//
// The dashboard control that hands a free account a month of Stagify+. Its job is
// to pick ONE of four states for a user row and to send exactly one request, so
// the risk here is a mis-picked branch (offering a grant to someone who already
// has one, or hiding it from someone who should get it) and a request going to the
// wrong endpoint. Both are pure decisions over a plain user object, so the whole
// module is exercised against a minimal fake DOM — no jsdom, matching the other
// frontend-island suites. The server-side rules live in test/pro-grant.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------
// Just the surface public/scripts/admin/helpers.js#el and grant.js touch.

function makeEl(tag) {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    disabled: false,
    style: {},
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    handlers: /** @type {Record<string, Function[]>} */ ({}),
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
  };
}

globalThis.document = /** @type {any} */ ({
  createElement: makeEl,
  createTextNode: (t) => ({ textContent: String(t), children: [] }),
});
let confirmAnswer = true;
globalThis.confirm = () => confirmAnswer;

const { createGrantSection, grantActive } = await import('../public/scripts/admin/grant.js');

// ---- Walkers over the rendered tree ---------------------------------------

function allText(node) {
  return [node.textContent || '', ...(node.children || []).map(allText)].join(' ').trim();
}
function findButton(node) {
  if (node.tagName === 'button') return node;
  for (const c of node.children || []) {
    const hit = findButton(c);
    if (hit) return hit;
  }
  return null;
}
function findByClass(node, cls) {
  if ((node.className || '').split(' ').includes(cls)) return node;
  for (const c of node.children || []) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}
async function click(btn) {
  for (const fn of btn.handlers.click || []) await fn();
  await new Promise((r) => setImmediate(r));
}

// A section renderer with a recording apiSend. `reply` may throw to model a 400.
function harness(reply = () => Promise.resolve({ ok: true, expiresAt: '2026-08-22T00:00:00.000Z' })) {
  const sent = [];
  const changed = { count: 0 };
  const section = createGrantSection({
    apiSend: (url, method, body) => { sent.push({ url, method, body }); return reply(); },
    onChanged: () => { changed.count += 1; },
  });
  return { section, sent, changed };
}

const FREE = { id: 'u_free', email: 'free@example.com', plan: 'free' };
const GRANTED = { id: 'u_g', email: 'gift@example.com', plan: 'pro', proGrantExpiresAt: '2099-01-01T00:00:00.000Z' };
const PAYING = { id: 'u_p', email: 'paid@example.com', plan: 'pro', stripeSubscriptionId: 'sub_1' };

// ---- grantActive -----------------------------------------------------------

test('grantActive only accepts a parseable expiry in the future', () => {
  assert.equal(grantActive(GRANTED), true);
  assert.equal(grantActive(FREE), false);
  assert.equal(grantActive(null), false);
  assert.equal(grantActive({ proGrantExpiresAt: 'whenever' }), false, 'a malformed date is not a live grant');
  assert.equal(grantActive({ proGrantExpiresAt: '2020-01-01T00:00:00.000Z' }), false);
});

// ---- Which state renders ---------------------------------------------------

test('a free account is offered a grant', () => {
  const { section } = harness();
  const node = section({ ...FREE }, 'free');
  const btn = findButton(node);
  assert.ok(btn, 'the grant button is rendered');
  assert.equal(btn.textContent, 'Grant 1 month of Stagify+');
  assert.equal(btn.className, 'adm-grant-btn', 'not the danger variant');
});

test('a running grant shows its end date and a revoke button instead', () => {
  const { section } = harness();
  const node = section({ ...GRANTED }, 'pro');
  const btn = findButton(node);
  assert.equal(btn.textContent, 'Revoke now');
  assert.match(btn.className, /adm-grant-btn--danger/);
  assert.match(allText(node), /Free month active/);
  // fmtDateTime renders "Mon D, H:MM AM/PM" in the viewer's zone (no year), so
  // assert on that shape rather than a literal date the formatter never emits.
  assert.match(allText(node), /[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}/, 'the expiry date is shown');
  assert.doesNotMatch(allText(node), /—\s*\.\s*$/, 'not the empty-date placeholder');
});

test('a Stripe subscriber is read-only — no grant, no revoke', () => {
  const { section } = harness();
  const node = section({ ...PAYING }, 'pro');
  assert.equal(findButton(node), null, 'no button can touch a paying subscriber');
  assert.match(allText(node), /manage this account in Stripe/);
});

test('an account already covered another way is read-only too', () => {
  const { section } = harness();
  // Enterprise coverage leaves the stored plan 'free', so the dashboard's
  // effective plan is what has to gate the button here.
  const node = section({ id: 'u_e', email: 'worker@acme.com', plan: 'free' }, 'enterprise');
  assert.equal(findButton(node), null);
  assert.match(allText(node), /Already on enterprise/);
});

// ---- Sending the request ---------------------------------------------------

test('declining the confirm prompt sends nothing', async () => {
  const { section, sent, changed } = harness();
  confirmAnswer = false;
  const node = section({ ...FREE }, 'free');
  await click(findButton(node));
  confirmAnswer = true;
  assert.deepEqual(sent, [], 'no request left the page');
  assert.equal(changed.count, 0);
});

test('granting posts the user id, flips the record, and asks for a re-render', async () => {
  const { section, sent, changed } = harness();
  const user = { ...FREE };
  const node = section(user, 'free');
  await click(findButton(node));

  assert.deepEqual(sent, [{ url: '/api/admin/grant-plus', method: 'POST', body: { userId: 'u_free' } }]);
  assert.equal(user.plan, 'pro', 'the row updates without a full reload');
  assert.equal(user.proGrantExpiresAt, '2026-08-22T00:00:00.000Z', 'the expiry comes from the server, not the client');
  assert.equal(changed.count, 1);
});

test('revoking posts the user id and drops the record back to free', async () => {
  const { section, sent, changed } = harness(() => Promise.resolve({ ok: true }));
  const user = { ...GRANTED };
  const node = section(user, 'pro');
  await click(findButton(node));

  assert.deepEqual(sent, [{ url: '/api/admin/revoke-plus', method: 'POST', body: { userId: 'u_g' } }]);
  assert.equal(user.plan, 'free');
  assert.equal(grantActive(user), false);
  assert.equal(changed.count, 1);
});

// ---- Failure path ----------------------------------------------------------

test('a rejected grant shows the reason and re-enables the button', async () => {
  const { section, changed } = harness(() => Promise.reject(new Error('This account already has Stagify+.')));
  const user = { ...FREE };
  const node = section(user, 'free');
  const btn = findButton(node);
  await click(btn);

  assert.match(findByClass(node, 'adm-grant-msg').textContent, /already has Stagify\+/);
  assert.equal(btn.disabled, false, 'the admin can retry');
  assert.equal(btn.textContent, 'Grant 1 month of Stagify+', 'the label is restored');
  assert.equal(user.plan, 'free', 'a failed grant does not fake success in the table');
  assert.equal(changed.count, 0, 'no re-render on failure');
});

test('a rejected revoke leaves the grant in place', async () => {
  const { section } = harness(() => Promise.reject(new Error('nope')));
  const user = { ...GRANTED };
  const node = section(user, 'pro');
  const btn = findButton(node);
  await click(btn);

  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Revoke now');
  assert.equal(user.plan, 'pro', 'the account keeps its grant');
});
