// Tier: frontend island logic (no DOM) — public/scripts/admin/analytics-users.js.
//
// The per-account joins: last-active, the activation funnel, and cohort
// retention. Two things make these worth testing rather than eyeballing:
//
//   - **Activity lives under two identifiers.** Renders are keyed by email, chat
//     and mask edits by userId. An account is active if EITHER matches, so a
//     regression here silently reports a working account as dormant.
//   - **Absent ≠ zero.** A render logged without an email belongs to nobody; a
//     cohort month that hasn't elapsed yet is not 0% retention. Both have to stay
//     distinguishable from a real zero, or the dashboard invents churn.
//
// `now` is injected everywhere it matters so none of this depends on the clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildActivityIndex, activityIndexFrom, lastActiveMs, daysSinceActive,
  attributionCoverage, activationFunnel, funnelMonotonic, paidConversion, cohortRetention,
} from '../../../public/scripts/admin/analytics-users.js';

const DAY = 24 * 60 * 60 * 1000;

// prompt_logs row: timestamp,roomType,style,addl,remove,role,referral,email,ip,…
const prompt = (ts, email, extra = {}) => {
  const r = [ts, extra.room || 'Living Room', 'Modern', '', 'false', 'agent', 'google', email, '1.1.1.1'];
  return r;
};
// chat_logs row: timestamp,userId,…   mask_logs row: timestamp,prompt,model,geminiModel,w,h,userId,…
const chat = (ts, userId) => [ts, userId, 'hi', '', '', '', '', ''];
const mask = (ts, userId) => [ts, 'p', 'm', 'gemini', '100', '100', userId, '', ''];

const iso = (msAgo, now = Date.now()) => new Date(now - msAgo).toISOString();

// ── Activity index ──────────────────────────────────────────────────────────

test('buildActivityIndex: keeps the NEWEST timestamp per identifier', () => {
  const idx = buildActivityIndex({
    promptRows: [
      prompt('2026-07-01T10:00:00Z', 'a@x.com'),
      prompt('2026-07-20T10:00:00Z', 'a@x.com'),
      prompt('2026-07-10T10:00:00Z', 'a@x.com'),
    ],
  });
  assert.equal(idx.byEmail['a@x.com'], new Date('2026-07-20T10:00:00Z').getTime());
  assert.equal(idx.rendersByEmail['a@x.com'], 3);
});

test('buildActivityIndex: emails are matched case-insensitively', () => {
  const idx = buildActivityIndex({ promptRows: [prompt('2026-07-01T10:00:00Z', 'A@X.com'), prompt('2026-07-02T10:00:00Z', 'a@x.COM')] });
  assert.equal(idx.rendersByEmail['a@x.com'], 2, 'one user, not two');
});

test('buildActivityIndex: anonymous and unparseable rows are skipped, not bucketed', () => {
  const idx = buildActivityIndex({
    promptRows: [prompt('2026-07-01T10:00:00Z', 'unknown'), prompt('2026-07-01T10:00:00Z', ''), prompt('not-a-date', 'a@x.com')],
  });
  assert.equal(Object.keys(idx.byEmail).length, 0, 'no timestamp recorded for an unparseable row');
  assert.equal(idx.rendersByEmail['unknown'], undefined);
  assert.equal(idx.rendersByEmail[''], undefined);
  // The unparseable row still counts as a render by that user — only its time is unusable.
  assert.equal(idx.rendersByEmail['a@x.com'], 1);
});

test('lastActiveMs: takes the newest across BOTH identifiers', () => {
  const idx = buildActivityIndex({
    promptRows: [prompt('2026-07-01T10:00:00Z', 'a@x.com')],
    chatRows: [chat('2026-07-15T10:00:00Z', 'u_1')],
    maskRows: [mask('2026-07-05T10:00:00Z', 'u_1')],
  });
  const user = { id: 'u_1', email: 'a@x.com' };
  assert.equal(lastActiveMs(user, idx), new Date('2026-07-15T10:00:00Z').getTime(), 'the chat message is newest');

  // Chat/mask alone is still activity, even with no attributed render.
  assert.equal(lastActiveMs({ id: 'u_1', email: 'nobody@x.com' }, idx), new Date('2026-07-15T10:00:00Z').getTime());
  // A render alone is too.
  assert.equal(lastActiveMs({ id: 'u_other', email: 'a@x.com' }, idx), new Date('2026-07-01T10:00:00Z').getTime());
});

test('lastActiveMs: an account in no log at all is null, not 0', () => {
  const idx = buildActivityIndex({ promptRows: [prompt('2026-07-01T10:00:00Z', 'a@x.com')] });
  assert.equal(lastActiveMs({ id: 'u_9', email: 'ghost@x.com' }, idx), null);
  assert.equal(lastActiveMs(null, idx), null);
});

test('daysSinceActive: whole days back, 0 for today, null for never', () => {
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  const idx = buildActivityIndex({
    promptRows: [prompt(iso(0, now), 'today@x.com'), prompt(iso(3 * DAY, now), 'old@x.com')],
  });
  assert.equal(daysSinceActive({ id: '', email: 'today@x.com' }, idx, now), 0);
  assert.equal(daysSinceActive({ id: '', email: 'old@x.com' }, idx, now), 3);
  assert.equal(daysSinceActive({ id: '', email: 'ghost@x.com' }, idx, now), null);
});

