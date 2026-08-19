// Tier: frontend island logic (no DOM) — public/scripts/admin/analytics-rejections.js.
//
// This module reads the one feed the dashboard had never fetched, so its risks
// are the ones nobody has seen fail yet:
//
//   - **Empty is the normal state, not an error.** A fresh install has refused
//     nothing. Every function must return an empty result there rather than a
//     confident zero, because "no refusals recorded" and "a refusal rate of 0%"
//     are different claims and only one of them is true.
//   - **Days, not hits.** `capHitDaysByPerson` exists to find people who keep
//     coming back and keep being blocked. Eight retries in one evening is one
//     such day; counting hits would rank a single frustrated session above four
//     separate ones.
//   - **Local day keys.** Same trap as the rest of the dashboard: a UTC-derived
//     key puts a late-evening refusal on tomorrow for half the world, which
//     would split one person's day in two and double their day count.
//
// Fixtures are built from `new Date()` so the suite cannot rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ofKind, rejectionsByDay, rejectionMix, topReasons,
  capHitDaysByPerson, capHitCoverage,
  customerRefusals, credentialGuardHits, CREDENTIAL_GUARD_CODES,
} from '../../../public/scripts/admin/analytics-rejections.js';
import { stripHeader } from '../../../public/scripts/admin/analytics.js';

/** A Date `n` days before now, at midday so a timezone offset can't shift the day. */
function daysBack(n, hour = 12) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/** One rejection row in writer order: timestamp,kind,code,detail,email,userId,ip,ua. */
function row(when, kind, code, opts = {}) {
  const detail = opts.detail || '';
  const email = opts.email || '';
  const userId = opts.userId || '';
  return [when instanceof Date ? when.toISOString() : when, kind, code, detail, email, userId, '', ''];
}

const HEADER = ['timestamp', 'kind', 'code', 'detail', 'email', 'userId', 'ipAddress', 'userAgent'];

// ── The empty case ──────────────────────────────────────────────────────────

test('empty input yields empty results everywhere, never a confident zero', () => {
  assert.deepEqual(rejectionMix([]), []);
  assert.deepEqual(topReasons([], 'unstageable'), []);
  assert.deepEqual(capHitDaysByPerson([]), []);
  // The one exception is the daily series, which is zero-filled BY DESIGN so a
  // quiet day inside a real window renders flat. The caller checks rows.length
  // before drawing it at all — that distinction is the UI's job, not this one's.
  assert.equal(rejectionsByDay([], 7).length, 7);
  assert.ok(rejectionsByDay([], 7).every((p) => p.value === 0));
  // Coverage must say "nothing to divide" rather than claiming 0% or 100%.
  assert.deepEqual(capHitCoverage([]), { total: 0, attributed: 0, ratio: null });
});

test('junk rows do not throw', () => {
  const junk = [null, undefined, [], ['not-a-date'], ['x', 'y']];
  assert.doesNotThrow(() => rejectionMix(junk));
  assert.doesNotThrow(() => rejectionsByDay(junk, 7));
  assert.doesNotThrow(() => capHitDaysByPerson(junk));
  assert.doesNotThrow(() => capHitCoverage(junk));
});

// ── Header handling ─────────────────────────────────────────────────────────

