// Per-account aggregation for the admin dashboard: when each user was last
// active, the signup→activation→paid funnel, and cohort retention. Pure, no DOM;
// unit-tested in test/frontend/admin/admin-analytics-users.test.js.
//
// Split from analytics.js because these all share one awkward property that the
// time-series aggregators don't: **activity is recorded under two different
// identifiers.** Render rows carry an email; chat and mask rows carry a userId.
// So "is this account active" means joining on both, which is what
// `buildActivityIndex` exists to do once instead of at every call site.
//
// ── The attribution caveat, which every number here inherits ──
// A render row's email comes from the request body and is `unknown` whenever the
// client didn't send one, so a large share of renders cannot be tied to an
// account at all. Those renders are real usage that no funnel or cohort here can
// see. `attributionCoverage` measures the gap so the UI can state it plainly
// rather than quietly under-reporting; read every activation and retention
// number as **a floor, not a count**.

import { COL, toDate, stripHeader, monthKeyLocal } from './analytics.js';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lc(v) { return String(v || '').trim().toLowerCase(); }

/** True for the sentinels the log writers use when they have no identity. */
function isRealId(v) {
  const s = lc(v);
  return Boolean(s) && s !== 'unknown';
}

/**
 * Fold every activity signal into two lookup maps plus per-account render counts.
 *
 * `byEmail` / `byUserId` hold the newest activity timestamp (ms) seen under that
 * identifier; `rendersByEmail` counts attributed renders, which the funnel needs
 * to tell a one-off from a repeat user.
 *
 * @param {{promptRows?: string[][], chatRows?: string[][], maskRows?: string[][]}} tables Header-stripped CSV tables.
 * @returns {{byEmail: Record<string, number>, byUserId: Record<string, number>, rendersByEmail: Record<string, number>}}
 */
export function buildActivityIndex(tables) {
  /** @type {Record<string, number>} */
  const byEmail = {};
  /** @type {Record<string, number>} */
  const byUserId = {};
  /** @type {Record<string, number>} */
  const rendersByEmail = {};

  const note = (map, key, value) => {
    const d = toDate(value);
    if (!d) return;
    const ms = d.getTime();
    if (!map[key] || ms > map[key]) map[key] = ms;
  };

  (tables.promptRows || []).forEach((r) => {
    const email = lc(r[COL.PROMPT.EMAIL]);
    if (!isRealId(email)) return;
    rendersByEmail[email] = (rendersByEmail[email] || 0) + 1;
    note(byEmail, email, r[COL.PROMPT.TS]);
  });
  (tables.chatRows || []).forEach((r) => {
    const id = String(r[COL.CHAT.USER_ID] || '').trim();
    if (!isRealId(id)) return;
    note(byUserId, id, r[COL.CHAT.TS]);
  });
  (tables.maskRows || []).forEach((r) => {
    const id = String(r[COL.MASK.USER_ID] || '').trim();
    if (!isRealId(id)) return;
    note(byUserId, id, r[COL.MASK.TS]);
  });

  return { byEmail, byUserId, rendersByEmail };
}

/**
 * Convenience wrapper: strip the headers and build the index in one call.
 * @param {{promptRows?: string[][], chatRows?: string[][], maskRows?: string[][]}} raw
 */
export function activityIndexFrom(raw) {
  return buildActivityIndex({
    promptRows: stripHeader(raw.promptRows || []),
    chatRows: stripHeader(raw.chatRows || []),
    maskRows: stripHeader(raw.maskRows || []),
  });
}

/**
 * Newest activity for one account across both identifiers, or null if it has
 * never appeared in any log.
 * @param {any} user
 * @param {ReturnType<typeof buildActivityIndex>} index
 * @returns {number|null} Epoch ms.
 */
export function lastActiveMs(user, index) {
  if (!user) return null;
  const byEmail = index.byEmail[lc(user.email)];
  const byId = index.byUserId[String(user.id || '').trim()];
  const best = Math.max(byEmail || 0, byId || 0);
  return best > 0 ? best : null;
}

/**
 * Whole days since an account was last active — 0 for today, null for never.
 * @param {any} user
 * @param {ReturnType<typeof buildActivityIndex>} index
 * @param {number} [now] Epoch ms; injectable so tests aren't clock-dependent.
 * @returns {number|null}
 */
export function daysSinceActive(user, index, now) {
  const ms = lastActiveMs(user, index);
  if (ms === null) return null;
  const ref = typeof now === 'number' ? now : Date.now();
  return Math.max(0, Math.floor((ref - ms) / (24 * 60 * 60 * 1000)));
}

/**
 * How much of the render log can be tied to an account at all. The funnel and
 * the cohort grid are only as complete as this number.
 * @param {string[][]} promptRows Header-stripped.
 * @returns {{total: number, attributed: number, pct: number}}
 */
export function attributionCoverage(promptRows) {
  const rows = promptRows || [];
  const attributed = rows.filter((r) => isRealId(r[COL.PROMPT.EMAIL])).length;
  return { total: rows.length, attributed, pct: rows.length ? (attributed / rows.length) * 100 : 0 };
}

