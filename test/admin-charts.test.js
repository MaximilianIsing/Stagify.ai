// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/charts.js.
//
// These are the SVG builders behind every chart on the admin dashboard. They are
// testable at all because they are deliberately measurement-free: each chart
// draws into a fixed viewBox and is scaled by CSS, so nothing calls
// getBoundingClientRect and a minimal stub `document` is enough — the same
// approach as test/admin-grant-ui.test.js (no jsdom).
//
// What's worth asserting in a chart is not the pixel values but the invariants a
// wrong chart violates:
//   - one hover target per data point (a missing one is a bucket you can't read),
//   - geometry PROPORTIONAL to the data (double the value → double the bar),
//   - a zero renders as nothing, not as a stub bar implying activity,
//   - tooltips carry the exact number the axis had to round.
// So the tests below compare shapes against each other rather than against
// hard-coded coordinates, which would just re-encode the layout constants.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------

function makeEl(tag, ns) {
  return {
    tagName: tag,
    namespaceURI: ns || null,
    className: '',
    textContent: '',
    title: '',
    style: /** @type {Record<string, string>} */ ({}),
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
  };
}

globalThis.document = /** @type {any} */ ({
  createElement: (tag) => makeEl(tag),
  createElementNS: (ns, tag) => makeEl(tag, ns),
  createTextNode: (t) => ({ tagName: '#text', textContent: String(t), children: [] }),
});

const {
  areaChart, barChart, rankedBars, donutChart, sparkline, legend,
  chartCard, chartEmpty, fmtNum, fmtCompact, niceMax, PALETTE,
} = await import('../public/scripts/admin/charts.js');

// ---- Walkers ---------------------------------------------------------------

function findAll(node, tag, out = []) {
  if (node.tagName === tag) out.push(node);
  (node.children || []).forEach((c) => findAll(c, tag, out));
  return out;
}
function hasClass(node, cls) {
  return String(node.className || node.attrs?.class || '').split(' ').includes(cls);
}
function findAllByClass(node, cls, out = []) {
  if (hasClass(node, cls)) out.push(node);
  (node.children || []).forEach((c) => findAllByClass(c, cls, out));
  return out;
}
function allText(node) {
  return [node.textContent || '', ...(node.children || []).map(allText)].join(' ');
}
/** The text of every `<title>` — i.e. every tooltip the chart offers. */
function tooltips(node) {
  return findAll(node, 'title').map((t) => allText(t).trim());
}

const pts = (values) => values.map((v, i) => ({ key: 'k' + i, label: 'L' + i, value: v }));

// ---- Formatters ------------------------------------------------------------

test('fmtCompact: k/M above the thresholds, exact below, drops a trailing .0', () => {
  assert.equal(fmtCompact(0), '0');
  assert.equal(fmtCompact(999), '999');
  assert.equal(fmtCompact(1000), '1k');
  assert.equal(fmtCompact(1500), '1.5k');
  assert.equal(fmtCompact(2000000), '2M');
  assert.equal(fmtCompact(2500000), '2.5M');
  assert.equal(fmtCompact(/** @type {any} */ ('junk')), '0');
});

test('fmtNum: thousands separators, nullish is zero', () => {
  assert.equal(fmtNum(1234), (1234).toLocaleString());
  assert.equal(fmtNum(/** @type {any} */ (null)), '0');
});

test('niceMax: rounds the axis top up to 1/2/5×10ⁿ, never returns 0', () => {
  assert.equal(niceMax(0), 1, 'an all-zero series still needs a divisible axis');
  assert.equal(niceMax(-5), 1);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(37), 50);
  assert.equal(niceMax(120), 200);
  assert.equal(niceMax(4300), 5000);
  // Always at or above the data, or the peak would clip out of the plot.
  [3, 17, 64, 251, 999].forEach((v) => assert.ok(niceMax(v) >= v, 'niceMax(' + v + ') clips'));
});

// ---- Empty states ----------------------------------------------------------

