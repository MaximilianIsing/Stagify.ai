// Aggregation over rejection_logs.csv — the requests that were turned away
// BEFORE a render ran. Pure, no DOM; unit-tested in
// test/frontend/admin/admin-analytics-rejections.test.js.
//
// WHY THIS IS A SEPARATE TABLE, AND MUST STAY ONE. lib/services/logging.js is
// explicit that a refusal is not a generation: every row in prompt_logs.csv is
// counted as one, so folding refusals in would inflate both the headline volume
// and the success rate with work that never happened. Nothing here may be summed
// against a render count without saying so — these cards carry their own
// denominator.
//
// WHY IT LIVES HERE RATHER THAN IN analytics.js. That file is at its 650-line
// cap; only the COL.REJECTION map went in, beside the other column maps it has
// to stay next to.
//
// ── The empty case is the normal case ──
// A fresh install has never refused anything, and the loader turns the resulting
// 404 into an empty string. So "no rows" means "nothing recorded", never "a
// refusal rate of zero" — every function here returns an empty series rather
// than a row of zeroes, and the UI is responsible for saying which it is.

import { COL, dayKeyLocal, dailyCounts, topValues, categoryKey } from './analytics.js';

/**
 * Rate limiters whose bounces are FAILED SECRETS, not customers being turned away.
 *
 * Both of these fire only on a wrong credential — `endpoint_key` guards the admin
 * console and the staging endpoint key (lib/http/http-guards.js), `api_key_reject`
 * fires only on an invalid API key (lib/http/api-key-auth.js), and a valid key
 * never touches either bucket. So a hit here is someone guessing, or an operator
 * fat-fingering their own key.
 *
 * They are separated because on live data they DWARF everything else — 1,682 of
 * 1,699 recorded refusals on the first dataset this was pointed at — and mixing
 * them in is wrong twice over: it buries the handful of real customer refusals
 * under operator noise, and it hides a security signal inside a funnel chart.
 * Read `customerRefusals` for drop-off and `credentialGuardHits` for the other.
 */
export const CREDENTIAL_GUARD_CODES = Object.freeze(['endpoint_key', 'api_key_reject']);

const GUARD_SET = new Set(CREDENTIAL_GUARD_CODES);

/** True for a row that is a failed-credential bounce rather than a refused customer. */
function isCredentialGuard(r) {
  return categoryKey(r && r[COL.REJECTION.KIND]) === 'rate_limit'
    && GUARD_SET.has(categoryKey(r && r[COL.REJECTION.CODE]));
}

/**
 * Refusals that actually cost someone work — everything except the
 * credential-guard bounces above. This is the drop-off funnel.
 * @param {string[][]} rows
 * @returns {string[][]}
 */
export function customerRefusals(rows) {
  return (rows || []).filter((r) => !isCredentialGuard(r));
}

/**
 * The complement: failed-credential attempts, which are a security reading of the
 * same file rather than a product one.
 * @param {string[][]} rows
 * @returns {string[][]}
 */
export function credentialGuardHits(rows) {
  return (rows || []).filter(isCredentialGuard);
}

/** The coarse buckets `logRejectionToFile` writes, with the label each gets. */
const KIND_LABELS = {
  unstageable: 'Photo refused',
  daily_limit: 'Daily cap reached',
  rate_limit: 'Rate limited',
  api_concurrency: 'API busy',
  file_too_large: 'File too large',
};

/** Human label for a `kind`, falling back to the raw value for a future writer. */
function kindLabel(raw) {
  const key = categoryKey(raw);
  return KIND_LABELS[key] || String(raw || '').trim() || 'Unknown';
}

function lc(v) { return String(v === null || v === undefined ? '' : v).trim().toLowerCase(); }

/** True unless the writer had no identity for the row. */
function isRealId(v) {
  const s = lc(v);
  return Boolean(s) && s !== 'unknown';
}

/** Rows whose `kind` matches, compared through categoryKey. */
export function ofKind(rows, kind) {
  const want = categoryKey(kind);
  return (rows || []).filter((r) => categoryKey(r && r[COL.REJECTION.KIND]) === want);
}

/**
 * Refusals per day for the last `days` days, zero-filled.
 *
 * Zero-filled like every other daily series: within a window that HAS rows, a
 * quiet day is a measured zero and must render flat rather than as a gap. That
 * is a different statement from "this file is empty", which is why the caller
 * checks `rows.length` before drawing at all.
 * @param {string[][]} rows Header-stripped rejection rows.
 * @param {number} [days]
 * @returns {{key: string, label: string, value: number}[]}
 */
