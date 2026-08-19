// Pure data aggregation for the admin dashboard charts. No DOM, no app state —
// every export is a plain function over the parsed CSV rows / auth-store users,
// so the whole module is unit-tested in test/frontend/admin/admin-analytics.test.js.
//
// Two things here are deliberate and easy to get wrong if you touch them:
//
//  1. **Day keys are LOCAL, not UTC.** The dashboard is read by a human in one
//     timezone, so "today" must mean their today. Building bucket keys with
//     `toISOString().slice(0,10)` looks equivalent but silently shifts every row
//     by a day for anyone east of UTC (local midnight is 22:00 UTC the day
//     before). `dayKeyLocal` formats from the local getFullYear/getMonth/getDate
//     triple instead, and every bucketer goes through it.
//  2. **The CSV header row is data to `parseCSV`.** Every log file this module
//     sees starts with a `timestamp,…` header line; left in, it inflates totals
//     by one and lands in the "unparseable" bucket. `stripHeader` drops it, and
//     callers are expected to run rows through it once at load time.

/**
 * One chart bucket. `label` is the verbose form a tooltip shows ("Week of Jul
 * 20"); `short` is the compact form the x-axis draws when they differ, because
 * an axis has a few dozen user-space units per tick and a verbose label there
 * collides with its neighbours.
 * @typedef {{key: string, label: string, short?: string, value: number}} SeriesPoint
 */
/** @typedef {{label: string, value: number}} Slice */

/**
 * CSV column indices, in one place because every consumer addresses these files
 * positionally. Mirrors the writers: `lib/services/logging.js` (prompt/chat/mask),
 * `routes/public.js` (contact/bug), `lib/services/email.js` (opens). The five
 * outcome columns on a render row were APPENDED, so a row written before they
 * existed still reads correctly — its outcome cells are simply empty.
 * Documented in docs/guides/admin-dashboard.md.
 *
 * PROMPT.ROLE (5) and PROMPT.REFERRAL (6) are INERT — always 'unknown' and ''.
 * public/scripts/app/staging-pipeline.js reads them from localStorage keys that
 * nothing in public/ ever writes (see the note there), so they have never carried
 * data. They keep their indices because this file reads the CSV positionally and
 * removing a column would shift EMAIL out from 7 and corrupt every historical row.
 * CONTACT.ROLE/REFERRAL are equally inert for a different reason: nothing in
 * public/ posts to /api/log-contact at all, so contact_logs.csv has no writer.
 * Treat all four as empty until an onboarding capture actually fills them.
 * findings-quality.js#inertColumns reports all four, so the charts built on them
 * are labelled as decorative rather than quietly read as "no data yet".
 *
 * PROMPT.DRIFT (14) and PROMPT.SEED (15) were appended to the writer after this
 * map was written and went unread for their first weeks in production — the
 * header in lib/services/logging.js carries 16 columns, this carried 14. DRIFT
 * is a per-render quality-defect flag ('yes' | 'no' | '' where empty means the
 * question was never asked, NOT that the render was clean); SEED is the base
 * generation seed, kept so a bad render can be re-run rather than charted.
 */