test('activityIndexFrom: strips the CSV headers before indexing', () => {
  const idx = activityIndexFrom({
    promptRows: [['timestamp', 'roomType', 'furnitureStyle', '', '', '', '', 'email', ''], prompt('2026-07-01T10:00:00Z', 'a@x.com')],
  });
  assert.equal(idx.rendersByEmail['email'], undefined, 'the header is not a user');
  assert.equal(idx.rendersByEmail['a@x.com'], 1);
});

// ── Attribution coverage ────────────────────────────────────────────────────

test('attributionCoverage: the share of renders that can be tied to an account', () => {
  const rows = [
    prompt('2026-07-01T10:00:00Z', 'a@x.com'),
    prompt('2026-07-01T10:00:00Z', 'unknown'),
    prompt('2026-07-01T10:00:00Z', 'unknown'),
    prompt('2026-07-01T10:00:00Z', ''),
  ];
  const c = attributionCoverage(rows);
  assert.equal(c.total, 4);
  assert.equal(c.attributed, 1);
  assert.equal(c.pct, 25);
  assert.deepEqual(attributionCoverage([]), { total: 0, attributed: 0, pct: 0 });
});

// ── Activation funnel ───────────────────────────────────────────────────────

const planOf = (u) => u.plan || 'free';

test('activationFunnel: nested usage steps that can only narrow', () => {
  const users = [
    { id: 'u1', email: 'power@x.com', plan: 'pro' },   // 5 renders
    { id: 'u2', email: 'repeat@x.com', plan: 'free' }, // 2 renders
    { id: 'u3', email: 'once@x.com', plan: 'free' },   // 1 render
    { id: 'u4', email: 'never@x.com', plan: 'free' },  // 0
  ];
  const promptRows = [];
  for (let i = 0; i < 5; i++) promptRows.push(prompt('2026-07-0' + (i + 1) + 'T10:00:00Z', 'power@x.com'));
  promptRows.push(prompt('2026-07-01T10:00:00Z', 'repeat@x.com'));
  promptRows.push(prompt('2026-07-02T10:00:00Z', 'repeat@x.com'));
  promptRows.push(prompt('2026-07-01T10:00:00Z', 'once@x.com'));

  const steps = activationFunnel(users, buildActivityIndex({ promptRows }));
  assert.deepEqual(steps.map((s) => s.value), [4, 3, 2, 1]);
  assert.deepEqual(steps.map((s) => s.label),
    ['Accounts', 'Activated (1+ render)', 'Repeat (2+ renders)', 'Power user (5+ renders)']);
  assert.ok(funnelMonotonic(steps));

  assert.equal(steps[0].pctOfPrev, null, 'the top of the funnel has nothing to convert from');
  assert.equal(steps[1].pctOfPrev, 75);
  assert.equal(steps[1].pctOfTop, 75);
  assert.equal(steps[3].pctOfTop, 25);
});

test('activationFunnel: paying does NOT widen a step — the real-data regression', () => {
  // Live data hit exactly this: 13 paid accounts but only 11 with an attributed
  // render, because most renders log anonymously. Paid used to be the last funnel
  // step, so it drew wider than its own parent. It now lives outside the ladder.
  const users = [];
  for (let i = 0; i < 24; i++) users.push({ id: 'u' + i, email: 'u' + i + '@x.com', plan: i < 13 ? 'pro' : 'free' });
  const promptRows = [];
  for (let i = 0; i < 11; i++) promptRows.push(prompt('2026-07-01T10:00:00Z', 'u' + (i + 13) + '@x.com'));

  const steps = activationFunnel(users, buildActivityIndex({ promptRows }));
  assert.ok(funnelMonotonic(steps), 'a funnel step must never be wider than its parent');
  assert.ok(!steps.some((s) => /paid/i.test(s.label)), 'paid is not a rung on the usage ladder');

  const paid = paidConversion(users, planOf);
  assert.equal(paid.paid, 13);
  assert.equal(paid.total, 24);
  assert.ok(paid.paid > steps[1].value, 'and it genuinely can exceed the activated count');
});

test('funnelMonotonic: flags a widening step', () => {
  assert.equal(funnelMonotonic([{ value: 10 }, { value: 4 }, { value: 4 }]), true);
  assert.equal(funnelMonotonic([{ value: 10 }, { value: 4 }, { value: 5 }]), false);
  assert.equal(funnelMonotonic([]), true);
});

test('paidConversion: pro and enterprise both count, empty base is 0% not NaN', () => {
  assert.deepEqual(paidConversion([{ plan: 'pro' }, { plan: 'enterprise' }, { plan: 'free' }], planOf),
    { paid: 2, total: 3, pct: (2 / 3) * 100 });
  assert.deepEqual(paidConversion([], planOf), { paid: 0, total: 0, pct: 0 });
});

