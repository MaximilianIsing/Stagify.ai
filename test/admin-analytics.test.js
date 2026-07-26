// Tier: frontend island logic (no DOM) — public/scripts/admin/analytics.js.
//
// Every number on the admin dashboard's charts comes out of this module, so the
// risks it carries are quiet ones: an off-by-one window, a bucket key that lands
// a day early, a header row counted as a render. None of those throw — they just
// draw a wrong picture, which is worse. Hence the emphasis below on the two
// things a reviewer can't eyeball:
//
//   - **Local vs. UTC day keys.** `dayKeyLocal` must agree with the viewer's
//     calendar. A UTC-derived key is off by one for half the world for part of
//     the day, so the zero-fill and the "today" bucket are asserted against
//     locally-constructed Dates, never against ISO string prefixes.
//   - **Zero-fill.** A quiet day must render as a 0 bucket, not as a missing
//     one, or the chart interpolates across it and invents activity.
//
// Time-relative cases build their fixtures from `new Date()` rather than pinning
// a date, so the suite can't rot into a "passes until 2027" trap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripHeader, toDate, dayKeyLocal, monthKeyLocal, weekStartLocal, startOfDaysAgo,
  dailyCounts, pickGranularity, allTimeCounts, cumulative, windowDelta,
  topValues, hourHistogram, weekdayHistogram, planMix, authMix, booleanMix,
  peakPoint, averageValue,
} from '../public/scripts/admin/analytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A Date `n` days before now, at midday so a timezone offset can't shift the day. */
function daysBack(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

// ── Header + parsing ────────────────────────────────────────────────────────

test('stripHeader: drops the timestamp header, leaves a headerless table alone', () => {
  const header = ['timestamp', 'roomType'];
  const row = ['2026-07-20T10:00:00Z', 'kitchen'];
  assert.deepEqual(stripHeader([header, row]), [row]);
  assert.deepEqual(stripHeader([row]), [row]);
  assert.deepEqual(stripHeader([]), []);
  assert.deepEqual(stripHeader(/** @type {any} */ (null)), []);
  // Case and padding vary between writers; the marker match must survive both.
  assert.deepEqual(stripHeader([[' Timestamp '], row]), [row]);
});

test('toDate: passes Dates through, rejects junk instead of returning Invalid Date', () => {
  const d = new Date('2026-07-20T10:00:00Z');
  assert.equal(toDate(d), d);
  assert.equal(toDate('2026-07-20T10:00:00Z').getTime(), d.getTime());
  assert.equal(toDate('not-a-date'), null);
  assert.equal(toDate(''), null);
  assert.equal(toDate(null), null);
  assert.equal(toDate(undefined), null);
  assert.equal(toDate(new Date('nope')), null);
});

test('dayKeyLocal: keys off the LOCAL calendar day, not the UTC one', () => {
  // Built from local parts, so this is unambiguously "the 20th" for the viewer
  // regardless of which side of UTC they are on.
  const local = new Date(2026, 6, 20, 23, 30);
  assert.equal(dayKeyLocal(local), '2026-07-20');
  assert.equal(dayKeyLocal(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
  assert.equal(dayKeyLocal('garbage'), null);
});

test('monthKeyLocal + weekStartLocal: zero-padded month, Monday-anchored week', () => {
  assert.equal(monthKeyLocal(new Date(2026, 8, 3)), '2026-09');
  assert.equal(monthKeyLocal('garbage'), null);

  // 2026-07-22 is a Wednesday → its week starts Monday the 20th.
  const wed = new Date(2026, 6, 22, 15, 0);
  const start = weekStartLocal(wed);
  assert.equal(start.getDay(), 1);
  assert.equal(dayKeyLocal(start), '2026-07-20');
  // A Sunday belongs to the week that already started, not the next one.
  assert.equal(dayKeyLocal(weekStartLocal(new Date(2026, 6, 26, 9, 0))), '2026-07-20');
  assert.equal(weekStartLocal('garbage'), null);
});

test('startOfDaysAgo: local midnight, n whole days back', () => {
  const today = startOfDaysAgo(0);
  assert.equal(today.getHours(), 0);
  assert.equal(today.getMinutes(), 0);
  assert.equal(today.getMilliseconds(), 0);
  // DST shifts the raw ms delta, so compare whole days.
  assert.equal(Math.round((today.getTime() - startOfDaysAgo(7).getTime()) / DAY_MS), 7);
});

// ── Daily series ────────────────────────────────────────────────────────────

test('dailyCounts: fixed-length, zero-filled, oldest first, ending today', () => {
  const points = dailyCounts([daysBack(0), daysBack(0), daysBack(3)], 7);
  assert.equal(points.length, 7);
  assert.equal(points[6].key, dayKeyLocal(new Date()));
  assert.equal(points[6].value, 2, 'today holds both of today\'s events');
  assert.equal(points[3].value, 1, 'three days back holds the third');
  assert.equal(points[0].value, 0, 'a quiet day is a 0 bucket, not a gap');
  // Strictly ascending keys — the chart draws them in array order.
  const keys = points.map((p) => p.key);
  assert.deepEqual(keys.slice().sort(), keys);
});

test('dailyCounts: ignores events outside the window and unparseable rows', () => {
  const points = dailyCounts([daysBack(40), 'garbage', null, daysBack(1)], 7);
  assert.equal(points.reduce((s, p) => s + p.value, 0), 1);
});

test('dailyCounts: empty input still yields a full zero-filled window', () => {
  const points = dailyCounts([], 30);
  assert.equal(points.length, 30);
  assert.ok(points.every((p) => p.value === 0));
  assert.ok(points.every((p) => typeof p.label === 'string' && p.label.length > 0));
});

test('dailyCounts: a nonsense day count degrades to a single bucket, never zero-length', () => {
  assert.equal(dailyCounts([], 0).length, 1);
  assert.equal(dailyCounts([], -5).length, 1);
});

// ── All-time series ─────────────────────────────────────────────────────────

test('pickGranularity: day → week → month as history grows', () => {
  assert.equal(pickGranularity(0), 'day');
  assert.equal(pickGranularity(70), 'day');
  assert.equal(pickGranularity(71), 'week');
  assert.equal(pickGranularity(550), 'week');
  assert.equal(pickGranularity(551), 'month');
  assert.equal(pickGranularity(4000), 'month');
});

test('allTimeCounts: no data means no points, not a fabricated bucket', () => {
  const empty = allTimeCounts([]);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.granularity, 'day');
  assert.deepEqual(allTimeCounts(['garbage', null]).points, []);
});

test('allTimeCounts: short history buckets daily and runs first-event → today', () => {
  const series = allTimeCounts([daysBack(4), daysBack(4), daysBack(0)]);
  assert.equal(series.granularity, 'day');
  assert.equal(series.points.length, 5, 'inclusive of both ends');
  assert.equal(series.points[0].value, 2);
  assert.equal(series.points[4].value, 1);
  assert.equal(series.points[4].key, dayKeyLocal(new Date()));
  assert.equal(series.points.reduce((s, p) => s + p.value, 0), 3);
});

test('allTimeCounts: long history auto-widens the bucket and keeps every event', () => {
  const stamps = [daysBack(900), daysBack(400), daysBack(120), daysBack(0)];
  const series = allTimeCounts(stamps);
  assert.equal(series.granularity, 'month');
  assert.equal(series.points.reduce((s, p) => s + p.value, 0), stamps.length);
  // ~30 months of history, gap-filled, so most buckets are empty.
  assert.ok(series.points.length > 25, 'gaps are filled, not skipped');
  assert.ok(series.points.some((p) => p.value === 0));
});

test('allTimeCounts: forced granularity overrides the automatic pick', () => {
  const stamps = [daysBack(10), daysBack(3), daysBack(0)];
  const weekly = allTimeCounts(stamps, 'week');
  assert.equal(weekly.granularity, 'week');
  assert.equal(weekly.points.reduce((s, p) => s + p.value, 0), 3);
  assert.ok(weekly.points.length <= 3);
  // Verbose label for the tooltip, compact `short` for the axis — a full
  // "Week of Jul 20" on the axis collides with its neighbour.
  assert.ok(weekly.points.every((p) => p.label.startsWith('Week of ')));
  assert.ok(weekly.points.every((p) => p.short && !p.short.includes('Week of ')));
  assert.ok(weekly.points.every((p) => p.label.endsWith(p.short)));

  const monthly = allTimeCounts(stamps, 'month');
  assert.equal(monthly.points.reduce((s, p) => s + p.value, 0), 3);
  assert.ok(monthly.points.length <= 2);
});

test('cumulative: running total, same length and keys', () => {
  const points = [
    { key: 'a', label: 'A', value: 2 },
    { key: 'b', label: 'B', value: 0 },
    { key: 'c', label: 'C', value: 5 },
  ];
  assert.deepEqual(cumulative(points).map((p) => p.value), [2, 2, 7]);
  assert.deepEqual(cumulative(points).map((p) => p.key), ['a', 'b', 'c']);
  // The axis form has to survive accumulation, or a cumulative weekly chart
  // falls back to the verbose label and overlaps.
  assert.equal(cumulative([{ key: 'a', label: 'Week of Jul 20', short: 'Jul 20', value: 1 }])[0].short, 'Jul 20');
  assert.deepEqual(cumulative([]), []);
  // Non-mutating — the source series is still rendered alongside it.
  assert.deepEqual(points.map((p) => p.value), [2, 0, 5]);
});

// ── Window deltas ───────────────────────────────────────────────────────────

test('windowDelta: splits current vs. prior window and computes the change', () => {
  // 3 in the last 7 days, 2 in the 7 before that, 1 older than both.
  const stamps = [daysBack(0), daysBack(2), daysBack(6), daysBack(8), daysBack(12), daysBack(30)];
  const d = windowDelta(stamps, 7);
  assert.equal(d.current, 3);
  assert.equal(d.previous, 2);
  assert.equal(Math.round(d.deltaPct), 50);
});

test('windowDelta: an empty prior window yields null, not a fake +100%', () => {
  const d = windowDelta([daysBack(1), daysBack(2)], 7);
  assert.equal(d.current, 2);
  assert.equal(d.previous, 0);
  assert.equal(d.deltaPct, null);
});

test('windowDelta: a decline is negative, and junk rows are skipped', () => {
  const d = windowDelta([daysBack(9), daysBack(10), daysBack(11), daysBack(1), 'garbage'], 7);
  assert.equal(d.current, 1);
  assert.equal(d.previous, 3);
  assert.ok(d.deltaPct < 0);
  assert.equal(Math.round(d.deltaPct), -67);
});

// ── Distributions ───────────────────────────────────────────────────────────

const PROMPT_ROWS = [
  ['t', 'Living Room', 'Modern'],
  ['t', 'Living Room', 'Coastal'],
  ['t', 'Kitchen', 'Modern'],
  ['t', 'unknown', ''],
  ['t', '', 'Modern'],
];

test('topValues: counts a column, sorts desc, skips blank and "unknown"', () => {
  assert.deepEqual(topValues(PROMPT_ROWS, 1), [
    { label: 'Living Room', value: 2 },
    { label: 'Kitchen', value: 1 },
  ]);
  assert.deepEqual(topValues(PROMPT_ROWS, 2), [
    { label: 'Modern', value: 3 },
    { label: 'Coastal', value: 1 },
  ]);
  assert.deepEqual(topValues([], 1), []);
});

test('topValues: the tail folds into one Other bucket, conserving the total', () => {
  const rows = [];
  ['a', 'a', 'a', 'b', 'b', 'c', 'd', 'e'].forEach((v) => rows.push(['t', v]));
  const out = topValues(rows, 1, { top: 2 });
  assert.deepEqual(out, [
    { label: 'a', value: 3 },
    { label: 'b', value: 2 },
    { label: 'Other', value: 3 },
  ]);
  assert.equal(out.reduce((s, r) => s + r.value, 0), rows.length);
  // top:0 means "no folding" — return the full ranking.
  assert.equal(topValues(rows, 1, { top: 0 }).length, 5);
});

test('topValues: ties break alphabetically so a re-render keeps the same order', () => {
  const rows = [['t', 'zebra'], ['t', 'apple']];
  assert.deepEqual(topValues(rows, 1).map((r) => r.label), ['apple', 'zebra']);
});

test('hourHistogram: 24 buckets, always full, keyed to the local hour', () => {
  const points = hourHistogram([new Date(2026, 6, 20, 9, 30), new Date(2026, 6, 21, 9, 5), new Date(2026, 6, 21, 0, 5)]);
  assert.equal(points.length, 24);
  assert.equal(points[9].value, 2);
  assert.equal(points[0].value, 1);
  assert.equal(points[0].label, '12am');
  assert.equal(points[13].label, '1pm');
  assert.equal(hourHistogram([]).length, 24);
});

test('weekdayHistogram: 7 buckets starting Monday', () => {
  // 2026-07-20 is a Monday, 2026-07-26 the Sunday that closes that week.
  const points = weekdayHistogram([new Date(2026, 6, 20, 10), new Date(2026, 6, 26, 10)]);
  assert.equal(points.length, 7);
  assert.equal(points[0].label, 'Mon');
  assert.equal(points[0].value, 1);
  assert.equal(points[6].label, 'Sun');
  assert.equal(points[6].value, 1);
});

test('planMix: uses the injected effective-plan resolver and drops empty slices', () => {
  const users = [{ plan: 'pro' }, { plan: 'pro' }, { plan: 'free' }, { plan: 'enterprise' }];
  assert.deepEqual(planMix(users, (u) => u.plan), [
    { label: 'Pro', value: 2 },
    { label: 'Enterprise', value: 1 },
    { label: 'Free', value: 1 },
  ]);
  // An all-free base charts one slice, not three with two zeros.
  assert.deepEqual(planMix([{ plan: 'free' }], (u) => u.plan), [{ label: 'Free', value: 1 }]);
  assert.deepEqual(planMix([], () => 'free'), []);
});

test('authMix: Google vs. email, empty side omitted', () => {
  assert.deepEqual(authMix([{ googleSub: 'g1' }, {}, {}]), [
    { label: 'Google', value: 1 },
    { label: 'Email', value: 2 },
  ]);
  assert.deepEqual(authMix([{ googleSub: 'g1' }]), [{ label: 'Google', value: 1 }]);
  assert.deepEqual(authMix([]), []);
});

test('booleanMix: only the literal string "true" counts as yes', () => {
  const rows = [['t', 'true'], ['t', 'TRUE'], ['t', 'false'], ['t', '']];
  assert.deepEqual(booleanMix(rows, 1, 'Yes', 'No'), [
    { label: 'Yes', value: 2 },
    { label: 'No', value: 2 },
  ]);
  assert.deepEqual(booleanMix([], 1, 'Yes', 'No'), []);
});

// ── Captions ────────────────────────────────────────────────────────────────

test('peakPoint: biggest bucket, earliest on a tie, null when nothing happened', () => {
  const points = [
    { key: 'a', label: 'A', value: 1 },
    { key: 'b', label: 'B', value: 9 },
    { key: 'c', label: 'C', value: 9 },
  ];
  assert.equal(peakPoint(points).key, 'b');
  assert.equal(peakPoint([{ key: 'a', label: 'A', value: 0 }]), null);
  assert.equal(peakPoint([]), null);
});

test('averageValue: mean over ALL buckets including zeros, one decimal', () => {
  assert.equal(averageValue([{ value: 1 }, { value: 2 }, { value: 0 }]), 1);
  assert.equal(averageValue([{ value: 1 }, { value: 2 }]), 1.5);
  assert.equal(averageValue([{ value: 1 }, { value: 1 }, { value: 2 }]), 1.3);
  assert.equal(averageValue([]), 0);
});