export const COL = {
  PROMPT: { TS: 0, ROOM: 1, STYLE: 2, REMOVE: 4, ROLE: 5, REFERRAL: 6, EMAIL: 7, STATUS: 9, DURATION: 10, MODEL: 11, ATTEMPTS: 12, ERROR: 13, DRIFT: 14, SEED: 15 },
  CHAT: { TS: 0, USER_ID: 1 },
  MASK: { TS: 0, MODEL: 3, USER_ID: 6 },
  CONTACT: { TS: 0, ROLE: 1, REFERRAL: 2, EMAIL: 3 },
  // rejection_logs.csv — requests refused BEFORE a render ran. Deliberately a
  // separate table from PROMPT: every row there is counted as a generation, so
  // folding refusals in would inflate both the headline volume and the success
  // rate with work that never happened. KIND is the coarse bucket
  // ('unstageable' | 'daily_limit' | 'rate_limit' | 'api_concurrency'); CODE is
  // the specific reason within it, and for a rate_limit row that is the LIMITER
  // NAME rather than an error code. The aggregators live in
  // analytics-rejections.js, not here — this file is at its line cap.
  REJECTION: { TS: 0, KIND: 1, CODE: 2, DETAIL: 3, EMAIL: 4, USER_ID: 5 },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Parsing / keys ──────────────────────────────────────────────────────────

/**
 * Drop the CSV header line. All five admin log files start with `timestamp`, so
 * that first cell is the marker; anything else is left untouched (an already
 * stripped table, or an empty one, passes through).
 * @param {string[][]} rows
 * @returns {string[][]}
 */
export function stripHeader(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const first = rows[0] && rows[0][0];
  return String(first || '').trim().toLowerCase() === 'timestamp' ? rows.slice(1) : rows;
}

/**
 * Parse to a Date, or null when the value is missing/unparseable. Everything in
 * this module funnels timestamps through here so one bad CSV cell can never
 * throw mid-render.
 * @param {any} value
 * @returns {Date|null}
 */
export function toDate(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/**
 * `YYYY-MM-DD` in the viewer's timezone (see the module header on why not UTC).
 * @param {any} value
 * @returns {string|null}
 */
export function dayKeyLocal(value) {
  const d = toDate(value);
  if (!d) return null;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * `YYYY-MM` in the viewer's timezone.
 * @param {any} value
 * @returns {string|null}
 */
export function monthKeyLocal(value) {
  const d = toDate(value);
  if (!d) return null;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

/**
 * The local-midnight Date of the Monday starting that value's week. Weeks are
 * Monday-based so a weekly bucket reads as a work week.
 * @param {any} value
 * @returns {Date|null}
 */
export function weekStartLocal(value) {
  const d = toDate(value);
  if (!d) return null;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const shift = (start.getDay() + 6) % 7; // Mon=0 … Sun=6
  start.setDate(start.getDate() - shift);
  return start;
}

/** Local midnight `n` days back from today. @param {number} n @returns {Date} */
export function startOfDaysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function labelDay(key) {
  const parts = String(key).split('-');
  return MONTH_LABELS[Number(parts[1]) - 1] + ' ' + Number(parts[2]);
}
function labelMonth(key) {
  const parts = String(key).split('-');
  return MONTH_LABELS[Number(parts[1]) - 1] + ' ' + String(parts[0]).slice(2);
}

// ── Time series ─────────────────────────────────────────────────────────────

/**
 * Zero-filled daily counts for the last `days` days, oldest first and always
 * exactly `days` long — a quiet stretch has to render as a flat run of zeros,
 * not as a gap the chart would interpolate over.
 * @param {any[]} timestamps Raw values (ISO strings, Dates); junk is skipped.
 * @param {number} [days]
 * @returns {SeriesPoint[]}
 */
export function dailyCounts(timestamps, days = 30) {
  const n = Math.max(1, Math.floor(days));
  /** @type {Record<string, number>} */
  const buckets = {};
  /** @type {string[]} */
  const order = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = dayKeyLocal(startOfDaysAgo(i));
    if (key) { buckets[key] = 0; order.push(key); }
  }
  (timestamps || []).forEach((t) => {
    const key = dayKeyLocal(t);
    if (key && buckets[key] !== undefined) buckets[key]++;
  });
  return order.map((key) => ({ key, label: labelDay(key), value: buckets[key] }));
}

/**
 * Pick the bucket width for an all-time chart from how much history exists.
 * Thresholds keep the point count roughly in the 20–90 band at every scale, so
 * the same chart stays readable on week one and on year three.
 * @param {number} spanDays
 * @returns {'day'|'week'|'month'}
 */
export function pickGranularity(spanDays) {
  if (spanDays <= 70) return 'day';
  if (spanDays <= 550) return 'week';
  return 'month';
}

/**
 * Every bucket from the first recorded event to today, gaps zero-filled, at an
 * automatically chosen granularity. Empty input yields an empty series rather
 * than a fake single point.
 * @param {any[]} timestamps
 * @param {'day'|'week'|'month'} [force] Override the automatic granularity.
 * @returns {{granularity: 'day'|'week'|'month', points: SeriesPoint[]}}
 */
export function allTimeCounts(timestamps, force) {
  const dates = (timestamps || []).map(toDate).filter(Boolean);
  if (!dates.length) return { granularity: 'day', points: [] };

  let min = dates[0];
  dates.forEach((d) => { if (d < min) min = d; });
  const now = new Date();
  const max = now > min ? now : min;

  const spanDays = Math.floor((max.getTime() - min.getTime()) / DAY_MS);
  const granularity = force || pickGranularity(spanDays);

  /** @type {Record<string, number>} */
  const buckets = {};
  /** @type {string[]} */
  const order = [];
  const push = (key) => { if (buckets[key] === undefined) { buckets[key] = 0; order.push(key); } };

  if (granularity === 'month') {
    const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
    const end = new Date(max.getFullYear(), max.getMonth(), 1);
    while (cursor <= end) {
      push(cursor.getFullYear() + '-' + pad2(cursor.getMonth() + 1));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    dates.forEach((d) => { const k = monthKeyLocal(d); if (k && buckets[k] !== undefined) buckets[k]++; });
    return { granularity, points: order.map((key) => ({ key, label: labelMonth(key), value: buckets[key] })) };
  }

  const step = granularity === 'week' ? 7 : 1;
  const cursor = granularity === 'week'
    ? /** @type {Date} */ (weekStartLocal(min))
    : new Date(min.getFullYear(), min.getMonth(), min.getDate());
  const end = granularity === 'week'
    ? /** @type {Date} */ (weekStartLocal(max))
    : new Date(max.getFullYear(), max.getMonth(), max.getDate());
  while (cursor <= end) {
    push(/** @type {string} */ (dayKeyLocal(cursor)));
    cursor.setDate(cursor.getDate() + step);
  }
  dates.forEach((d) => {
    const k = granularity === 'week' ? dayKeyLocal(weekStartLocal(d)) : dayKeyLocal(d);
    if (k && buckets[k] !== undefined) buckets[k]++;
  });
  return {
    granularity,
    points: order.map((key) => ({
      key,
      label: granularity === 'week' ? 'Week of ' + labelDay(key) : labelDay(key),
      short: labelDay(key),
      value: buckets[key],
    })),
  };
}

/**
 * Running total of a series — the "total accounts over time" curve behind a
 * "signups per week" bar chart.
 * @param {SeriesPoint[]} points
 * @returns {SeriesPoint[]}
 */
export function cumulative(points) {
  let running = 0;
  return (points || []).map((p) => {
    running += p.value || 0;
    return { key: p.key, label: p.label, short: p.short, value: running };
  });
}

/**
 * Count in the trailing `days` window vs. the window immediately before it, plus
 * the percentage change. `deltaPct` is null when the prior window was empty —
 * "up from zero" is not a percentage, and rendering it as +100% would be a lie.
 * @param {any[]} timestamps
 * @param {number} days
 * @returns {{current: number, previous: number, deltaPct: number|null}}
 */
export function windowDelta(timestamps, days) {
  const n = Math.max(1, Math.floor(days));
  const currentStart = startOfDaysAgo(n - 1).getTime();
  const previousStart = startOfDaysAgo(n * 2 - 1).getTime();
  let current = 0;
  let previous = 0;
  (timestamps || []).forEach((t) => {
    const d = toDate(t);
    if (!d) return;
    const ms = d.getTime();
    if (ms >= currentStart) current++;
    else if (ms >= previousStart) previous++;
  });
  return { current, previous, deltaPct: previous > 0 ? ((current - previous) / previous) * 100 : null };
}

// ── Distributions ───────────────────────────────────────────────────────────

/**
 * Fold a value to its grouping key: lower-cased, with runs of whitespace
 * collapsed. These columns are free text assembled by several client versions,
 * so "Living room", "Living Room" and "Living  room" are one category that must
 * not chart as three.
 * @param {any} value
 * @returns {string}
 */
export function categoryKey(value) {
  return String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Sort a {key → {label, value}} tally and fold everything past `top` into one
// bucket. The fold label is BUILT to be unique ("Other (3 more)") rather than a
// bare "Other": several of these columns contain a genuine category called
// "Other", and a fixed label collided with it — the chart then showed two rows
// both labelled Other, one real and one synthetic.
function rankTally(tally, top) {
  const all = Object.keys(tally)
    .map((k) => ({ label: tally[k].label, value: tally[k].value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (top <= 0 || all.length <= top) return all;
  const head = all.slice(0, top);
  const rest = all.slice(top);
  const tail = rest.reduce((sum, s) => sum + s.value, 0);
  if (tail > 0) head.push({ label: 'Other (' + rest.length + ' more)', value: tail });
  return head;
}

// Track the spellings seen for one grouping key and surface the most common one,
// so the chart shows the label people actually see rather than an arbitrary
// first-wins or a machine-lowercased version.
function addSpelling(tally, key, raw, weight) {
  const entry = tally[key] || (tally[key] = { label: raw, value: 0, spellings: {} });
  entry.value += weight;
  entry.spellings[raw] = (entry.spellings[raw] || 0) + 1;
  if (entry.spellings[raw] > (entry.spellings[entry.label] || 0)) entry.label = raw;
}

/**
 * Top-N distribution of one CSV column, counting ROWS. Values are grouped
 * case- and whitespace-insensitively (see {@link categoryKey}); blank and
 * `unknown` cells are skipped rather than charted as a category.
 * @param {string[][]} rows
 * @param {number} index Column to count.
 * @param {{top?: number}} [opts]
 * @returns {Slice[]}
 */
export function topValues(rows, index, opts = {}) {
  const top = opts.top === undefined ? 8 : opts.top;
  /** @type {Record<string, {label: string, value: number, spellings: Record<string, number>}>} */
  const tally = {};
  (rows || []).forEach((r) => {
    const raw = String((r && r[index]) || '').trim().replace(/\s+/g, ' ');
    const key = categoryKey(raw);
    if (!key || key === 'unknown') return;
    addSpelling(tally, key, raw, 1);
  });
  return rankTally(tally, top);
}

/**
 * Top-N distribution counting **distinct people** instead of rows.
 *
 * The onboarding answers (role, referral source) are per-person attributes that
 * the client replays onto every render row, so counting rows over the render log
 * reports render volume weighted by heavy users — tens of thousands of "people"
 * from a few hundred actual answers. Pass the table that holds one row per
 * answer and the column identifying the person.
 *
 * Rows with no usable identity can't be deduplicated, so each counts once; that
 * is a ceiling on those, and the only alternative (dropping them) is a floor.
 *
 * @param {string[][]} rows
 * @param {number} index Column to count.
 * @param {number} identityIndex Column identifying the person (usually an email).
 * @param {{top?: number}} [opts]
 * @returns {Slice[]}
 */
export function topValuesByPerson(rows, index, identityIndex, opts = {}) {
  const top = opts.top === undefined ? 8 : opts.top;
  /** @type {Record<string, {label: string, value: number, spellings: Record<string, number>, seen: Record<string, true>}>} */
  const tally = {};
  (rows || []).forEach((r) => {
    const raw = String((r && r[index]) || '').trim().replace(/\s+/g, ' ');
    const key = categoryKey(raw);
    if (!key || key === 'unknown') return;
    const identity = categoryKey(r && r[identityIndex]);
    const entry = tally[key];
    if (entry && identity && identity !== 'unknown' && entry.seen[identity]) {
      // Same person answering twice — record the spelling, not a second person.
      entry.spellings[raw] = (entry.spellings[raw] || 0) + 1;
      return;
    }
    addSpelling(tally, key, raw, 1);
    if (identity && identity !== 'unknown') tally[key].seen = Object.assign(tally[key].seen || {}, { [identity]: true });
    else tally[key].seen = tally[key].seen || {};
  });
  return rankTally(tally, top);
}

/**
 * Distinct people represented by a table, on the same identity rule as
 * {@link topValuesByPerson} — for stating what a per-person chart is counting.
 * @param {string[][]} rows
 * @param {number} identityIndex
 * @returns {number}
 */
export function distinctPeople(rows, identityIndex) {
  /** @type {Record<string, true>} */
  const seen = {};
  let anonymous = 0;
  (rows || []).forEach((r) => {
    const identity = categoryKey(r && r[identityIndex]);
    if (identity && identity !== 'unknown') seen[identity] = true;
    else anonymous++;
  });
  return Object.keys(seen).length + anonymous;
}

/**
 * 24 hourly buckets (local time), always full so the chart has a stable x-axis.
 * @param {any[]} timestamps
 * @returns {SeriesPoint[]}
 */
export function hourHistogram(timestamps) {
  const counts = new Array(24).fill(0);
  (timestamps || []).forEach((t) => { const d = toDate(t); if (d) counts[d.getHours()]++; });
  return counts.map((value, h) => ({
    key: String(h),
    label: (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm'),
    value,
  }));
}

/**
 * 7 weekday buckets, Monday first (matching {@link weekStartLocal}).
 * @param {any[]} timestamps
 * @returns {SeriesPoint[]}
 */
export function weekdayHistogram(timestamps) {
  const counts = new Array(7).fill(0);
  (timestamps || []).forEach((t) => { const d = toDate(t); if (d) counts[(d.getDay() + 6) % 7]++; });
  return counts.map((value, i) => ({ key: String(i), label: WEEKDAY_LABELS[(i + 1) % 7], value }));
}

/**
 * Plan split for the donut. `planOf` is injected because "effective plan" folds
 * in enterprise-domain membership, which lives in the renderer's context.
 * @param {any[]} users
 * @param {(u: any) => string} planOf
 * @returns {Slice[]}
 */
export function planMix(users, planOf) {
  const order = ['pro', 'enterprise', 'free'];
  /** @type {Record<string, number>} */
  const counts = { pro: 0, enterprise: 0, free: 0 };
  (users || []).forEach((u) => {
    const plan = String(planOf(u) || 'free');
    counts[plan] = (counts[plan] || 0) + 1;
  });
  const known = order.map((k) => ({ label: k === 'pro' ? 'Pro' : k === 'enterprise' ? 'Enterprise' : 'Free', value: counts[k] }));
  const extra = Object.keys(counts)
    .filter((k) => order.indexOf(k) === -1 && counts[k] > 0)
    .map((k) => ({ label: k, value: counts[k] }));
  return known.concat(extra).filter((s) => s.value > 0);
}

/**
 * Google Sign-In vs. email/password accounts.
 * @param {any[]} users
 * @returns {Slice[]}
 */
export function authMix(users) {
  let google = 0;
  let email = 0;
  (users || []).forEach((u) => { if (u && u.googleSub) google++; else email++; });
  return [{ label: 'Google', value: google }, { label: 'Email', value: email }].filter((s) => s.value > 0);
}

/**
 * Two-way split of a boolean-ish CSV column (`'true'` / anything else).
 * @param {string[][]} rows
 * @param {number} index
 * @param {string} trueLabel
 * @param {string} falseLabel
 * @returns {Slice[]}
 */
export function booleanMix(rows, index, trueLabel, falseLabel) {
  let yes = 0;
  let no = 0;
  (rows || []).forEach((r) => {
    if (String((r && r[index]) || '').trim().toLowerCase() === 'true') yes++;
    else no++;
  });
  return [{ label: trueLabel, value: yes }, { label: falseLabel, value: no }].filter((s) => s.value > 0);
}

/**
 * The single biggest bucket in a series, for the "peak day" caption under a
 * chart. Ties resolve to the earliest bucket; an all-zero series has no peak.
 * @param {SeriesPoint[]} points
 * @returns {SeriesPoint|null}
 */
export function peakPoint(points) {
  let best = null;
  (points || []).forEach((p) => { if (p.value > 0 && (!best || p.value > best.value)) best = p; });
  return best;
}

/**
 * Mean bucket value, rounded to one decimal. Used for the "avg / day" caption.
 * @param {SeriesPoint[]} points
 * @returns {number}
 */
export function averageValue(points) {
  if (!points || !points.length) return 0;
  const total = points.reduce((sum, p) => sum + (p.value || 0), 0);
  return Math.round((total / points.length) * 10) / 10;
}

// ── Render outcomes ─────────────────────────────────────────────────────────
//
// The outcome columns were added on 2026-07-26; every render logged before that
// has empty cells there. Those rows are **excluded** from all of the following
// rather than counted as failures — an unrecorded outcome is unknown, and
// treating it as a failure would invent an error spike across the entire history.

/**
 * Render rows that actually carry a recorded outcome.
 * @param {string[][]} rows
 * @returns {string[][]}
 */
export function withOutcome(rows) {
  return (rows || []).filter((r) => {
    const s = String((r && r[COL.PROMPT.STATUS]) || '').trim().toLowerCase();
    return s === 'ok' || s === 'failed';
  });
}

/**
 * Succeeded / failed split over the rows that recorded an outcome. `pct` is null
 * when nothing has been recorded yet — not 100, which would read as "all good".
 * @param {string[][]} rows
 * @returns {{ok: number, failed: number, recorded: number, unrecorded: number, pct: number|null}}
 */
export function successRate(rows) {
  const recordedRows = withOutcome(rows);
  let ok = 0;
  recordedRows.forEach((r) => { if (String(r[COL.PROMPT.STATUS]).trim().toLowerCase() === 'ok') ok++; });
  const recorded = recordedRows.length;
  return {
    ok,
    failed: recorded - ok,
    recorded,
    unrecorded: (rows || []).length - recorded,
    pct: recorded ? (ok / recorded) * 100 : null,
  };
}

/**
 * Daily counts of failed renders. Absolute rather than a success *percentage*:
 * a rate chart has to invent a value for days with no renders at all, and a flat
 * 0% on a quiet day is indistinguishable from a total outage.
 * @param {string[][]} rows
 * @param {number} [days]
 * @returns {SeriesPoint[]}
 */
export function failuresByDay(rows, days = 30) {
  const failed = withOutcome(rows).filter((r) => String(r[COL.PROMPT.STATUS]).trim().toLowerCase() === 'failed');
  return dailyCounts(failed.map((r) => r[COL.PROMPT.TS]), days);
}

/**
 * Nearest-rank percentile over a numeric sample. Returns null for an empty one.
 * @param {number[]} values
 * @param {number} p 0–100.
 * @returns {number|null}
 */
export function percentile(values, p) {
  const sorted = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Duration percentiles over the renders that recorded one, in milliseconds.
 * Successful renders only — a render that failed after 400ms would otherwise
 * flatter the latency numbers.
 * @param {string[][]} rows
 * @returns {{count: number, p50: number|null, p90: number|null, p95: number|null}}
 */
export function durationStats(rows) {
  const values = withOutcome(rows)
    .filter((r) => String(r[COL.PROMPT.STATUS]).trim().toLowerCase() === 'ok')
    .map((r) => Number(r[COL.PROMPT.DURATION]))
    .filter((v) => Number.isFinite(v) && v > 0);
  return { count: values.length, p50: percentile(values, 50), p90: percentile(values, 90), p95: percentile(values, 95) };
}

const DURATION_BUCKETS = [
  { label: '<5s', max: 5000 },
  { label: '5–10s', max: 10000 },
  { label: '10–20s', max: 20000 },
  { label: '20–30s', max: 30000 },
  { label: '30–60s', max: 60000 },
  { label: '60s+', max: Infinity },
];

/**
 * Histogram of successful-render durations over fixed buckets. Buckets are fixed
 * (not derived from the data) so the shape is comparable between refreshes.
 * @param {string[][]} rows
 * @returns {SeriesPoint[]}
 */
export function durationHistogram(rows) {
  const counts = DURATION_BUCKETS.map(() => 0);
  withOutcome(rows)
    .filter((r) => String(r[COL.PROMPT.STATUS]).trim().toLowerCase() === 'ok')
    .forEach((r) => {
      const v = Number(r[COL.PROMPT.DURATION]);
      if (!Number.isFinite(v) || v <= 0) return;
      for (let i = 0; i < DURATION_BUCKETS.length; i++) {
        if (v < DURATION_BUCKETS[i].max) { counts[i]++; return; }
      }
    });
  return DURATION_BUCKETS.map((b, i) => ({ key: b.label, label: b.label, value: counts[i] }));
}