/**
 * The usage ladder: accounts → activated → repeat → power user, as absolute
 * counts with the conversion from the previous step.
 *
 * Every step is a strict subset of the one above it (2+ renders implies 1+), so
 * the funnel can only narrow — a widening step means a counting bug, and
 * `funnelMonotonic` asserts exactly that.
 *
 * **Paid is deliberately NOT a step here.** Paying is a parallel outcome, not a
 * deeper stage of usage: a subscriber whose renders all logged anonymously is
 * "paid" but not "activated", which really happens — on live data the paid count
 * exceeded the activated count, which would have rendered as a funnel step
 * growing wider than its parent. Use {@link paidConversion} for that number and
 * present it separately.
 *
 * @param {any[]} users
 * @param {ReturnType<typeof buildActivityIndex>} index
 * @returns {Array<{label: string, value: number, pctOfPrev: number|null, pctOfTop: number}>}
 */
export function activationFunnel(users, index) {
  const list = users || [];
  const renders = (u) => index.rendersByEmail[lc(u.email)] || 0;
  const steps = [
    { label: 'Accounts', value: list.length },
    { label: 'Activated (1+ render)', value: list.filter((u) => renders(u) >= 1).length },
    { label: 'Repeat (2+ renders)', value: list.filter((u) => renders(u) >= 2).length },
    { label: 'Power user (5+ renders)', value: list.filter((u) => renders(u) >= 5).length },
  ];
  const top = steps[0].value;
  return steps.map((s, i) => ({
    ...s,
    pctOfPrev: i === 0 || steps[i - 1].value === 0 ? null : (s.value / steps[i - 1].value) * 100,
    pctOfTop: top ? (s.value / top) * 100 : 0,
  }));
}

/**
 * True if no step is wider than the one before it. The nesting guarantee of
 * {@link activationFunnel}, exposed so it can be asserted rather than assumed.
 * @param {Array<{value: number}>} steps
 * @returns {boolean}
 */
export function funnelMonotonic(steps) {
  return (steps || []).every((s, i) => i === 0 || s.value <= steps[i - 1].value);
}

/**
 * Paying accounts as a share of all accounts — the conversion the funnel above
 * deliberately leaves out, because it does not nest inside the usage ladder.
 * @param {any[]} users
 * @param {(u: any) => string} planOf Effective-plan resolver (folds in enterprise domains).
 * @returns {{paid: number, total: number, pct: number}}
 */
export function paidConversion(users, planOf) {
  const list = users || [];
  const paid = list.filter((u) => { const p = planOf(u); return p === 'pro' || p === 'enterprise'; }).length;
  return { paid, total: list.length, pct: list.length ? (paid / list.length) * 100 : 0 };
}

/**
 * Monthly signup cohorts × months since signup, as the share of the cohort that
 * rendered something in that month.
 *
 * Only months that have actually elapsed get a cell: a cohort from last month
 * has no month-3 yet, and rendering that as 0% would read as total churn rather
 * than as "hasn't happened". Cohorts with no attributable members are dropped
 * entirely for the same reason.
 *
 * @param {any[]} users
 * @param {string[][]} promptRows Header-stripped.
 * @param {number} [now] Epoch ms; injectable for tests.
 * @returns {{cohorts: Array<{key: string, label: string, size: number, cells: Array<{offset: number, active: number, pct: number}>}>, maxOffset: number}}
 */
export function cohortRetention(users, promptRows, now) {
  const ref = new Date(typeof now === 'number' ? now : Date.now());

  // email → signup month, for the accounts we can place in a cohort at all.
  /** @type {Record<string, string>} */
  const cohortOfEmail = {};
  /** @type {Record<string, string[]>} */
  const membersOf = {};
  (users || []).forEach((u) => {
    const email = lc(u.email);
    const key = monthKeyLocal(u.createdAt);
    if (!email || !key) return;
    cohortOfEmail[email] = key;
    (membersOf[key] = membersOf[key] || []).push(email);
  });

  // cohortKey → monthOffset → set of emails active that month.
  /** @type {Record<string, Record<number, Record<string, true>>>} */
  const active = {};
  (promptRows || []).forEach((r) => {
    const email = lc(r[COL.PROMPT.EMAIL]);
    const cohort = cohortOfEmail[email];
    if (!cohort) return;
    const when = monthKeyLocal(r[COL.PROMPT.TS]);
    if (!when) return;
    const offset = monthDiff(cohort, when);
    if (offset < 0) return; // activity before signup — clock skew or a re-used address
    active[cohort] = active[cohort] || {};
    active[cohort][offset] = active[cohort][offset] || {};
    active[cohort][offset][email] = true;
  });

  const nowKey = monthKeyLocal(ref);
  const keys = Object.keys(membersOf).sort();
  let maxOffset = 0;
  const cohorts = keys.map((key) => {
    const size = membersOf[key].length;
    const elapsed = monthDiff(key, /** @type {string} */ (nowKey));
    if (elapsed > maxOffset) maxOffset = elapsed;
    const cells = [];
    for (let offset = 0; offset <= elapsed; offset++) {
      const n = Object.keys((active[key] && active[key][offset]) || {}).length;
      cells.push({ offset, active: n, pct: size ? (n / size) * 100 : 0 });
    }
    return { key, label: labelMonthKey(key), size, cells };
  }).filter((c) => c.size > 0);

  return { cohorts, maxOffset };
}

/** Whole months between two `YYYY-MM` keys. @returns {number} */
function monthDiff(fromKey, toKey) {
  const [fy, fm] = String(fromKey).split('-').map(Number);
  const [ty, tm] = String(toKey).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function labelMonthKey(key) {
  const parts = String(key).split('-');
  return MONTH_LABELS[Number(parts[1]) - 1] + " '" + String(parts[0]).slice(2);
}
