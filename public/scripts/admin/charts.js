// Hand-rolled SVG chart primitives for the admin dashboard. No charting library —
// the app has no build step (see docs/guides/architecture.md), so a dependency
// would mean shipping a vendored bundle for a handful of shapes.
//
// Conventions every chart here follows:
//
//  - **Fixed viewBox, fluid box.** Each chart draws into a fixed user-space grid
//    (`VB_W` × its own height) and is sized with CSS width:100%. The browser
//    scales it, so nothing here needs to measure the DOM — which is also what
//    makes the module testable against a stub `document`.
//  - **Tooltips are native `<title>`.** Every bar/point carries a `<title>`
//    child, so hovering shows the exact value with no listeners, no positioning
//    math, and no cleanup. Interaction-free charts can't leak handlers when a
//    panel re-renders.
//  - **Data in, element out.** A chart takes a plain array and returns a
//    detached element. It never reads app state and never touches the document
//    outside the tree it builds.

/** @typedef {{key?: string, label: string, short?: string, value: number}} Point */

const NS = 'http://www.w3.org/2000/svg';

// Default user-space width of a cartesian chart. Charts are scaled uniformly by
// CSS (width:100%, height:auto), so this number is really an INVERSE FONT SIZE:
// the wider the viewBox relative to the box the chart lands in, the smaller the
// axis text renders. 1000 keeps the 11px axis labels near 11 real px in a
// full-width card; a chart dropped into a ~400px grid cell must pass a matching
// `width` (see insights.js) or its labels shrink to unreadable.
const VB_W = 1000;

// Monotonic suffix for gradient ids. Panels re-render on every refresh and two
// charts can share a color, so a color-derived id would collide — and a `fill:
// url(#id)` resolves against the FIRST match in the document, which would leave
// the second chart pointing at a detached gradient once the first is replaced.
let gradSeq = 0;

/** Series colors, in the order a multi-slice chart consumes them. */
export const PALETTE = ['#2563eb', '#7c3aed', '#16a34a', '#d97706', '#db2777', '#0891b2', '#dc2626', '#64748b'];

/**
 * @param {string} tag
 * @param {Record<string, string|number>} [attrs]
 * @param {Array<Node|string|null>} [children]
 * @returns {SVGElement}
 */
function svg(tag, attrs, children) {
  const node = document.createElementNS(NS, tag);
  if (attrs) Object.keys(attrs).forEach((k) => node.setAttribute(k, String(attrs[k])));
  if (children) children.forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function tip(text) { return svg('title', null, [String(text)]); }

/** Thousands separators for tooltips/captions. @param {number} n @returns {string} */
export function fmtNum(n) { return Number(n || 0).toLocaleString(); }

/**
 * Short axis form: 1.2k / 3.4M. Axis ticks compete for very little space, so
 * they trade exactness for width — tooltips still carry the full number.
 * @param {number} n
 * @returns {string}
 */
export function fmtCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'M';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(v * 10) / 10);
}

/**
 * A "nice" axis maximum at or above the data peak — 1/2/5×10ⁿ — so gridline
 * labels land on round numbers instead of 37, 74, 111.
 * @param {number} max
 * @returns {number}
 */
