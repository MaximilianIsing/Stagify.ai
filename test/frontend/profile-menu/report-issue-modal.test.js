// The account menu's "Report an issue" dialog (profile-menu/report-issue-modal.js).
//
// WHY THIS IS WORTH PINNING: /api/bug-report was reachable from exactly one control
// in the whole app — the AI Designer's bug button — so this dialog is now the only
// route to it from the home page, the Masking Studio, checkout or the gallery. If it
// silently posts a body the server rejects, or reports success on a failed POST,
// nothing else in the product notices: the user believes the report was filed and
// nobody is ever told otherwise. So the assertions here are about the wire body and
// the outcome the dialog shows, not about how it looks.
//
// Same harness and the same caveats as auth-modal.test.js: a hand-rolled DOM shim
// (test/helpers/auth-modal-dom.js) whose element registry is parsed out of the real
// template, so it cannot drift from the shipped markup. It is not a browser — it
// proves "the module hid the form and wrote this text", never "the panel is visible".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installAuthModalDom } from '../../helpers/auth-modal-dom.js';
import { REPORT_ISSUE_HTML } from '../../../public/scripts/profile-menu/report-issue-template.js';

const dom = installAuthModalDom({
  href: 'https://stagify.ai/masking-studio.html',
  // The account button lives in the page's own header, not in either modal template.
  extraIds: ['profile-menu-btn'],
});
const { createReportIssueModal } = await import(
  '../../../public/scripts/profile-menu/report-issue-modal.js'
);

const el = dom.el;
/** Requests the dialog made, newest last. */
let posted = [];
let closedDropdown = 0;

// ONE instance for the whole file, as a page has: the dialog binds its listeners to
// the shared markup once, so a per-test instance would stack a second submit handler
// on the same form and every later test would post twice, then three times…
const modal = createReportIssueModal({ onCloseDropdown: () => { closedDropdown += 1; } });

/** Point the dialog at a recording fetch with the given outcome, and reset the log. */
function makeModal({ ok = true, reject = false } = {}) {
  posted = [];
  closedDropdown = 0;
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body), method: init.method });
    if (reject) throw new Error('offline');
    return { ok, status: ok ? 200 : 503, json: async () => ({}) };
  };
  return modal;
}

/** Type into the dialog's fields. */
function fill({ description = '', steps = '', email }) {
  el('report-issue-description').value = description;
  el('report-issue-steps').value = steps;
  if (email !== undefined) el('report-issue-email').value = email;
}

/** Open, fill, submit — the whole path a user takes. */
async function submitReport(modal, fields) {
  modal.open();
  fill(fields);
  await el('report-issue-form').emit('submit');
}

test('opening closes the dropdown behind it and reveals the dialog', () => {
  const modal = makeModal();
  modal.open();

  assert.equal(closedDropdown, 1, 'the dropdown is a click-outside popover — it must not stay open behind the overlay');
  assert.equal(el('report-issue-modal').hidden, false);
  assert.equal(el('report-issue-modal').getAttribute('aria-hidden'), 'false');
});

test('focus returns to the element the caller names, not the row it was opened from', () => {
  // The row lives in the dropdown, which opening this closes — so by close time it is
  // inside a display:none subtree and cannot take focus. Chrome silently drops focus
  // to <body> in that case, which is how this shipped broken the first time: the unit
  // shim focuses anything, and only a real browser noticed.
  const modal = makeModal();
  const menuButton = el('profile-menu-btn');
  const row = dom.document.createElement('button');
  row.focus(); // what the user actually clicked

  modal.open(menuButton);
  modal.close();
  assert.equal(dom.document.activeElement, menuButton);
  assert.equal(row.focused && dom.document.activeElement === row, false);
});

test('opening moves focus into the dialog, and closing hands it back to the opener', () => {
  const modal = makeModal();
  // Whatever the user activated to get here, when the caller names nothing.
  const trigger = dom.document.createElement('button');
  trigger.focus();

  modal.open();
  assert.equal(el('report-issue-description').focused, true,
    'without this, focus stays on the control behind the overlay and the dialog is never announced');

  modal.close();
  assert.equal(dom.document.activeElement, trigger, 'focus must return to whatever opened the dialog');
  assert.equal(el('report-issue-modal').hidden, true);
});

