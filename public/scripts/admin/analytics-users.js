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
 * to tell a one-off from a repeat user. `firstRenderByEmail` holds the OLDEST
 * render instead — the only thing that can date an account's activation, which
 * `activationLagDays` measures against its signup.
 *
 * @param {{promptRows?: string[][], chatRows?: string[][], maskRows?: string[][]}} tables Header-stripped CSV tables.
 * @returns {{byEmail: Record<string, number>, byUserId: Record<string, number>, rendersByEmail: Record<string, number>, firstRenderByEmail: Record<string, number>}}
 */
export function buildActivityIndex(tables) {
  /** @type {Record<string, number>} */
  const byEmail = {};
  /** @type {Record<string, number>} */
  const byUserId = {};
  /** @type {Record<string, number>} */
  const rendersByEmail = {};
  /** @type {Record<string, number>} */
  const firstRenderByEmail = {};

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
    const first = toDate(r[COL.PROMPT.TS]);
    if (first && (!firstRenderByEmail[email] || first.getTime() < firstRenderByEmail[email])) {
      firstRenderByEmail[email] = first.getTime();
    }
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

  return { byEmail, byUserId, rendersByEmail, firstRenderByEmail };
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

/**
 * What happened to each trial, from the only trial state that exists locally.
 *
 * `plan` collapses trialing / active / past_due into `'pro'`, and a cancellation
 * overwrites it back to `'free'` while nulling the subscription id — so the database
 * cannot answer "how many trials converted". What it CAN answer comes from
 * `trialLifecycle`: `startAt` is stamped at checkout, and `sent.canceled` is stamped
 * when the win-back email goes out, which only happens on
 * `customer.subscription.deleted`. That timestamp is the single durable churn signal
 * the product has.
 *
 * Read these as a FLOOR, like the funnel above: a cancellation whose win-back email
 * failed to send leaves no flag, so `cancelled` under-reports rather than invents.
 * `activated` uses `lastStagedAt`, which every paid surface now writes.
 *
 * @param {any[]} users
 * @param {number} [now] Epoch ms; injectable for tests.
 * @param {number} [trialDays=7] Length of the trial, for the "still running" window.
 * @returns {{started: number, activated: number, cancelled: number, running: number, retained: number, activationPct: number, cancelPct: number}}
 */
export function trialOutcomes(users, now, trialDays = 7) {
  const ref = typeof now === 'number' ? now : Date.now();
  const windowMs = trialDays * 24 * 60 * 60 * 1000;

  let started = 0;
  let activated = 0;
  let cancelled = 0;
  let running = 0;
  let retained = 0;

  for (const u of users || []) {
    const tl = u && u.trialLifecycle;
    const startMs = tl && tl.startAt ? Date.parse(tl.startAt) : NaN;
    if (!Number.isFinite(startMs)) continue;
    started += 1;

    const stagedMs = u.lastStagedAt ? Date.parse(u.lastStagedAt) : NaN;
    if (Number.isFinite(stagedMs) && stagedMs >= startMs) activated += 1;

    const didCancel = Boolean(tl.sent && tl.sent.canceled);
    if (didCancel) cancelled += 1;

    const withinWindow = ref - startMs < windowMs;
    if (!didCancel && withinWindow) running += 1;
    // Past the window, still on pro, never cancelled → the trial converted and held.
    if (!didCancel && !withinWindow && u.plan === 'pro') retained += 1;
  }

  return {
    started,
    activated,
    cancelled,
    running,
    retained,
    activationPct: started ? (activated / started) * 100 : 0,
    cancelPct: started ? (cancelled / started) * 100 : 0,
  };
}

/**
 * Which lifecycle emails actually went out, as counts.
 *
 * The trial-ending reminder is the one worth watching: unlike the activation and
 * value mails it has NO sweep fallback — it fires only from the
 * `customer.subscription.trial_will_end` webhook, which has to be enabled on the
 * Stripe endpoint by hand. A zero here next to a non-zero `welcome` means the
 * highest-intent touch in the funnel is silently not being sent.
 *
 * @param {any[]} users
 * @returns {Array<{label: string, value: number}>}
 */
export function trialEmailsSent(users) {
  const keys = ['welcome', 'activation', 'value', 'ending', 'canceled'];
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const u of users || []) {
    const sent = u && u.trialLifecycle && u.trialLifecycle.sent;
    if (!sent) continue;
    for (const k of keys) if (sent[k]) counts[k] += 1;
  }
  return keys.map((k) => ({ label: k, value: counts[k] }));
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

// ── Per-account revenue, risk and cost ──────────────────────────────────────
//
// Everything above this line reads the CSV activity index, and therefore
// inherits its attribution gap: a render row's email comes from the request body
// and is `unknown` whenever the client didn't send one.
//
// The functions below deliberately prefer a DIFFERENT source where one exists.
// `lastStagedAt` / `lifetimeStaged` are stamped server-side by
// lib/services/auth-helpers.js#recordStagingActivity from the VALIDATED session
// account, so for a paid user they are ground truth rather than a floor. They
// are only written for `plan === 'pro'` (a free account has no trial to
// activate), which is exactly the population these rules are about.

const DAY = 24 * 60 * 60 * 1000;

/**
 * Accounts that are paying Stripe money right now.
 *
 * `stripeSubscriptionId` is what separates a subscriber from a comped account:
 * an admin grant sets `plan = 'pro'` but never writes a subscription id, and
 * `lib/data/pro-grants.js` explicitly refuses to overwrite one. So a `pro` with
 * no subscription id is a comp (see {@link expiringCompGrants}), and a `pro`
 * with one is revenue.
 *
 * Enterprise-domain members are **not** included. They are billed against the
 * domain's subscription, not their own, so counting them here would attribute
 * one contract's revenue to every mailbox under it.
 *
 * @param {any[]} users
 * @returns {any[]}
 */
export function payingAccounts(users) {
  return (users || []).filter((u) => u && u.plan === 'pro' && u.stripeSubscriptionId);
}

/**
 * The best available "last used the product" timestamp for one account.
 *
 * Takes the newest of two sources rather than choosing one, because each covers
 * what the other misses: `lastStagedAt` is session-keyed and cannot be missing
 * for a paid render, but is only written for `pro` accounts and only by the
 * staging surfaces; the CSV index also sees chat and mask activity, but loses
 * any render the client sent anonymously.
 *
 * @param {any} user
 * @param {ReturnType<typeof buildActivityIndex>} index
 * @returns {number|null} Epoch ms, or null if the account has never appeared anywhere.
 */
export function lastProductUseMs(user, index) {
  if (!user) return null;
  const stamped = toDate(user.lastStagedAt);
  const logged = lastActiveMs(user, index);
  const best = Math.max(stamped ? stamped.getTime() : 0, logged || 0);
  return best > 0 ? best : null;
}

/**
 * Paying accounts that have gone quiet — the revenue most likely to cancel next.
 *
 * An account that has NEVER been seen ranks above one that has merely lapsed:
 * someone who subscribed and never rendered anything is a refund request
 * waiting to happen, not a lull. They sort first, with `daysQuiet: null`.
 *
 * @param {any[]} users
 * @param {ReturnType<typeof buildActivityIndex>} index
 * @param {{now?: number, quietDays?: number}} [opts]
 * @returns {{quietDays: number, paying: number, atRisk: Array<{id: string, email: string, daysQuiet: number|null, neverUsed: boolean, lifetimeStaged: number}>}}
 */
export function atRiskPayingAccounts(users, index, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const quietDays = typeof opts.quietDays === 'number' ? opts.quietDays : 14;
  const paying = payingAccounts(users);

  const atRisk = paying
    .map((u) => {
      const ms = lastProductUseMs(u, index);
      return {
        id: String(u.id || ''),
        email: String(u.email || ''),
        daysQuiet: ms === null ? null : Math.max(0, Math.floor((now - ms) / DAY)),
        neverUsed: ms === null,
        lifetimeStaged: Number.isFinite(u.lifetimeStaged) ? u.lifetimeStaged : 0,
      };
    })
    .filter((row) => row.neverUsed || /** @type {number} */ (row.daysQuiet) >= quietDays)
    // Never-used first, then longest-quiet first.
    .sort((a, b) => {
      if (a.neverUsed !== b.neverUsed) return a.neverUsed ? -1 : 1;
      return (b.daysQuiet || 0) - (a.daysQuiet || 0);
    });

  return { quietDays, paying: paying.length, atRisk };
}

/**
 * Comped Stagify+ grants about to lapse.
 *
 * Worth its own rule because the expiry is applied **on read**
 * (`lib/data/pro-grants.js#applyGrantExpiry` runs inside `rowToUser`), so
 * nothing fires when one runs out: the account simply reads as `free` on its
 * next request and the person discovers it by hitting the daily cap. An already
 * expired grant is reported too, with a negative `daysLeft`, because the silent
 * downgrade is the event worth knowing about either way.
 *
 * A grant that has been revoked by hand, or that sits on an account which has
 * since bought a real subscription, is not reported — neither one is about to
 * surprise anybody.
 *
 * @param {any[]} users
 * @param {{now?: number, withinDays?: number}} [opts]
 * @returns {Array<{id: string, email: string, expiresAt: string, daysLeft: number}>}
 */
export function expiringCompGrants(users, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const withinDays = typeof opts.withinDays === 'number' ? opts.withinDays : 7;

  return (users || [])
    .filter((u) => u && u.proGrantExpiresAt && !u.proGrantRevokedAt && !u.stripeSubscriptionId)
    .map((u) => {
      const exp = toDate(u.proGrantExpiresAt);
      return exp && {
        id: String(u.id || ''),
        email: String(u.email || ''),
        expiresAt: u.proGrantExpiresAt,
        daysLeft: Math.floor((exp.getTime() - now) / DAY),
      };
    })
    .filter((row) => Boolean(row) && /** @type {any} */ (row).daysLeft <= withinDays)
    .sort((a, b) => /** @type {any} */ (a).daysLeft - /** @type {any} */ (b).daysLeft);
}

/**
 * How long accounts take to get their first render out, in days.
 *
 * Only accounts that HAVE activated are measured. Folding in the ones that never
 * did as some large number would conflate two different problems — a slow
 * onboarding and a dead signup — and would make the median move whenever an
 * unrelated batch of tyre-kickers arrived. The never-activated share is its own
 * rule.
 *
 * A first render dated before the account was created is dropped rather than
 * clamped to zero: it means the email was staging anonymously (or under an
 * earlier account) before signing up, which is not the lag being measured.
 *
 * @param {any[]} users
 * @param {ReturnType<typeof buildActivityIndex>} index
 * @returns {{median: number|null, sample: number, activated: number, accounts: number}}
 */
export function activationLagDays(users, index) {
  const list = users || [];
  const lags = [];
  let activated = 0;

  for (const u of list) {
    const first = index.firstRenderByEmail[lc(u && u.email)];
    if (!first) continue;
    activated += 1;
    const created = toDate(u.createdAt);
    if (!created) continue;
    const days = (first - created.getTime()) / DAY;
    if (days < 0) continue;
    lags.push(days);
  }

  lags.sort((a, b) => a - b);
  const mid = Math.floor(lags.length / 2);
  const med = !lags.length ? null : (lags.length % 2 ? lags[mid] : (lags[mid - 1] + lags[mid]) / 2);
  return { median: med, sample: lags.length, activated, accounts: list.length };
}

/**
 * Enterprise domains whose metered usage is far below their peers.
 *
 * Compared against the MEDIAN domain rather than the mean: these populations are
 * tiny and one large customer would drag a mean high enough to mark every other
 * contract as underused.
 *
 * Only `active`/`trialing` domains are considered — a cancelled domain using
 * nothing is not a churn risk, it is a completed churn.
 *
 * @param {any[]} domains
 * @param {{shareOfMedian?: number}} [opts] Fraction of the median below which a domain is flagged.
 * @returns {{active: number, median: number|null, underused: Array<{domain: string, companyName: string, usage: number}>}}
 */
export function enterpriseUsageSpread(domains, opts = {}) {
  const shareOfMedian = typeof opts.shareOfMedian === 'number' ? opts.shareOfMedian : 0.25;
  const active = (domains || []).filter((d) => d && (d.status === 'active' || d.status === 'trialing'));
  if (!active.length) return { active: 0, median: null, underused: [] };

  const usages = active.map((d) => (Number.isFinite(d.usageCount) ? d.usageCount : 0)).sort((a, b) => a - b);
  const mid = Math.floor(usages.length / 2);
  const med = usages.length % 2 ? usages[mid] : (usages[mid - 1] + usages[mid]) / 2;

  // With a median of zero nobody is below a share of it, and every domain would
  // tie at the bottom. That is a "nobody is using enterprise at all" finding,
  // which belongs to the caller, not a per-domain callout.
  const underused = med <= 0 ? [] : active
    .filter((d) => (Number.isFinite(d.usageCount) ? d.usageCount : 0) < med * shareOfMedian)
    .map((d) => ({
      domain: String(d.domain || ''),
      companyName: String(d.companyName || ''),
      usage: Number.isFinite(d.usageCount) ? d.usageCount : 0,
    }))
    .sort((a, b) => a.usage - b.usage);

  return { active: active.length, median: med, underused };
}
