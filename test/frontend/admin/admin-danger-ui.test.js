// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/danger.js.
//
// The two account actions with real consequences. What is being pinned is not
// that the buttons work — it is that they cannot fire when they should not:
//
//   - **The delete button is inert until the operator types the account's own
//     address.** A `confirm()` dialog is one keystroke from a mis-click on the
//     wrong row, and erasure has no undo and no tombstone. The typed address is
//     what makes "I clicked the row above" impossible.
//   - **The `force` retry is never automatic.** The server refuses an account
//     with a live Stripe subscription; retrying with `force: true` on that
//     refusal would make the guard decorative. It has to become a second,
//     separately-confirmed step showing the server's own sentence.
//   - **Zero revoked sessions is reported as zero.** "Signed out everywhere" on
//     an account with no live session is a lie the operator would act on.
//
// Fake DOM only, matching admin-grant-ui.test.js — no jsdom. The server-side
// rules live in test/data/user-deletion.test.js and test/routes/admin-route.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------

function makeEl(tag) {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    handlers: /** @type {Record<string, Function[]>} */ ({}),
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
    fire(evt) { for (const fn of this.handlers[evt] || []) fn(); },
  };
}

globalThis.document = /** @type {any} */ ({
  createElement: makeEl,
  createTextNode: (t) => ({ textContent: String(t), children: [] }),
});
let confirmAnswer = true;
globalThis.confirm = () => confirmAnswer;

const { createDangerSection } = await import('../../../public/scripts/admin/danger.js');

// ---- Walkers ---------------------------------------------------------------

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}
function buttons(node) {
  return walk(node).filter((n) => n.tagName === 'button');
}
function buttonLabelled(node, re) {
  return buttons(node).find((b) => re.test(b.textContent || '')) || null;
}
function input(node) {
  return walk(node).find((n) => n.tagName === 'input') || null;
}
function byClass(node, cls) {
  return walk(node).find((n) => (n.className || '').split(' ').includes(cls)) || null;
}
function allText(node) {
  return walk(node).map((n) => n.textContent || '').join(' ');
}

const USER = { id: 'u_1', email: 'sam@example.com' };

/** Build a section with a scripted apiSend, recording every call. */
function mount(responder, over = {}) {
  const calls = [];
  const deleted = [];
  const apiSend = (url, method, body) => {
    calls.push({ url, method, body });
    return Promise.resolve()
      .then(() => responder({ url, method, body }))
      .then((v) => v ?? {});
  };
  const section = createDangerSection({ apiSend, onDeleted: (u) => deleted.push(u) })({ ...USER, ...over });
  return { section, calls, deleted };
}

/** Let the promise chain inside a handler settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---- The delete gate -------------------------------------------------------

test('the delete button starts disabled and sends nothing while the typed email is wrong', async () => {
  const { section, calls } = mount(() => ({ ok: true }));
  const del = buttonLabelled(section, /^Delete account$/);
  const box = input(section);

  assert.equal(del.disabled, true, 'inert before anything is typed');

  del.fire('click');
  await settle();
  assert.equal(calls.length, 0, 'a click on the disabled button must not send');

  box.value = 'sam@exampl.com'; // one character short
  box.fire('input');
  assert.equal(del.disabled, true);
  del.fire('click');
  await settle();
  assert.equal(calls.length, 0, 'a near-miss address must not enable deletion');
});

test('typing the account email exactly enables it, and sends one un-forced delete', async () => {
  const { section, calls, deleted } = mount(() => ({ ok: true }));
  const del = buttonLabelled(section, /^Delete account$/);
  const box = input(section);

  box.value = '  SAM@Example.com  '; // trimmed and case-folded: copied from a table
  box.fire('input');
  assert.equal(del.disabled, false);

  del.fire('click');
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/admin/delete-user');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.force, false, 'the first attempt is never forced');
  assert.deepEqual(deleted, [{ ...USER }], 'the caller is told exactly once');
});

test('an account with no email cannot be deleted by typing nothing', async () => {
  // An empty target would make an empty box "match" and arm the button.
  const { section, calls } = mount(() => ({ ok: true }), { email: '' });
  const del = buttonLabelled(section, /^Delete account$/);
  const box = input(section);
  box.value = '';
  box.fire('input');
  assert.equal(del.disabled, true);
  del.fire('click');
  await settle();
  assert.equal(calls.length, 0);
});

// ---- The force escalation --------------------------------------------------

test('a live subscription is NOT auto-retried with force — it becomes a second step', async () => {
  const err = new Error('This account has an active Stripe subscription.');
  /** @type {any} */ (err).code = 'ACTIVE_SUBSCRIPTION';

  const { section, calls } = mount(({ body }) => {
    if (!body.force) throw err;
    return { ok: true };
  });
  const del = buttonLabelled(section, /^Delete account$/);
  const box = input(section);
  box.value = USER.email;
  box.fire('input');

  del.fire('click');
  await settle();

  assert.equal(calls.length, 1, 'exactly one request — no automatic retry');
  // The server's own sentence, verbatim: it is the only thing telling the
  // operator what to do about the subscription.
  assert.match(byClass(section, 'adm-danger-msg').textContent, /active Stripe subscription/);

  const force = buttonLabelled(section, /Delete anyway/);
  assert.ok(force, 'the escalation appears only after the server refuses');
  assert.match(allText(section), /Cancel it in Stripe first/);

  force.fire('click');
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.force, true);
});