test('every chart degrades to a placeholder instead of an empty SVG', () => {
  [areaChart([]), barChart([]), rankedBars([]), donutChart([])].forEach((node) => {
    assert.equal(node.tagName, 'p');
    assert.ok(hasClass(node, 'adm-chart-empty'));
  });
  // A donut whose slices are all zero has nothing to draw either.
  assert.ok(hasClass(donutChart([{ label: 'a', value: 0 }]), 'adm-chart-empty'));
  assert.equal(chartEmpty('custom').textContent, 'custom');
});

// ---- Area chart ------------------------------------------------------------

test('areaChart: one hover target per bucket, each carrying the exact value', () => {
  const chart = areaChart(pts([0, 5, 3]), { unit: 'renders' });
  assert.equal(chart.tagName, 'svg');
  assert.equal(chart.attrs.viewBox, '0 0 1000 240');

  const hits = findAllByClass(chart, 'adm-chart-hit');
  assert.equal(hits.length, 3, 'a zero bucket still needs a hoverable column');

  const tips = tooltips(chart);
  assert.deepEqual(tips, ['L0: 0 renders', 'L1: 5 renders', 'L2: 3 renders']);
});

test('areaChart: the line rises as the value rises (SVG y grows downward)', () => {
  const chart = areaChart(pts([0, 10]));
  // Two paths: the filled area, then the stroked line. Both share the same points.
  const line = findAll(chart, 'path')[1];
  const ys = line.attrs.d.match(/[ML][\d.]+ ([\d.]+)/g).map((m) => Number(m.split(' ')[1]));
  assert.ok(ys[0] > ys[1], 'the higher value must sit higher on the canvas');
});

test('areaChart: point dots appear on a sparse series and are dropped on a dense one', () => {
  assert.equal(findAll(areaChart(pts(new Array(30).fill(1))), 'circle').length, 30);
  assert.equal(findAll(areaChart(pts(new Array(90).fill(1))), 'circle').length, 0);
});

test('areaChart: x labels are thinned but always include the newest bucket', () => {
  const chart = areaChart(pts(new Array(30).fill(1)), { maxLabels: 6 });
  const labels = findAll(chart, 'text').map(allText).map((t) => t.trim());
  const xLabels = labels.filter((t) => t.startsWith('L'));
  assert.ok(xLabels.length <= 8, 'thinned, got ' + xLabels.length);
  assert.ok(xLabels.includes('L29'), 'the last bucket is always labelled');
});

test('x labels: the forced last label evicts a strided neighbour instead of colliding', () => {
  // 31 buckets at stride 5 puts a strided label on index 30 — the same slot as
  // the forced last one at 30. 32 buckets puts one on 30, one slot from the
  // forced 31: close enough to overlap, so it has to go.
  const labelsFor = (n, maxLabels) => findAll(areaChart(pts(new Array(n).fill(1)), { maxLabels }), 'text')
    .map(allText).map((t) => t.trim()).filter((t) => t.startsWith('L'));

  const l32 = labelsFor(32, 6);
  assert.ok(l32.includes('L31'), 'newest bucket kept');
  assert.ok(!l32.includes('L30'), 'its crowded neighbour dropped');
  assert.equal(new Set(l32).size, l32.length, 'no duplicate labels');

  // Every retained index must still be at least one stride-ish apart.
  const idx = l32.map((t) => Number(t.slice(1))).sort((a, b) => a - b);
  assert.ok(idx.every((v, i) => i === 0 || v - idx[i - 1] >= 3), idx.join(','));

  // A short series labels every bucket — nothing to thin, nothing to evict.
  assert.deepEqual(labelsFor(3, 8), ['L0', 'L1', 'L2']);
});

test('areaChart: an explicit width narrows the viewBox (grid cards keep readable axis text)', () => {
  assert.equal(areaChart(pts([1, 2]), { width: 460 }).attrs.viewBox, '0 0 460 240');
  assert.equal(barChart(pts([1, 2]), { width: 460, height: 200 }).attrs.viewBox, '0 0 460 200');
});