test('a signed-in account gets its email prefilled, a signed-out visitor gets an empty field', () => {
  const modal = makeModal();
  dom.window.StagifyAuth.user = { id: 'u-42', email: 'owner@example.com', plan: 'pro' };
  modal.open();
  assert.equal(el('report-issue-email').value, 'owner@example.com');

  dom.window.StagifyAuth.user = null;
  modal.open();
  assert.equal(el('report-issue-email').value, '', 'a stale address must not be carried into the next report');
});

test('reopening clears the previous report rather than pre-filling it', () => {
  const modal = makeModal();
  modal.open();
  fill({ description: 'first report', steps: 'first steps' });
  modal.close();

  modal.open();
  assert.equal(el('report-issue-description').value, '');
  assert.equal(el('report-issue-steps').value, '');
});

test('an empty description is refused before anything is posted', async () => {
  const modal = makeModal();
  await submitReport(modal, { description: '   ' });

  assert.equal(posted.length, 0, 'a blank report is worse than none — it costs a support round trip');
  assert.match(el('report-issue-error').textContent, /describe the problem/i);
  assert.equal(el('report-issue-description').focused, true, 'focus goes to the field the user must fix');
  assert.equal(el('report-issue-success').hidden, true, 'nothing was sent, so nothing is confirmed');
});