test('the header row is not counted as a refusal of kind "kind"', () => {
  const rows = [HEADER, row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' })];
  const mix = rejectionMix(stripHeader(rows));
  assert.equal(mix.length, 1);
  assert.equal(mix[0].value, 1);
  assert.ok(!mix.some((s) => s.label.toLowerCase() === 'kind'));
  // And the reason the call above is mandatory: fed the raw table, the literal
  // header cell charts as its own refusal bucket named 'kind'.
  assert.ok(rejectionMix(rows).some((s) => s.label.toLowerCase() === 'kind'));
});

// ── Kind filtering and mix ──────────────────────────────────────────────────

test('ofKind matches case- and whitespace-insensitively', () => {
  const rows = [
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED'),
    row(daysBack(1), ' Daily_Limit ', 'DAILY_LIMIT_REACHED'),
    row(daysBack(1), 'rate_limit', 'gen'),
  ];
  assert.equal(ofKind(rows, 'daily_limit').length, 2);
  assert.equal(ofKind(rows, 'rate_limit').length, 1);
  assert.equal(ofKind(rows, 'nope').length, 0);
});

test('rejectionMix labels the known kinds and passes an unknown one through', () => {
  const rows = [
    row(daysBack(1), 'unstageable', 'EXTERIOR'),
    row(daysBack(1), 'unstageable', 'VEHICLE'),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED'),
    row(daysBack(1), 'something_new', 'X'),
  ];
  const mix = rejectionMix(rows);
  assert.equal(mix[0].label, 'Photo refused');
  assert.equal(mix[0].value, 2);
  const labels = mix.map((s) => s.label);
  assert.ok(labels.includes('Daily cap reached'));
  // A future writer's kind must still appear rather than being silently dropped.
  assert.ok(labels.includes('something_new'));
});

test('topReasons stays inside one kind, because CODE means different things per bucket', () => {
  const rows = [
    row(daysBack(1), 'unstageable', 'EXTERIOR'),
    row(daysBack(1), 'unstageable', 'EXTERIOR'),
    row(daysBack(1), 'unstageable', 'VEHICLE'),
    // For a rate_limit row the code is the LIMITER NAME — a different vocabulary.
    row(daysBack(1), 'rate_limit', 'gen'),
    row(daysBack(1), 'rate_limit', 'gen'),
    row(daysBack(1), 'rate_limit', 'gen'),
  ];
  const photo = topReasons(rows, 'unstageable');
  assert.equal(photo[0].label, 'EXTERIOR');
  assert.equal(photo[0].value, 2);
  assert.ok(!photo.some((s) => s.label === 'gen'), 'limiter names must not leak into photo reasons');
  assert.equal(topReasons(rows, 'rate_limit')[0].value, 3);
});

// ── The day-count rule ──────────────────────────────────────────────────────

test('capHitDaysByPerson counts separate DAYS, not hits', () => {
  const rows = [
    // One person, one evening, four retries → one day.
    row(daysBack(1, 20), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'burst@x.co' }),
    row(daysBack(1, 21), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'burst@x.co' }),
    row(daysBack(1, 22), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'burst@x.co' }),
    row(daysBack(1, 23), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'burst@x.co' }),
    // Another person, three separate days, one hit each.
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'repeat@x.co' }),
    row(daysBack(3), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'repeat@x.co' }),
    row(daysBack(5), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'repeat@x.co' }),
  ];
  const ranked = capHitDaysByPerson(rows);
  assert.equal(ranked[0].identity, 'repeat@x.co');
  assert.equal(ranked[0].days, 3);
  assert.equal(ranked[0].hits, 3);
  assert.equal(ranked[1].identity, 'burst@x.co');
  assert.equal(ranked[1].days, 1, 'four retries in one evening is one day');
  assert.equal(ranked[1].hits, 4);
});

test('capHitDaysByPerson: a late-evening refusal stays on its LOCAL day', () => {
  // 23:30 local. A UTC-derived key would push this to tomorrow anywhere east of
  // UTC, splitting one person's single day into two and doubling their rank.
  const late = daysBack(1, 23);
  late.setMinutes(30);
  const earlier = daysBack(1, 9);
  const ranked = capHitDaysByPerson([
    row(late, 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'night@x.co' }),
    row(earlier, 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'night@x.co' }),
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].days, 1);
  assert.equal(ranked[0].hits, 2);
});

test('capHitDaysByPerson falls back to userId, and drops rows with no identity', () => {
  const rows = [
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { userId: 'u_42' }),
    row(daysBack(2), 'daily_limit', 'DAILY_LIMIT_REACHED', { userId: 'u_42' }),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'unknown', userId: 'unknown' }),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED'),
  ];
  const ranked = capHitDaysByPerson(rows);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].identity, 'u_42');
  assert.equal(ranked[0].days, 2);
});

test('capHitDaysByPerson treats one address case-insensitively as one person', () => {
  const ranked = capHitDaysByPerson([
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'Sam@X.co' }),
    row(daysBack(2), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'sam@x.co' }),
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].days, 2);
});

test('capHitDaysByPerson ignores every kind but daily_limit', () => {
  const ranked = capHitDaysByPerson([
    row(daysBack(1), 'rate_limit', 'gen', { email: 'a@b.co' }),
    row(daysBack(2), 'unstageable', 'EXTERIOR', { email: 'a@b.co' }),
  ]);
  assert.deepEqual(ranked, []);
});

