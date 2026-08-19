// The dashboard's presentational helpers — dates, durations, counts, and the one rule
// that turns a key record into the word a person reads.
//
// Extracted because the inspector's rail and its detail pane show the SAME facts at two
// sizes: the rail says "live · 2 minutes ago", the pane says "18 Aug 2026, 09:41". When
// those two disagreed about what "live" means, the page contradicted itself in two
// places a centimetre apart.
//
// EVERY STRING HERE GOES THROUGH THE PACK. The page swaps language in place, so a
// hard-coded "2 minutes ago" would sit in English under Spanish copy — and dates are
// formatted against the CHOSEN language rather than the browser's locale for the same
// reason (see i18n.js `locale()`).
//
// Every function is pure apart from that lookup, and takes its clock as a parameter
// where it needs one, so the whole file is testable without a DOM or a frozen system
// time. With no pack loaded the English fallbacks are what render, which is what the
// unit specs assert against.

import { t, plural, locale } from './i18n.js';

/** How long a key can go unused and still read as `live`. */
export const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What a formatter prints when it has nothing to print.
 *
 * A word, not a dash: this page shows a lot of numbers that can legitimately be absent,
 * and a column of punctuation reads as a rendering failure where "Never" and "n/a" read
 * as answers. Functions rather than constants because the answer is language-dependent
 * and the pack can arrive after the module does.
 * @returns {string} The "no date" placeholder.
 */
export function noDate() {
  return t('apiKeys.value.never', 'Never');
}

/** @returns {string} The "no value" placeholder. */
export function noValue() {
  return t('apiKeys.value.none', 'n/a');
}

/**
 * Human date, or "Never".
 * @param {number | null | undefined} ms - Epoch millis.
 * @returns {string} A short date in the chosen language.
 */
export function formatWhen(ms) {
  if (!ms) return noDate();
  try {
    return new Date(Number(ms)).toLocaleDateString(locale(), {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return noDate();
  }
}

/**
 * Date and time — the detail pane's precision, where "2 days ago" is not enough to
 * match a line in an access log.
 * @param {number | null | undefined} ms - Epoch millis.
 * @returns {string} A short datetime in the chosen language.
 */
export function formatStamp(ms) {
  if (!ms) return noDate();
  try {
    return new Date(Number(ms)).toLocaleString(locale(), {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return noDate();
  }
}

/**
 * Elapsed time in the coarsest unit that is still true.
 *
 * Stops at days rather than rolling into months: past a week the exact date is what
 * someone deciding whether to revoke a key actually wants, and the pane shows both.
 * @param {number | null | undefined} ms - Epoch millis of the event.
 * @param {number} [nowMs] - Clock, injectable for tests.
 * @returns {string} e.g. "2 minutes ago", or "never".
 */
export function formatAgo(ms, nowMs = Date.now()) {
  if (!ms) return t('apiKeys.ago.never', 'never');
  const delta = Math.max(0, nowMs - Number(ms));
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return t('apiKeys.ago.justNow', 'just now');
  if (mins < 60) {
    return plural('apiKeys.ago.minutes', mins, { one: '{count} minute ago', other: '{count} minutes ago' });
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return plural('apiKeys.ago.hours', hours, { one: '{count} hour ago', other: '{count} hours ago' });
  }
  const days = Math.floor(hours / 24);
  return plural('apiKeys.ago.days', days, { one: '{count} day ago', other: '{count} days ago' });
}

/**
 * A render duration, in the unit a developer quotes it in.
 *
 * A tenth of a second below the minute, because a staging render lands between about
 * ten and thirty seconds and that is the whole interesting range: rounded to whole
 * seconds, "14s" and "15s" hide the difference someone is watching for.
 *
 * The unit letters are translated — `s` and `m` are English abbreviations, and several
 * packs write them differently — but the NUMBER is formatted with the chosen locale, so
 * a German reader gets "14,2 s" rather than "14.2s".
 * @param {number | null | undefined} ms - Milliseconds.
 * @returns {string} e.g. "14.2s", or "n/a".
 */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return noValue();
  const secs = Number(ms) / 1000;
  if (secs < 60) return t('apiKeys.unit.seconds', '{value}s', { value: formatNumber(secs, 1) });
  if (secs < 600) return t('apiKeys.unit.seconds', '{value}s', { value: formatNumber(Math.round(secs)) });
  return t('apiKeys.unit.minutes', '{value}m', { value: formatNumber(Math.round(secs / 60)) });
}

/**
 * A number in the chosen language's conventions.
 * @param {number | null | undefined} n - The number.
 * @param {number} [decimals] - Fixed decimal places, if any.
 * @returns {string} e.g. "1,284" or "1.284".
 */
export function formatNumber(n, decimals = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  try {
    return v.toLocaleString(locale(), {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  } catch {
    return decimals ? v.toFixed(decimals) : String(Math.round(v));
  }
}

/**
 * Thousands-separated integer.
 * @param {number | null | undefined} n - The number.
 * @returns {string} e.g. "1,284".
 */
export function formatCount(n) {
  return formatNumber(n);
}

/**
 * A share as a percentage, where "nothing happened" is not 0%.
 *
 * A key with no traffic has no delivery rate, and printing 0% for it would read as an
 * outage. Returns null instead, and the callers print the no-value placeholder.
 * @param {number} part - The numerator.
 * @param {number} whole - The denominator.
 * @returns {number | null} 0-100, or null when there is nothing to divide.
 */
export function percent(part, whole) {
  const w = Number(whole);
  if (!Number.isFinite(w) || w <= 0) return null;
  return (Number(part) / w) * 100;
}

/**
 * A percentage, formatted and localized.
 * @param {number | null} value - 0-100, or null.
 * @returns {string} e.g. "99.4%", or the no-value placeholder.
 */
export function formatPercent(value) {
  if (value == null) return noValue();
  return t('apiKeys.unit.percent', '{value}%', { value: formatNumber(value, 1) });
}

/**
 * What a key record IS right now, as one word.
 *
 * Three states, in the order they are checked: a revoked key is revoked whatever its
 * traffic; a key used within a day is `live`; anything else is `idle`. `idle` is not a
 * fault — a CI key that runs on merges is idle most of the week — so the wording it
 * drives says "idle", never "inactive" or "unused".
 * @param {{ revokedAt?: number | null, lastUsedAt?: number | null }} key - The key record.
 * @param {number} [nowMs] - Clock, injectable for tests.
 * @returns {'revoked' | 'live' | 'idle'} The state.
 */
export function keyStatus(key, nowMs = Date.now()) {
  if (!key) return 'idle';
  if (key.revokedAt) return 'revoked';
  if (key.lastUsedAt && nowMs - Number(key.lastUsedAt) < LIVE_WINDOW_MS) return 'live';
  return 'idle';
}

/**
 * The translated word for a key state.
 * @param {'revoked' | 'live' | 'idle'} status - From keyStatus.
 * @returns {string} The word to show.
 */
export function statusLabel(status) {
  const english = { live: 'live', idle: 'idle', revoked: 'revoked' };
  return t('apiKeys.status.' + status, english[status] || status);
}