export function rejectionsByDay(rows, days = 30) {
  return dailyCounts((rows || []).map((r) => r && r[COL.REJECTION.TS]), days);
}

/**
 * How the refusals split across the coarse `kind` buckets, counting ROWS.
 * @param {string[][]} rows
 * @returns {{label: string, value: number}[]}
 */
export function rejectionMix(rows) {
  /** @type {Record<string, number>} */
  const tally = {};
  (rows || []).forEach((r) => {
    const key = categoryKey(r && r[COL.REJECTION.KIND]);
    if (!key) return;
    tally[key] = (tally[key] || 0) + 1;
  });
  return Object.keys(tally)
    .map((k) => ({ label: kindLabel(k), value: tally[k] }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/**
 * The specific reasons within one kind — the unstageable category codes, or the
 * limiter names for `rate_limit`.
 *
 * Scoped to a single kind on purpose: CODE means something different in each
 * bucket (a rejection category in one, a limiter name in another), so a chart
 * mixing them would put two vocabularies on one axis.
 * @param {string[][]} rows
 * @param {string} kind
 * @param {{top?: number}} [opts]
 * @returns {{label: string, value: number}[]}
 */
export function topReasons(rows, kind, opts = {}) {
  return topValues(ofKind(rows, kind), COL.REJECTION.CODE, opts);
}

/**
 * Accounts that hit the daily cap on the most SEPARATE days.
 *
 * Days, not hits: someone who retried eight times in one evening ran into the
 * cap once and learnt what it was. Someone blocked on four different days keeps
 * coming back and keeps being turned away, which is the actual upgrade signal —
 * and it is precisely what a snapshot of "who is at the cap today" cannot see.
 *
 * Counted per person, so it reads identity from the row rather than counting
 * rows: `email` where the session had one, `userId` otherwise. Rows with neither
 * cannot be attributed to anyone and are excluded — `capHitCoverage` reports how
 * many those were so the omission is visible rather than silent.
 *
 * @param {string[][]} rows Header-stripped rejection rows.
 * @param {{top?: number, days?: number}} [opts] `days` bounds the window; omit for all time.
 * @returns {{identity: string, days: number, hits: number, lastAt: string}[]} Newest-first by day count.
 */
export function capHitDaysByPerson(rows, opts = {}) {
  const top = opts.top === undefined ? 10 : opts.top;
  const cutoff = opts.days ? dayKeyLocal(new Date(Date.now() - opts.days * 86400000)) : null;
  /** @type {Record<string, {identity: string, days: Record<string, true>, hits: number, lastAt: string}>} */
  const byPerson = {};

  ofKind(rows, 'daily_limit').forEach((r) => {
    const email = r[COL.REJECTION.EMAIL];
    const userId = r[COL.REJECTION.USER_ID];
    const identity = isRealId(email) ? String(email).trim() : (isRealId(userId) ? String(userId).trim() : '');
    if (!identity) return;
    const day = dayKeyLocal(r[COL.REJECTION.TS]);
    if (!day) return;
    if (cutoff && day < cutoff) return;
    const key = lc(identity);
    const entry = byPerson[key] || (byPerson[key] = { identity, days: {}, hits: 0, lastAt: '' });
    entry.days[day] = true;
    entry.hits++;
    if (!entry.lastAt || day > entry.lastAt) entry.lastAt = day;
  });

  const all = Object.keys(byPerson).map((k) => ({
    identity: byPerson[k].identity,
    days: Object.keys(byPerson[k].days).length,
    hits: byPerson[k].hits,
    lastAt: byPerson[k].lastAt,
  }));
  all.sort((a, b) => b.days - a.days || b.hits - a.hits || a.identity.localeCompare(b.identity));
  return top > 0 ? all.slice(0, top) : all;
}

/**
 * What share of cap-hit rows could be tied to a person at all.
 *
 * Stated rather than assumed, for the same reason the activation funnel states
 * its attribution coverage: an anonymous refusal is real usage that the
 * per-person list structurally cannot see, so the list is a floor.
 * @param {string[][]} rows
 * @returns {{total: number, attributed: number, ratio: number|null}} `ratio` is null with nothing to divide.
 */
export function capHitCoverage(rows) {
  const capRows = ofKind(rows, 'daily_limit');
  const attributed = capRows.filter(
    (r) => isRealId(r[COL.REJECTION.EMAIL]) || isRealId(r[COL.REJECTION.USER_ID]),
  ).length;
  return {
    total: capRows.length,
    attributed,
    ratio: capRows.length ? attributed / capRows.length : null,
  };
}