test('cartesian charts draw `short` on the axis but keep the verbose label in the tooltip', () => {
  const points = [{ key: 'a', label: 'Week of Jul 20', short: 'Jul 20', value: 4 }];
  [areaChart(points), barChart(points)].forEach((chart) => {
    const texts = findAll(chart, 'text').map(allText).map((t) => t.trim());
    assert.ok(texts.includes('Jul 20'), 'axis uses the short form');
    assert.ok(!texts.some((t) => t.includes('Week of')), 'verbose label stays off the axis');
    assert.ok(tooltips(chart).some((t) => t.startsWith('Week of Jul 20: 4')));
  });
});

test('areaChart: each chart gets its own gradient id, so a re-render cannot cross-link', () => {
  const a = findAll(areaChart(pts([1, 2])), 'linearGradient')[0].attrs.id;
  const b = findAll(areaChart(pts([1, 2])), 'linearGradient')[0].attrs.id;
  assert.notEqual(a, b);
});

// ---- Bar chart -------------------------------------------------------------

test('barChart: bar heights are proportional to the values', () => {
  const bars = findAllByClass(barChart(pts([5, 10])), 'adm-chart-bar');
  assert.equal(bars.length, 2);
  const [h5, h10] = bars.map((b) => Number(b.attrs.height));
  assert.ok(Math.abs(h10 - h5 * 2) < 0.001, 'double the value must be double the bar');
});

test('barChart: a zero bar has zero height — no stub implying activity', () => {
  const bars = findAllByClass(barChart(pts([0, 4])), 'adm-chart-bar');
  assert.equal(Number(bars[0].attrs.height), 0);
  assert.ok(Number(bars[1].attrs.height) > 0);
});

test('barChart: an all-zero series still draws its full axis and every bucket', () => {
  const chart = barChart(pts([0, 0, 0]));
  assert.equal(findAllByClass(chart, 'adm-chart-bar').length, 3);
  assert.ok(findAllByClass(chart, 'adm-grid-line').length > 0);
});

// ---- Ranked bars -----------------------------------------------------------

test('rankedBars: fill width is relative to the LEADER, and the row shows the count', () => {
  const wrap = rankedBars([{ label: 'Kitchen', value: 10 }, { label: 'Bath', value: 5 }]);
  const fills = findAllByClass(wrap, 'adm-ranked-fill');
  assert.equal(fills[0].style.width, '100%');
  assert.equal(fills[1].style.width, '50%');
  assert.ok(allText(wrap).includes('Kitchen'));
  assert.ok(allText(wrap).includes('10'));
});

test('rankedBars: a zero row keeps a sliver so its label still has a bar to sit on', () => {
  const fills = findAllByClass(rankedBars([{ label: 'a', value: 8 }, { label: 'b', value: 0 }]), 'adm-ranked-fill');
  assert.equal(fills[1].style.width, '2%');
});

test('rankedBars: the row tooltip carries the share of the total', () => {
  const rows = findAllByClass(rankedBars([{ label: 'a', value: 3 }, { label: 'b', value: 1 }]), 'adm-ranked-row');
  assert.ok(rows[0].title.includes('75.0%'), rows[0].title);
});

test('rankedBars: colorful mode cycles the palette, plain mode does not', () => {
  const rows = [{ label: 'a', value: 3 }, { label: 'b', value: 2 }];
  const colorful = findAllByClass(rankedBars(rows, { colorful: true }), 'adm-ranked-fill');
  assert.equal(colorful[0].style.background, PALETTE[0]);
  assert.equal(colorful[1].style.background, PALETTE[1]);
  const plain = findAllByClass(rankedBars(rows, { color: '#123456' }), 'adm-ranked-fill');
  assert.ok(plain.every((f) => f.style.background === '#123456'));
});

// ---- Donut -----------------------------------------------------------------