export function niceMax(max) {
  const v = Number(max) || 0;
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * The card chrome every chart sits in: title, optional sub-caption, the chart
 * body, and an optional right-aligned stat strip under it. Kept here so the two
 * panels can't drift into two slightly different card shapes.
 * @param {{title: string, sub?: string, body: Node, notes?: string[], wide?: boolean}} spec
 * @returns {HTMLElement}
 */
export function chartCard(spec) {
  const card = document.createElement('section');
  card.className = 'adm-card adm-chart-card' + (spec.wide ? ' adm-chart-card--wide' : '');

  const head = document.createElement('div');
  head.className = 'adm-chart-head';
  const h = document.createElement('h2');
  h.textContent = spec.title;
  head.appendChild(h);
  if (spec.sub) {
    const s = document.createElement('p');
    s.className = 'adm-chart-sub';
    s.textContent = spec.sub;
    head.appendChild(s);
  }
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'adm-chart-body';
  body.appendChild(spec.body);
  card.appendChild(body);

  if (spec.notes && spec.notes.length) {
    const notes = document.createElement('div');
    notes.className = 'adm-chart-notes';
    spec.notes.forEach((n) => {
      const item = document.createElement('span');
      item.textContent = n;
      notes.appendChild(item);
    });
    card.appendChild(notes);
  }
  return card;
}

/** Placeholder for a chart with nothing to draw. @param {string} [msg] @returns {HTMLElement} */
export function chartEmpty(msg) {
  const p = document.createElement('p');
  p.className = 'adm-chart-empty';
  p.textContent = msg || 'No data yet.';
  return p;
}

/**
 * Swatch + label + value row set, shared by the donut and the stacked bar.
 * @param {Array<{label: string, value: number, color: string, pct?: number}>} items
 * @returns {HTMLElement}
 */
export function legend(items) {
  const wrap = document.createElement('div');
  wrap.className = 'adm-legend';
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'adm-legend-row';
    const dot = document.createElement('span');
    dot.className = 'adm-legend-dot';
    dot.style.background = it.color;
    const label = document.createElement('span');
    label.className = 'adm-legend-label';
    label.textContent = it.label;
    const val = document.createElement('span');
    val.className = 'adm-legend-val';
    val.textContent = fmtNum(it.value) + (it.pct === undefined ? '' : ' · ' + it.pct.toFixed(0) + '%');
    row.appendChild(dot); row.appendChild(label); row.appendChild(val);
    wrap.appendChild(row);
  });
  return wrap;
}

// Horizontal gridlines + their value labels, drawn behind every cartesian chart.
function gridLines(top, plotH, plotW, left, max, ticks) {
  const g = svg('g', { class: 'adm-grid' });
  for (let i = 0; i <= ticks; i++) {
    const value = (max / ticks) * i;
    const y = top + plotH - (plotH * i) / ticks;
    g.appendChild(svg('line', { x1: left, y1: y, x2: left + plotW, y2: y, class: 'adm-grid-line' }));
    g.appendChild(svg('text', { x: left - 8, y: y + 4, class: 'adm-axis-text', 'text-anchor': 'end' }, [fmtCompact(value)]));
  }
  return g;
}

// X labels thinned to at most `maxLabels`, always keeping the last bucket so the
// axis ends on "now" rather than on whatever the stride happened to hit. That
// forced last label is off the stride, so it can land almost on top of the
// preceding one — hence the clearance check, which drops the strided label
// instead of letting the two collide.
function xLabels(points, top, plotH, plotW, left, maxLabels) {
  const g = svg('g');
  const last = points.length - 1;
  const stride = Math.max(1, Math.ceil(points.length / maxLabels));
  const clearance = Math.max(1, Math.round(stride * 0.6));
  const slot = plotW / points.length;
  points.forEach((p, i) => {
    if (i !== last) {
      if (i % stride !== 0) return;
      if (last - i < clearance) return;
    }
    const x = left + slot * i + slot / 2;
    g.appendChild(svg('text', { x, y: top + plotH + 18, class: 'adm-axis-text', 'text-anchor': 'middle' }, [p.short || p.label]));
  });
  return g;
}

/**
 * Area + line chart over a dense series (daily/weekly/monthly counts). Hover is
 * a full-height transparent column per bucket, so the tooltip is reachable even
 * where the series sits at zero.
 * @param {Point[]} points
 * @param {{height?: number, width?: number, color?: string, unit?: string, maxLabels?: number}} [opts]
 * @returns {SVGElement|HTMLElement}
 */