test('capHitDaysByPerson honours a days window', () => {
  const rows = [
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' }),
    row(daysBack(60), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' }),
  ];
  assert.equal(capHitDaysByPerson(rows)[0].days, 2);
  assert.equal(capHitDaysByPerson(rows, { days: 30 })[0].days, 1);
});

// ── Coverage is stated, not assumed ─────────────────────────────────────────

test('capHitCoverage reports the anonymous share so the ranking reads as a floor', () => {
  const rows = [
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' }),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { userId: 'u_1' }),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED'),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'unknown' }),
    // A different kind must not enter the denominator.
    row(daysBack(1), 'rate_limit', 'gen'),
  ];
  const cov = capHitCoverage(rows);
  assert.equal(cov.total, 4);
  assert.equal(cov.attributed, 2);
  assert.equal(cov.ratio, 0.5);
});

// ── The daily series ────────────────────────────────────────────────────────

test('rejectionsByDay is zero-filled and lands on the local day', () => {
  const series = rejectionsByDay([
    row(daysBack(0), 'unstageable', 'EXTERIOR'),
    row(daysBack(0), 'unstageable', 'VEHICLE'),
    row(daysBack(2), 'rate_limit', 'gen'),
  ], 5);
  assert.equal(series.length, 5);
  assert.equal(series[series.length - 1].value, 2, 'today');
  assert.equal(series[series.length - 3].value, 1, 'two days back');
  assert.equal(series[series.length - 2].value, 0, 'the quiet day between is a measured zero');
});

// ── Failed secrets are not lost customers ───────────────────────────────────
//
// The split these cover is not cosmetic. On the first live dataset this module
// was pointed at, 1,682 of 1,699 recorded refusals were `endpoint_key` bounces —
// the admin console's own key guard. Charted together they would have drawn a
// donut that was 99% "Rate limited", hiding both the thirteen real customer
// refusals and the fact that something was hammering the key.

test('the credential guards are the two buckets a VALID key never touches', () => {
  assert.deepEqual([...CREDENTIAL_GUARD_CODES].sort(), ['api_key_reject', 'endpoint_key']);
});

test('customerRefusals excludes failed-credential bounces; credentialGuardHits is the complement', () => {
  const rows = [
    row(daysBack(1), 'rate_limit', 'endpoint_key'),
    row(daysBack(1), 'rate_limit', 'api_key_reject'),
    row(daysBack(1), 'rate_limit', 'gen'),
    row(daysBack(1), 'unstageable', 'EXTERIOR'),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' }),
  ];
  assert.equal(customerRefusals(rows).length, 3);
  assert.equal(credentialGuardHits(rows).length, 2);
  // Every row lands in exactly one of the two.
  assert.equal(customerRefusals(rows).length + credentialGuardHits(rows).length, rows.length);
});

test('a customer rate-limit bounce is NOT treated as a failed credential', () => {
  // `gen` and `gallery` are ordinary product limiters — hitting one means a real
  // person was told to slow down, which is exactly the drop-off being measured.
  const rows = [row(daysBack(1), 'rate_limit', 'gen'), row(daysBack(1), 'rate_limit', 'gallery')];
  assert.equal(credentialGuardHits(rows).length, 0);
  assert.equal(customerRefusals(rows).length, 2);
});

test('the guard classification is scoped to rate_limit rows', () => {
  // A future kind that happened to reuse the string must not be swept into the
  // security bucket on the strength of its code alone.
  const rows = [row(daysBack(1), 'unstageable', 'endpoint_key')];
  assert.equal(credentialGuardHits(rows).length, 0);
  assert.equal(customerRefusals(rows).length, 1);
});

test('the split does not disturb the cap ranking, which only ever read daily_limit', () => {
  const rows = [
    ...Array.from({ length: 50 }, () => row(daysBack(1), 'rate_limit', 'endpoint_key')),
    row(daysBack(1), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' }),
    row(daysBack(2), 'daily_limit', 'DAILY_LIMIT_REACHED', { email: 'a@b.co' }),
  ];
  assert.equal(capHitDaysByPerson(rows)[0].days, 2);
  assert.equal(capHitDaysByPerson(customerRefusals(rows))[0].days, 2);
  assert.equal(capHitCoverage(rows).total, 2, 'the guard rows are not in the cap denominator');
});