test('donutChart: one arc per slice plus the track, with percentage tooltips', () => {
  const wrap = donutChart([{ label: 'Pro', value: 3 }, { label: 'Free', value: 1 }]);
  assert.equal(findAllByClass(wrap, 'adm-donut-arc').length, 2);
  const tips = tooltips(wrap);
  assert.ok(tips.some((t) => t.includes('Pro: 3') && t.includes('75.0%')), tips.join(' | '));
  assert.ok(tips.some((t) => t.includes('Free: 1') && t.includes('25.0%')));
});

test('donutChart: a single 100% slice draws a full ring, not a zero-length arc', () => {
  const wrap = donutChart([{ label: 'Free', value: 5 }]);
  assert.equal(findAllByClass(wrap, 'adm-donut-arc').length, 0);
  // The track circle plus the full-ring slice circle.
  assert.equal(findAll(wrap, 'circle').length, 2);
});

test('donutChart: zero-value slices are dropped before drawing', () => {
  const wrap = donutChart([{ label: 'Pro', value: 2 }, { label: 'Ent', value: 0 }, { label: 'Free', value: 2 }]);
  assert.equal(findAllByClass(wrap, 'adm-donut-arc').length, 2);
  assert.ok(!allText(wrap).includes('Ent'));
});

test('donutChart: the center shows the total and the legend the per-slice split', () => {
  const wrap = donutChart([{ label: 'Pro', value: 3 }, { label: 'Free', value: 1 }], { centerLabel: 'accounts' });
  const total = findAllByClass(wrap, 'adm-donut-total')[0];
  assert.equal(allText(total).trim(), '4');
  assert.ok(allText(wrap).includes('accounts'));
  assert.equal(findAllByClass(wrap, 'adm-legend-row').length, 2);
});

// ---- Sparkline & chrome ----------------------------------------------------

test('sparkline: needs at least two points to be a line', () => {
  assert.equal(sparkline([]), null);
  assert.equal(sparkline(pts([1])), null);
  assert.equal(sparkline(pts([1, 2, 3])).tagName, 'svg');
});

test('sparkline: an all-zero series is a flat line, not a divide-by-zero', () => {
  const spark = sparkline(pts([0, 0, 0]));
  const ys = findAll(spark, 'path')[1].attrs.d.match(/[ML][\d.]+ ([\d.]+)/g).map((m) => Number(m.split(' ')[1]));
  assert.ok(ys.every((y) => y === ys[0]));
  assert.ok(ys.every((y) => Number.isFinite(y)));
});

test('legend: swatch color, label, and value (with an optional percentage)', () => {
  const wrap = legend([{ label: 'Pro', value: 12, color: '#abc123', pct: 60 }]);
  assert.equal(findAllByClass(wrap, 'adm-legend-dot')[0].style.background, '#abc123');
  const text = allText(wrap);
  assert.ok(text.includes('Pro'));
  assert.ok(text.includes('12 · 60%'));
  // No pct supplied → value only, no stray separator.
  assert.ok(!allText(legend([{ label: 'a', value: 1, color: '#000' }])).includes('·'));
});

test('chartCard: title, optional sub-caption, body, and optional note chips', () => {
  const body = globalThis.document.createElement('div');
  body.textContent = 'BODY';
  const card = chartCard({ title: 'Renders', sub: 'per day', body, notes: ['Avg 3', 'Peak 9'] });
  assert.ok(hasClass(card, 'adm-chart-card'));
  const text = allText(card);
  ['Renders', 'per day', 'BODY', 'Avg 3', 'Peak 9'].forEach((t) => assert.ok(text.includes(t), 'missing ' + t));

  // Omitted sub/notes must not leave empty chrome behind.
  const bare = chartCard({ title: 'T', body: globalThis.document.createElement('div') });
  assert.equal(findAllByClass(bare, 'adm-chart-sub').length, 0);
  assert.equal(findAllByClass(bare, 'adm-chart-notes').length, 0);
});