export function areaChart(points, opts = {}) {
  if (!points || !points.length) return chartEmpty();
  const height = opts.height || 240;
  const vbW = opts.width || VB_W;
  const color = opts.color || PALETTE[0];
  const unit = opts.unit || '';
  const left = 44;
  const top = 12;
  const bottom = 30;
  const plotW = vbW - left - 16;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max.apply(null, points.map((p) => p.value)));
  const slot = plotW / points.length;
  const xAt = (i) => left + slot * i + slot / 2;
  const yAt = (v) => top + plotH - (plotH * (v / max));

  const root = svg('svg', {
    viewBox: '0 0 ' + vbW + ' ' + height,
    class: 'adm-chart-svg',
    role: 'img',
  });

  const gradId = 'admgrad-' + (++gradSeq);
  root.appendChild(svg('defs', null, [
    svg('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.34' }),
      svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0.02' }),
    ]),
  ]));
  root.appendChild(gridLines(top, plotH, plotW, left, max, 4));

  const line = points.map((p, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(p.value).toFixed(1)).join(' ');
  root.appendChild(svg('path', {
    d: line + ' L' + xAt(points.length - 1).toFixed(1) + ' ' + (top + plotH) + ' L' + xAt(0).toFixed(1) + ' ' + (top + plotH) + ' Z',
    fill: 'url(#' + gradId + ')',
  }));
  root.appendChild(svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': '2.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // Dots only on a sparse series — at 90+ buckets they merge into a smear.
  if (points.length <= 45) {
    points.forEach((p, i) => {
      root.appendChild(svg('circle', { cx: xAt(i), cy: yAt(p.value), r: 2.6, fill: '#fff', stroke: color, 'stroke-width': '2' }));
    });
  }

  points.forEach((p, i) => {
    root.appendChild(svg('rect', {
      x: left + slot * i, y: top, width: slot, height: plotH, class: 'adm-chart-hit',
    }, [tip(p.label + ': ' + fmtNum(p.value) + (unit ? ' ' + unit : ''))]));
  });

  root.appendChild(xLabels(points, top, plotH, plotW, left, opts.maxLabels || 8));
  return root;
}

/**
 * Vertical bar chart. Same axis furniture as {@link areaChart}; used where the
 * buckets are categorical (hour of day, weekday) or sparse enough that discrete
 * columns read better than a line.
 * @param {Point[]} points
 * @param {{height?: number, width?: number, color?: string, unit?: string, maxLabels?: number}} [opts]
 * @returns {SVGElement|HTMLElement}
 */
export function barChart(points, opts = {}) {
  if (!points || !points.length) return chartEmpty();
  const height = opts.height || 220;
  const vbW = opts.width || VB_W;
  const color = opts.color || PALETTE[0];
  const unit = opts.unit || '';
  const left = 44;
  const top = 12;
  const bottom = 30;
  const plotW = vbW - left - 16;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max.apply(null, points.map((p) => p.value)));
  const slot = plotW / points.length;
  const barW = Math.max(2, Math.min(slot * 0.68, 46));

  const root = svg('svg', { viewBox: '0 0 ' + vbW + ' ' + height, class: 'adm-chart-svg', role: 'img' });
  root.appendChild(gridLines(top, plotH, plotW, left, max, 4));

  points.forEach((p, i) => {
    const h = (plotH * (p.value / max));
    const x = left + slot * i + (slot - barW) / 2;
    root.appendChild(svg('rect', {
      x, y: top + plotH - h, width: barW, height: Math.max(h, p.value > 0 ? 2 : 0),
      rx: Math.min(4, barW / 2), fill: color, class: 'adm-chart-bar',
    }, [tip(p.label + ': ' + fmtNum(p.value) + (unit ? ' ' + unit : ''))]));
  });

  root.appendChild(xLabels(points, top, plotH, plotW, left, opts.maxLabels || 12));
  return root;
}