test('an ordinary failure does not offer the force step', async () => {
  const err = new Error('Something else went wrong');
  /** @type {any} */ (err).code = 'NOT_FOUND';
  const { section, calls } = mount(() => { throw err; });
  const box = input(section);
  box.value = USER.email;
  box.fire('input');
  buttonLabelled(section, /^Delete account$/).fire('click');
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(buttonLabelled(section, /Delete anyway/), null, 'force is only for the subscription guard');
  assert.match(byClass(section, 'adm-danger-msg').textContent, /Delete failed/);
});

test('a failed delete re-arms the button rather than stranding it', async () => {
  const { section } = mount(() => { throw new Error('nope'); });
  const del = buttonLabelled(section, /^Delete account$/);
  const box = input(section);
  box.value = USER.email;
  box.fire('input');
  del.fire('click');
  await settle();
  assert.equal(del.disabled, false, 'the operator can retry without retyping');
  assert.equal(del.textContent, 'Delete account');
});

// ---- Sign out everywhere ---------------------------------------------------

test('sign-out asks first, and a declined confirm sends nothing', async () => {
  confirmAnswer = false;
  const { section, calls } = mount(() => ({ ok: true, revoked: 3 }));
  buttonLabelled(section, /Sign out everywhere/).fire('click');
  await settle();
  assert.equal(calls.length, 0);
  confirmAnswer = true;
});

test('sign-out reports the count, and reports ZERO as zero', async () => {
  const a = mount(() => ({ ok: true, revoked: 3 }));
  buttonLabelled(a.section, /Sign out everywhere/).fire('click');
  await settle();
  assert.equal(a.calls[0].url, '/api/admin/revoke-sessions');
  assert.equal(a.calls[0].body.userId, 'u_1');
  assert.match(byClass(a.section, 'adm-danger-msg').textContent, /Revoked 3 sessions\./);

  // The case that must not read as success: nothing was signed out.
  const b = mount(() => ({ ok: true, revoked: 0 }));
  buttonLabelled(b.section, /Sign out everywhere/).fire('click');
  await settle();
  assert.match(byClass(b.section, 'adm-danger-msg').textContent, /No live sessions/);

  // And the singular is not "1 sessions".
  const c = mount(() => ({ ok: true, revoked: 1 }));
  buttonLabelled(c.section, /Sign out everywhere/).fire('click');
  await settle();
  assert.match(byClass(c.section, 'adm-danger-msg').textContent, /Revoked 1 session\./);
});

test('sign-out never deletes anything, whatever it is told', async () => {
  const { section, calls, deleted } = mount(() => ({ ok: true, revoked: 2 }));
  buttonLabelled(section, /Sign out everywhere/).fire('click');
  await settle();
  assert.deepEqual(calls.map((c) => c.url), ['/api/admin/revoke-sessions']);
  assert.deepEqual(deleted, []);
});

// ---- Copy and affordances --------------------------------------------------

test('the section says what each action does before it is taken', async () => {
  const { section } = mount(() => ({ ok: true }));
  const text = allText(section);
  assert.match(text, /Danger zone/);
  assert.match(text, /password is unchanged/, 'sign-out states what it does NOT do');
  assert.match(text, /no undo/, 'deletion states that it is irreversible');
});

test('the confirm box is labelled for a screen reader and names its target', async () => {
  const { section } = mount(() => ({ ok: true }));
  const box = input(section);
  assert.match(box.attrs['aria-label'], /sam@example\.com/);
  assert.equal(box.attrs.autocomplete, 'off', 'an address box that autofills defeats the point');
});