test('activationFunnel: no users means all zeros and no division by zero', () => {
  const steps = activationFunnel([], buildActivityIndex({}));
  assert.deepEqual(steps.map((s) => s.value), [0, 0, 0, 0]);
  assert.ok(steps.every((s) => Number.isFinite(s.pctOfTop)));
});

test('activationFunnel: an anonymous render activates nobody', () => {
  const users = [{ id: 'u1', email: 'a@x.com', plan: 'free' }];
  const promptRows = [prompt('2026-07-01T10:00:00Z', 'unknown'), prompt('2026-07-01T10:00:00Z', 'unknown')];
  const steps = activationFunnel(users, buildActivityIndex({ promptRows }));
  assert.equal(steps[1].value, 0, 'unattributed usage cannot activate an account — this is the documented floor');
});

// ── Cohort retention ────────────────────────────────────────────────────────

test('cohortRetention: one row per signup month, cells only for elapsed months', () => {
  const now = new Date(2026, 6, 20).getTime(); // July 2026
  const users = [
    { id: 'u1', email: 'a@x.com', createdAt: new Date(2026, 4, 3).toISOString() },  // May cohort
    { id: 'u2', email: 'b@x.com', createdAt: new Date(2026, 4, 20).toISOString() }, // May cohort
    { id: 'u3', email: 'c@x.com', createdAt: new Date(2026, 6, 1).toISOString() },  // July cohort
  ];
  const promptRows = [
    prompt(new Date(2026, 4, 10).toISOString(), 'a@x.com'), // May, month 0
    prompt(new Date(2026, 6, 2).toISOString(), 'a@x.com'),  // July, month 2
    prompt(new Date(2026, 4, 25).toISOString(), 'b@x.com'), // May, month 0
    prompt(new Date(2026, 6, 5).toISOString(), 'c@x.com'),  // July, month 0
  ];

  const { cohorts, maxOffset } = cohortRetention(users, promptRows, now);
  assert.deepEqual(cohorts.map((c) => c.key), ['2026-05', '2026-07']);
  assert.equal(maxOffset, 2, 'the oldest cohort is two months old');

  const may = cohorts[0];
  assert.equal(may.size, 2);
  assert.equal(may.cells.length, 3, 'months 0,1,2 have elapsed');
  assert.equal(may.cells[0].active, 2);
  assert.equal(may.cells[0].pct, 100);
  assert.equal(may.cells[1].active, 0, 'a real zero: June elapsed and nobody rendered');
  assert.equal(may.cells[2].active, 1);
  assert.equal(may.cells[2].pct, 50);

  const july = cohorts[1];
  assert.equal(july.cells.length, 1, 'a new cohort has no future months — absent, not 0%');
  assert.equal(july.cells[0].pct, 100);
});

test('cohortRetention: a member counted once per month however often they render', () => {
  const now = new Date(2026, 6, 20).getTime();
  const users = [{ id: 'u1', email: 'a@x.com', createdAt: new Date(2026, 6, 1).toISOString() }];
  const promptRows = [
    prompt(new Date(2026, 6, 2).toISOString(), 'a@x.com'),
    prompt(new Date(2026, 6, 3).toISOString(), 'a@x.com'),
    prompt(new Date(2026, 6, 4).toISOString(), 'a@x.com'),
  ];
  const { cohorts } = cohortRetention(users, promptRows, now);
  assert.equal(cohorts[0].cells[0].active, 1);
  assert.equal(cohorts[0].cells[0].pct, 100, 'retention is people, not events — it can never exceed 100%');
});

test('cohortRetention: activity dated before signup is ignored, not a negative offset', () => {
  const now = new Date(2026, 6, 20).getTime();
  const users = [{ id: 'u1', email: 'a@x.com', createdAt: new Date(2026, 6, 1).toISOString() }];
  const promptRows = [prompt(new Date(2026, 3, 1).toISOString(), 'a@x.com')];
  const { cohorts } = cohortRetention(users, promptRows, now);
  assert.equal(cohorts[0].cells[0].active, 0);
  assert.ok(cohorts[0].cells.every((c) => c.offset >= 0));
});

test('cohortRetention: unattributed renders and undated accounts drop out cleanly', () => {
  const now = new Date(2026, 6, 20).getTime();
  const users = [
    { id: 'u1', email: 'a@x.com', createdAt: new Date(2026, 6, 1).toISOString() },
    { id: 'u2', email: 'b@x.com', createdAt: 'not-a-date' },
  ];
  const promptRows = [prompt(new Date(2026, 6, 5).toISOString(), 'unknown')];
  const { cohorts } = cohortRetention(users, promptRows, now);
  assert.equal(cohorts.length, 1, 'the undated account forms no cohort');
  assert.equal(cohorts[0].size, 1);
  assert.equal(cohorts[0].cells[0].active, 0, 'an anonymous render retains nobody');
});

test('cohortRetention: no users at all yields an empty grid, not a crash', () => {
  const { cohorts, maxOffset } = cohortRetention([], [], Date.now());
  assert.deepEqual(cohorts, []);
  assert.equal(maxOffset, 0);
});