/**
 * Horizontal ranked bars — the readable shape for a category axis with long,
 * variable-length labels (room types, styles, referral sources).
 * @param {Array<{label: string, value: number}>} rows
 * @param {{color?: string, unit?: string, colorful?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function rankedBars(rows, opts = {}) {
  if (!rows || !rows.length) return chartEmpty();
  const max = Math.max.apply(null, rows.map((r) => r.value)) || 1;
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const wrap = document.createElement('div');
  wrap.className = 'adm-ranked';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'adm-ranked-row';
    row.title = r.label + ': ' + fmtNum(r.value) + (opts.unit ? ' ' + opts.unit : '') + ' · ' + ((r.value / total) * 100).toFixed(1) + '%';

    const label = document.createElement('span');
    label.className = 'adm-ranked-label';
    label.textContent = r.label;

    const track = document.createElement('span');
    track.className = 'adm-ranked-track';
    const fill = document.createElement('span');
    fill.className = 'adm-ranked-fill';
    fill.style.width = Math.max(2, (r.value / max) * 100) + '%';
    fill.style.background = opts.colorful ? PALETTE[i % PALETTE.length] : (opts.color || PALETTE[0]);
    track.appendChild(fill);

    const val = document.createElement('span');
    val.className = 'adm-ranked-val';
    val.textContent = fmtNum(r.value);

    row.appendChild(label); row.appendChild(track); row.appendChild(val);
    wrap.appendChild(row);
  });
  return wrap;
}

/**
 * Donut with a centered total and a legend beside it. Slices are drawn as arcs
 * on a single circle; a lone 100% slice becomes a full ring, because an arc
 * whose start and end coincide would otherwise render as nothing.
 * @param {Array<{label: string, value: number}>} slices
 * @param {{size?: number, centerLabel?: string, colors?: string[]}} [opts]
 * @returns {HTMLElement}
 */
export function donutChart(slices, opts = {}) {
  const data = (slices || []).filter((s) => s.value > 0);
  if (!data.length) return chartEmpty();
  const size = opts.size || 190;
  const colors = opts.colors || PALETTE;
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = size / 2 - 14;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = 26;

  const root = svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'adm-donut-svg', role: 'img' });
  root.appendChild(svg('circle', { cx, cy, r, fill: 'none', stroke: '#eef2f7', 'stroke-width': stroke }));

  let angle = -Math.PI / 2;
  data.forEach((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const color = colors[i % colors.length];
    const label = d.label + ': ' + fmtNum(d.value) + ' · ' + ((d.value / total) * 100).toFixed(1) + '%';
    if (data.length === 1) {
      root.appendChild(svg('circle', { cx, cy, r, fill: 'none', stroke: color, 'stroke-width': stroke }, [tip(label)]));
    } else {
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + sweep);
      const y2 = cy + r * Math.sin(angle + sweep);
      root.appendChild(svg('path', {
        d: 'M' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (sweep > Math.PI ? 1 : 0) + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2),
        fill: 'none', stroke: color, 'stroke-width': stroke, class: 'adm-donut-arc',
      }, [tip(label)]));
    }
    angle += sweep;
  });

  root.appendChild(svg('text', { x: cx, y: cy - 2, class: 'adm-donut-total', 'text-anchor': 'middle' }, [fmtCompact(total)]));
  if (opts.centerLabel) {
    root.appendChild(svg('text', { x: cx, y: cy + 16, class: 'adm-donut-sub', 'text-anchor': 'middle' }, [opts.centerLabel]));
  }

  const wrap = document.createElement('div');
  wrap.className = 'adm-donut';
  wrap.appendChild(root);
  wrap.appendChild(legend(data.map((d, i) => ({
    label: d.label, value: d.value, color: colors[i % colors.length], pct: (d.value / total) * 100,
  }))));
  return wrap;
}

/**
 * Tiny inline trend line for a stat card — no axes, no labels, just the shape.
 * @param {Point[]} points
 * @param {{color?: string}} [opts]
 * @returns {SVGElement|null}
 */
export function sparkline(points, opts = {}) {
  if (!points || points.length < 2) return null;
  const w = 100;
  const h = 28;
  const color = opts.color || PALETTE[0];
  const max = Math.max.apply(null, points.map((p) => p.value)) || 1;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + (h - (p.value / max) * (h - 3) - 1.5).toFixed(1)).join(' ');
  const root = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'adm-spark', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  root.appendChild(svg('path', { d: d + ' L' + w + ' ' + h + ' L0 ' + h + ' Z', fill: color, opacity: '0.12' }));
  root.appendChild(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return root;
}
