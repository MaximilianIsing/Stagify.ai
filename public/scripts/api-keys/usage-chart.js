// The bar chart behind every number on the dashboard that has a shape.
//
// CSS BARS, NOT A CHARTING LIBRARY. What is drawn here is one series of daily counts
// with a second stacked on top of it; a library would be a hundred kilobytes to draw
// two rectangles, and it would arrive after first paint on a page whose whole point is
// to answer a question at a glance. The tradeoff is real and deliberate: no axes, no
// zoom, no tooltips beyond the browser's own `title`.
//
// The two series are DELIVERED and REFUNDED, and the refunded one is stacked above
// rather than beside. A failed render is not separate traffic — it is a request that
// was charged and then given back — so the column height stays "requests that day" and
// the red cap is how much of it did not deliver.

import { escapeHtml } from '../escape-html.js';
import { t, plural, locale } from './i18n.js';
import { formatCount } from './format.js';

/**
 * UTC day label — the buckets are UTC (see api-billing.js usageSummary), so they are
 * labelled in UTC too rather than being silently shifted into the reader's timezone.
 * The month name comes from the CHOSEN language, not the browser's locale.
 * @param {number} ms - Bucket start, epoch millis.
 * @returns {string} e.g. "18 Aug".
 */
export function dayLabel(ms) {
  try {
    return new Date(Number(ms)).toLocaleDateString(locale(), {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return '';
  }
}

/**
 * The chart's markup.
 *
 * An all-zero window still renders full-height columns of nothing rather than
 * collapsing to a line: an empty chart that looks identical to a broken one is the
 * failure this page already had.
 * @param {{ day: number, delivered: number, refunded: number }[]} buckets - Daily counts, oldest first.
 * @param {{ className?: string }} [opts] - Extra class for the wrapper.
 * @returns {string} HTML.
 */
export function chartHtml(buckets, opts = {}) {
  const rows = Array.isArray(buckets) ? buckets : [];
  const cls = 'ak-chart' + (opts.className ? ' ' + escapeHtml(opts.className) : '');
  if (!rows.length) {
    return '<div class="' + cls + ' ak-chart--empty"><p class="ak-empty">'
      + escapeHtml(t('apiKeys.chart.empty', 'No requests yet.')) + '</p></div>';
  }

  const peak = rows.reduce((m, r) => Math.max(m, Number(r.delivered || 0) + Number(r.refunded || 0)), 0);
  // Scale against 1 when nothing happened, so every column is a visible floor rather
  // than a division by zero.
  const scale = peak > 0 ? peak : 1;

  const cols = rows
    .map((r) => {
      const delivered = Number(r.delivered || 0);
      const refunded = Number(r.refunded || 0);
      const total = delivered + refunded;
      // Two whole templates rather than a sentence assembled from fragments: word order
      // and the position of "UTC" both move between languages, and a translator handed
      // three clauses to glue cannot fix that.
      const title = refunded
        ? t('apiKeys.chart.tipRefunded', '{day} UTC · {count} requests · {refunded} refunded', {
          day: dayLabel(r.day), count: formatCount(total), refunded: formatCount(refunded),
        })
        : plural('apiKeys.chart.tip', total, {
          one: '{day} UTC · {count} request',
          other: '{day} UTC · {count} requests',
        }, { day: dayLabel(r.day) });
      // Heights are percentages of the column, which is why the column itself must be
      // full height — see the `align-items: stretch` note in developers.css.
      return (
        '<div class="ak-chart__col" title="' + escapeHtml(title) + '">'
        + (refunded ? '<i class="ak-chart__bar ak-chart__bar--refunded" style="height:' + pct(refunded, scale) + '%"></i>' : '')
        + '<i class="ak-chart__bar ak-chart__bar--delivered" style="height:' + pct(delivered, scale) + '%"></i>'
        + '</div>'
      );
    })
    .join('');

  const first = dayLabel(rows[0].day);
  const last = dayLabel(rows[rows.length - 1].day);
  return (
    '<div class="' + cls + '">'
    + '<div class="ak-chart__plot">' + cols + '</div>'
    + '<div class="ak-chart__axis"><span>' + escapeHtml(first) + '</span>'
    + '<span>' + escapeHtml(last) + '</span></div>'
    + '</div>'
  );
}

/**
 * One column's share of the tallest, floored so a single request is still a mark.
 * @param {number} value - This segment.
 * @param {number} scale - The tallest column's total.
 * @returns {number} A percentage, 0–100.
 */
function pct(value, scale) {
  if (!value) return 0;
  return Math.max(3, Math.round((value / scale) * 100));
}