test('the posted body is the row the server expects, with the fields trimmed', async () => {
  const modal = makeModal();
  dom.window.StagifyAuth.user = { id: 'u-42', email: 'owner@example.com', plan: 'pro' };
  await submitReport(modal, {
    description: '  the mask brush paints offset  ',
    steps: '  1. open the studio  ',
    email: '  reply@example.com  ',
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/bug-report');
  assert.equal(posted[0].method, 'POST');
  const body = posted[0].body;
  assert.equal(body.description, 'the mask brush paints offset');
  assert.equal(body.steps, '1. open the studio');
  assert.equal(body.email, 'reply@example.com');
  // Every column lib/http/bug-report-row.js writes has to arrive, or the row lands
  // with empty cells that make a report unactionable.
  assert.equal(body.userId, 'u-42', 'the account id identifies the reporter when we have one');
  assert.equal(body.url, 'https://stagify.ai/masking-studio.html', 'which page the problem was on');
  assert.equal(typeof body.userAgent, 'string');
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.conversationHistory, [], 'no AI Designer transcript exists outside the studio');
});

test('signed out, the report still goes out — identified as unknown, not dropped', async () => {
  const modal = makeModal();
  dom.window.StagifyAuth.user = null;
  await submitReport(modal, { description: 'checkout page will not load' });

  assert.equal(posted.length, 1, 'the endpoint is unauthenticated on purpose: anyone can report');
  assert.equal(posted[0].body.userId, 'unknown');
});

test('the AI Designer transcript rides along when there is one, image bytes stripped', async () => {
  // On the studio page window.getConversationHistory is bridged by ai-designer-app.js.
  // The bytes must not reach the wire: the server stores only a per-message image
  // count, and a base64 data URL pushes the body past the 1MB JSON limit — which is
  // how the AI Designer's own bug form once 413'd exactly when it was needed.
  const modal = makeModal();
  dom.window.getConversationHistory = () => [
    { role: 'user', content: 'stage this' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(2048)}` } },
      ],
    },
  ];
  try {
    await submitReport(modal, { description: 'the render came back sideways' });
  } finally {
    delete dom.window.getConversationHistory;
  }

  const history = posted[0].body.conversationHistory;
  assert.equal(history.length, 2);
  assert.deepEqual(history[1].content, [{ type: 'text', text: 'here you go' }, { type: 'image_url' }]);
  assert.ok(!JSON.stringify(posted[0].body).includes('base64'), 'no image bytes may reach the wire');
});

test('a successful report swaps the form for a confirmation and moves focus to it', async () => {
  const modal = makeModal();
  await submitReport(modal, { description: 'the gallery shows yesterday’s renders' });

  assert.equal(el('report-issue-form').hidden, true);
  assert.equal(el('report-issue-success').hidden, false);
  assert.equal(el('report-issue-done').focused, true, 'focus cannot be left on a button that is now hidden');
  assert.equal(el('report-issue-error').textContent, '');
  // The dialog is still open: the confirmation IS the feedback, because four of the
  // ten pages carrying the account menu do not link styles/toast.css.
  assert.equal(el('report-issue-modal').hidden, false);
});

test('a rejected report says so and leaves the form filled in to retry', async () => {
  const modal = makeModal({ ok: false });
  await submitReport(modal, { description: 'the studio hangs on upload' });

  assert.equal(el('report-issue-success').hidden, true, 'a 503 must never read as "we got it"');
  assert.equal(el('report-issue-form').hidden, false);
  assert.match(el('report-issue-error').textContent, /try again/i);
  assert.equal(el('report-issue-description').value, 'the studio hangs on upload', 'retyping it is how a report gets abandoned');
  assert.equal(el('report-issue-submit').disabled, false, 'the retry has to be possible');
});

test('a network failure is reported the same way, not swallowed', async () => {
  const modal = makeModal({ reject: true });
  await submitReport(modal, { description: 'nothing loads on mobile data' });

  assert.equal(el('report-issue-success').hidden, true);
  assert.match(el('report-issue-error').textContent, /try again/i);
  assert.equal(el('report-issue-submit').disabled, false);
});

test('the submit button is re-labelled while in flight and restored after', async () => {
  const modal = makeModal();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    seen.push({ label: el('report-issue-submit-label').textContent, disabled: el('report-issue-submit').disabled });
    return realFetch(...args);
  };
  await submitReport(modal, { description: 'double-submitting files the report twice' });

  assert.equal(seen.length, 1);
  assert.match(seen[0].label, /Sending/i);
  assert.equal(seen[0].disabled, true, 'an enabled button during the POST files the report twice');
  assert.match(el('report-issue-submit-label').textContent, /Send report/i);
  assert.equal(el('report-issue-submit').disabled, false);
});

test('a second report in the same session starts from the form again, not the confirmation', async () => {
  const modal = makeModal();
  await submitReport(modal, { description: 'first problem' });
  assert.equal(el('report-issue-success').hidden, false);

  modal.open();
  assert.equal(el('report-issue-success').hidden, true, 'the previous confirmation must not stand in for this report');
  assert.equal(el('report-issue-form').hidden, false);
});

test('backdrop, close and cancel all dismiss it', () => {
  const modal = makeModal();
  for (const id of ['report-issue-backdrop', 'report-issue-close', 'report-issue-cancel']) {
    modal.open();
    assert.equal(el('report-issue-modal').hidden, false);
    el(id).emit('click');
    assert.equal(el('report-issue-modal').hidden, true, `#${id} must close the dialog`);
  }
});

test('Escape closes it, and only while it is open', async () => {
  const modal = makeModal();
  modal.open();
  await dom.emitDocument('keydown', { key: 'Escape' });
  assert.equal(el('report-issue-modal').hidden, true);

  // Closed already: the handler must not, say, steal the key from a dialog on top.
  let prevented = 0;
  await dom.emitDocument('keydown', { key: 'Escape', preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 0);
});

test('the dialog is only ever built once, however many times it is opened', () => {
  // ensureReportModal() is what keeps a second #report-issue-modal out of the page;
  // duplicate ids would leave getElementById pointing at whichever came first while
  // the user types into the other.
  const modal = makeModal();
  const before = dom.document.body.children.length;
  modal.open();
  modal.close();
  modal.open();
  assert.equal(dom.document.body.children.length, before);
});

test('SOURCE GUARD: the template names every element the module resolves', () => {
  // The shim's registry is built from the template, so a handle whose id is not in
  // the markup would silently resolve to null in a browser and to null here too —
  // the module guards every handle, so the failure is a dead control, not a throw.
  const ids = [...REPORT_ISSUE_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of [
    'report-issue-modal', 'report-issue-backdrop', 'report-issue-close', 'report-issue-form',
    'report-issue-description', 'report-issue-steps', 'report-issue-email', 'report-issue-error',
    'report-issue-cancel', 'report-issue-submit', 'report-issue-submit-label',
    'report-issue-success', 'report-issue-done',
  ]) {
    assert.ok(ids.includes(id), `the template no longer ships #${id}`);
  }
});
