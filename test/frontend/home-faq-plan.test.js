// Tier: pure frontend logic + markup drift guards — public/scripts/home-faq-plan.js.
//
// The module turns #faq into an architectural sheet. It generates SVG and nothing else:
// the accordion is native <details>, so none of the FAQ's actual behaviour is at risk
// here. What IS fragile is the geometry contract, and that is what this file exists for.
//
//  1. THE ROOM TABLE IS AUTHORED IN HTML, NOT IN JS. Each <details> carries
//     `--x/--y/--w/--h` in an inline style; CSS lays the box out from them and this
//     module derives every wall, door and dimension from the same numbers. That makes
//     drift between the drawing and the boxes impossible — but it moves the risk INTO
//     the table. Two rooms overlapping, one escaping the envelope, or a door opening
//     into a neighbour's living room all render perfectly happily and are simply wrong.
//     Only a test sees it.
//
//  2. `data-lang` ASSIGNS textContent. A key on the <summary> would delete the label
//     span and the question span on the first translation pass. It works flawlessly in
//     English — the failure only appears once somebody switches language, which is
//     exactly the bug home-whyus.test.js:253 was written for.
//
//  3. THE ACCORDION IS THE FALLBACK, NOT LEGACY. Below 1001px, in print, and with either
//     asset missing, .faq-q / .faq-accordion in home.css is the whole section. Dropping
//     those class names "because the drawing replaced them" would delete the fallback
//     for every phone. guides.html shares them and must stay untouched.
//
// Room sizes are never written down here. They are derived from the markup through the
// module's own roomMetrics(), so this file cannot disagree with what ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  FURNITURE,
  LABEL_BAND,
  rectPath,
  doorArc,
  roomMetrics,
  doorSwing,
  readRooms,
  sweepOrder,
  wireSelectionGuard,
  wireDeepLinks,
  roomId,
  answerTop,
  ANSWER_GAP,
} = await import('../../public/scripts/home-faq-plan.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const GUIDES = fs.readFileSync(path.join(PUBLIC, 'guides.html'), 'utf8');

/** The building envelope and the crossing corridors, in percent of the sheet. */
const ENVELOPE = { x: 4, y: 7, w: 59, h: 83 };
const CORRIDORS = [
  { x: 24, y: 7, w: 6, h: 83 },
  { x: 4, y: 46, w: 59, h: 9 },
];

/** viewBox units per 1% of the sheet — the module's UX/UY, used only to size the ink. */
const UX = 11.6;
const UY = 7.6;

/**
 * Every `<details class="faq-q faq-room">` in index.html with its authored geometry.
 * @returns {Array<{key: string, door: string, no: string, x: number, y: number, w: number, h: number, tag: string, body: string}>}
 */
function roomsInMarkup() {
  const out = [];
  const block = /<details\b([^>]*\bclass="faq-q faq-room"[^>]*)>([\s\S]*?)<\/details>/g;
  for (const [, tag, body] of INDEX.matchAll(block)) {
    const attr = (/** @type {string} */ n) => (tag.match(new RegExp(`\\b${n}="([^"]*)"`)) || [])[1] || '';
    const style = attr('style');
    const prop = (/** @type {string} */ n) => parseFloat((style.match(new RegExp(`--${n}:\\s*(-?[\\d.]+)`)) || [])[1]);
    out.push({
      key: attr('data-room'), door: attr('data-door'), no: attr('data-no'),
      x: prop('x'), y: prop('y'), w: prop('w'), h: prop('h'),
      tag, body,
    });
  }
  return out;
}

/** Real-world size of every room, keyed by name, straight from the shipped markup. */
function roomSizes() {
  /** @type {Record<string, {wm: number, hm: number}>} */
  const sizes = {};
  for (const r of roomsInMarkup()) sizes[r.key] = roomMetrics(r);
  return sizes;
}

// --------------------------------------------------------------------------
// Pure geometry
// --------------------------------------------------------------------------

test('rectPath traces the outline clockwise from the top-left', () => {
  // The winding used to be load-bearing — it was the order stroke-dashoffset revealed the
  // wall in, and anticlockwise made the highlight trace backwards. That reveal is gone
  // (the rectangle fades in finished), so this is now just the path a drafter would write.
  assert.equal(rectPath(232, 182.4), 'M0 0H232V182.4H0Z');
  assert.equal(rectPath(100.04, 50.06), 'M0 0H100V50.1H0Z', 'coordinates round to 0.1');
});

test('doorArc hinges on the named wall and swings into the room', () => {
  // Each wall needs its own sweep flag because SVG measures angles in a y-down system.
  // The wrong flag swings the door out through the wall.
  assert.equal(doorArc('s0.62', 232, 182.4), 'M143.8 182.4V141.9M143.8 141.9A40.5 40.5 0 0 1 184.3 182.4');
  assert.equal(doorArc('n0.68', 220.4, 182.4), 'M149.9 0V40.5M149.9 40.5A40.5 40.5 0 0 0 190.4 0');
  assert.equal(doorArc('w0.35', 232, 182.4), 'M0 63.8H40.5M40.5 63.8A40.5 40.5 0 0 1 0 104.3');
  assert.equal(doorArc('e0.50', 232, 182.4), 'M232 91.2H191.5M191.5 91.2A40.5 40.5 0 0 0 232 131.7');
});

test('a door near a corner is pulled back instead of overhanging it', () => {
  // A leaf hinged at 98% along the wall would otherwise swing past the corner and hang
  // in the neighbouring room.
  assert.equal(doorArc('n0.98', 232, 182.4), 'M191.5 0V40.5M191.5 40.5A40.5 40.5 0 0 0 232 0');
  assert.match(doorArc('n0.5', 40, 40), /A28 28 /, 'and shrinks to fit a wall shorter than a door');
});

test('an unparseable door yields no door, never an exception', () => {
  // A typo in data-door must cost one door, not the whole section: a throw here happens
  // inside initFaqPlan's room loop and would abort every room after it.
  for (const bad of ['', 'zzz', 'n', 'x0.5', 'n2', 'n-0.5', undefined, null]) {
    assert.equal(doorArc(/** @type {string} */ (bad), 100, 100), '');
  }
});

test('roomMetrics converts percentages to metres at a single isotropic scale', () => {
  // 45 viewBox units per metre on BOTH axes. If the two ever disagree, the scale bar in
  // index.html becomes a lie and furniture specified in metres distorts.
  const { wm, hm, area } = roomMetrics({ w: 20, h: 24 });
  assert.equal(+wm.toFixed(3), 5.156);
  assert.equal(+hm.toFixed(3), 4.053);
  assert.equal(+area.toFixed(2), 20.9);

  // The envelope must come out as the figures the marginalia prints beside it.
  const env = roomMetrics({ w: ENVELOPE.w, h: ENVELOPE.h });
  assert.equal(env.wm.toFixed(1), '15.2');
  assert.equal(env.hm.toFixed(1), '14.0');
  assert.match(INDEX, />15\.2 m</, 'the drawn width dimension matches roomMetrics');
  assert.match(INDEX, />14\.0 m</, 'the drawn depth dimension matches roomMetrics');
});

// --------------------------------------------------------------------------
// readRooms, against a fake DOM
// --------------------------------------------------------------------------

/**
 * A stand-in for one <details>, plus the getComputedStyle the module reads it through.
 * @param {string} key @param {Record<string, string>} props
 */
function fakeRoom(key, props) {
  return {
    props,
    getAttribute: (/** @type {string} */ n) =>
      n === 'data-room' ? key : n === 'data-door' ? 'n0.5' : n === 'data-no' ? '01' : null,
  };
}

/** @param {any[]} rooms @param {() => void} fn */
function withFakeDom(rooms, fn) {
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = /** @type {any} */ ((el) => ({
    getPropertyValue: (/** @type {string} */ n) => (el.props[n] ?? ''),
  }));
  try {
    fn();
  } finally {
    globalThis.getComputedStyle = prev;
  }
}

test('readRooms lifts the geometry back off the elements', () => {
  const rooms = [fakeRoom('privacy', { '--x': '24', '--y': '69', '--w': '19', '--h': '21' })];
  const root = /** @type {any} */ ({ querySelectorAll: () => rooms });
  withFakeDom(rooms, () => {
    const [room] = readRooms(root);
    assert.deepEqual(
      { key: room.key, no: room.no, x: room.x, y: room.y, w: room.w, h: room.h, door: room.door },
      { key: 'privacy', no: '01', x: 24, y: 69, w: 19, h: 21, door: 'n0.5' }
    );
  });
});

test('readRooms skips a room missing a coordinate instead of emitting NaN', () => {
  // NaN in a path `d` is "ignore the attribute" in some engines and "render nothing" in
  // others. One inert room is a far better failure than a blank section.
  const rooms = [
    fakeRoom('good', { '--x': '4', '--y': '7', '--w': '20', '--h': '24' }),
    fakeRoom('broken', { '--x': '24', '--y': '7', '--w': '', '--h': '24' }),
  ];
  const root = /** @type {any} */ ({ querySelectorAll: () => rooms });
  withFakeDom(rooms, () => {
    assert.deepEqual(readRooms(root).map((r) => r.key), ['good']);
  });
});

// --------------------------------------------------------------------------
// The draft-in sweep order
// --------------------------------------------------------------------------

test('the sweep runs down the diagonal, not down the source order', () => {
  // WHY THIS IS NOT `map((_, i) => i)`: the markup is column-major — 01,02 fill the left
  // bay, 03,04 the middle, 05 is the tall right one, and 06 starts again at the far left.
  // A stagger on the source index therefore throws the eye back across the sheet, which is
  // what made three separate waves out of one entrance.
  //
  // The assertion is that the sweep never doubles back along the diagonal. Note the weaker
  // check this replaces: "no room starts before one strictly above AND left of it" LOOKS
  // like the same property and passes for the DOM order too, because the source happens to
  // fill the top band before the bottom one. It caught nothing.
  const rooms = roomsInMarkup();
  const n = sweepOrder(rooms);
  assert.deepEqual([...n].sort((p, q) => p - q), rooms.map((_, i) => i), 'a permutation');

  const maxX = Math.max(...rooms.map((r) => r.x + r.w));
  const maxY = Math.max(...rooms.map((r) => r.y + r.h));
  const diagonal = (/** @type {{x:number,y:number,w:number,h:number}} */ r) =>
    (r.x + r.w / 2) / maxX + (r.y + r.h / 2) / maxY;

  const order = rooms.map((r, i) => ({ r, i })).sort((a, b) => n[a.i] - n[b.i]);
  for (let k = 1; k < order.length; k += 1) {
    const [prev, cur] = [order[k - 1].r, order[k].r];
    assert.ok(
      diagonal(cur) >= diagonal(prev),
      `the sweep goes backwards at step ${k}: ${cur.key} sits up-sheet of ${prev.key}`
    );
  }
  // The shipped markup must actually need the reorder — if this ever coincides with the
  // source order, sweepOrder has quietly become a no-op and the room table moved under it.
  assert.notDeepEqual(n, rooms.map((_, i) => i), 'the room table is not already in sweep order');
});

test('the plan drafts on the same gate that fades its own container in', () => {
  // `.faq-plan` is itself a `.reveal`, so home-reveal.js's 20px rise and this module's
  // wall-drawing play on the same pixels. They used different thresholds (0.18 vs 0.12)
  // and different root margins, so the walls started tracing themselves while the box was
  // still sliding up — one section, two animations, visibly out of phase.
  //
  // The two numbers cannot be shared: home-faq-plan.js deliberately does NOT watch
  // `.is-visible`, because home-reveal.js's showAll() fallback sets it on every element
  // at once and the sheet would draft in far below the fold. So they are copies, and a
  // copy needs a guard. Read out of the source rather than by running either module —
  // both are `load`-time side-effect scripts.
  const src = (/** @type {string} */ name) =>
    fs.readFileSync(path.join(PUBLIC, 'scripts', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const reveal = src('home-reveal.js');
  const plan = src('home-faq-plan.js');

  const showAt = /SHOW_AT\s*=\s*([\d.]+)/.exec(reveal);
  assert.ok(showAt, 'home-reveal.js still names its show threshold SHOW_AT');
  const revealMargin = /rootMargin:\s*["']([^"']+)["']/.exec(reveal);
  assert.ok(revealMargin, 'home-reveal.js still passes a rootMargin');

  const gate = /\{\s*threshold:\s*([\d.]+),\s*rootMargin:\s*["']([^"']+)["']\s*\}/.exec(plan);
  assert.ok(gate, 'home-faq-plan.js still gates the draft-in on a single-threshold observer');

  assert.equal(gate[1], showAt[1], 'the draft-in threshold must equal home-reveal.js SHOW_AT');
  assert.equal(gate[2], revealMargin[1], 'the draft-in rootMargin must equal home-reveal.js rootMargin');
});

test('the sweep index is a stable permutation even when the ranks tie', () => {
  // Two rooms stacked at the same centre have the same rank. Without the DOM-index
  // tiebreak the engine's sort decides, and the delays would differ between browsers for
  // no visible reason — the kind of drift nobody thinks to look for.
  const stacked = [
    { key: 'a', x: 0, y: 0, w: 10, h: 10 },
    { key: 'b', x: 0, y: 0, w: 10, h: 10 },
    { key: 'c', x: 10, y: 10, w: 10, h: 10 },
  ];
  assert.deepEqual(sweepOrder(/** @type {any} */ (stacked)), [0, 1, 2]);
  // A single room divides by its own extent; the rank is finite but the fallback must
  // hold regardless, so the one room is still index 0 rather than undefined.
  assert.deepEqual(sweepOrder(/** @type {any} */ ([stacked[0]])), [0]);
});

// --------------------------------------------------------------------------
// The plan holds together as a building
// --------------------------------------------------------------------------

test('index.html authors nine rooms, each fully specified', () => {
  const rooms = roomsInMarkup();
  assert.equal(rooms.length, 9, 'nine rooms on the sheet');
  const seen = new Set();
  for (const room of rooms) {
    assert.ok(room.key, 'every room has a data-room key');
    assert.ok(room.door, `${room.key} has no data-door`);
    assert.match(room.no, /^0[1-9]$/, `${room.key} has no two-digit data-no key number`);
    assert.ok(!seen.has(room.no), `key number ${room.no} is used twice`);
    seen.add(room.no);
    for (const axis of /** @type {const} */ (['x', 'y', 'w', 'h'])) {
      assert.ok(
        Number.isFinite(room[axis]),
        `${room.key} has no numeric --${axis}; readRooms would skip it and the room would ` +
          'render as an unlabelled hole in the plan'
      );
    }
  }
});

test('no two rooms overlap, and none escapes the envelope', () => {
  // The guard that makes the geometry table safe to edit. An overlap renders as two
  // rooms sharing a floor — valid SVG, obviously wrong drawing, invisible to every other
  // check in the suite.
  const rooms = roomsInMarkup();
  for (const a of rooms) {
    assert.ok(
      a.x >= ENVELOPE.x && a.y >= ENVELOPE.y &&
        a.x + a.w <= ENVELOPE.x + ENVELOPE.w && a.y + a.h <= ENVELOPE.y + ENVELOPE.h,
      `${a.key} (${a.x},${a.y} ${a.w}x${a.h}) escapes the envelope drawn in the marginalia`
    );
    for (const b of rooms) {
      if (a === b) continue;
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlaps, `${a.key} overlaps ${b.key}`);
    }
  }
});

test('every door opens onto a corridor, not into the neighbour', () => {
  // The circulation is what makes this read as a plan rather than a grid, and a door
  // hung on the wrong wall quietly breaks that while still drawing a tidy arc. Checked
  // on all four walls, because the corridors now cross: some rooms open east or west
  // onto the spine and some open north or south onto the cross-arm.
  const near = (p, q) => Math.abs(p - q) < 0.01;
  for (const room of roomsInMarkup()) {
    assert.notEqual(
      doorArc(room.door, room.w * UX, room.h * UY), '',
      `${room.key} has data-door="${room.door}", which doorArc cannot parse — it would be ` +
        'drawn sealed'
    );
    const wall = room.door[0];
    const served = CORRIDORS.some((c) => {
      // The wall has to sit ON the corridor's edge AND actually overlap its run —
      // touching a corridor's extended line somewhere off its end is not a doorway.
      if (wall === 'n') return near(c.y + c.h, room.y) && c.x < room.x + room.w && room.x < c.x + c.w;
      if (wall === 's') return near(c.y, room.y + room.h) && c.x < room.x + room.w && room.x < c.x + c.w;
      if (wall === 'w') return near(c.x + c.w, room.x) && c.y < room.y + room.h && room.y < c.y + c.h;
      return near(c.x, room.x + room.w) && c.y < room.y + room.h && room.y < c.y + c.h;
    });
    assert.ok(served, `${room.key}'s ${wall} door does not open onto a corridor`);
  }
});

test('nothing is parked inside a door swing', () => {
  // A plan with an armchair sitting in the arc of its own door is the clearest possible
  // tell that nobody drew it. The swing is a quarter-circle of fixed radius at a known
  // hinge, so the clash is arithmetic and a test can see what a screenshot only shows
  // in whichever room you happen to open.
  const sizes = roomSizes();
  for (const room of roomsInMarkup()) {
    const { wm, hm } = sizes[room.key];
    const swing = doorSwing(room.door, wm, hm);
    assert.ok(swing, `${room.key} has no parsable door`);
    for (const [symbol, fx, fy, itemW, itemH] of FURNITURE[room.key]) {
      const hw = itemW / wm / 2;
      const hh = itemH / hm / 2;
      const hits =
        fx - hw < swing.x1 && swing.x0 < fx + hw && fy - hh < swing.y1 && swing.y0 < fy + hh;
      assert.ok(
        !hits,
        `${room.key}: "${symbol}" sits in the swing of the ${room.door[0]} door ` +
          `(swing x ${swing.x0.toFixed(2)}-${swing.x1.toFixed(2)}, ` +
          `y ${swing.y0.toFixed(2)}-${swing.y1.toFixed(2)}). Move it clear.`
      );
    }
  }
});

test('every room is a plausible room, not a corridor', () => {
  // Three shallow bands once made every "room" 6.2m x 2.6m, which is a hallway. Real
  // furniture at real scale looks absurd in one, and that is what gave the first version
  // away. Nothing enforced it, so it is enforced here.
  for (const [key, { wm, hm }] of Object.entries(roomSizes())) {
    const area = wm * hm;
    assert.ok(area >= 12 && area <= 34, `${key} is ${area.toFixed(1)} m², not a believable room`);
    const ratio = Math.max(wm, hm) / Math.min(wm, hm);
    assert.ok(ratio <= 1.7, `${key} is ${ratio.toFixed(2)}:1 — that is a corridor, not a room`);
  }
});

// --------------------------------------------------------------------------
// Furniture
// --------------------------------------------------------------------------

test('every room has furniture, drawn from symbols that exist', () => {
  // Renaming a room key regenerates the markup but would leave this table pointing at
  // the old name, and an unfurnished room reads as a rendering bug rather than a missing
  // entry.
  for (const room of roomsInMarkup()) {
    const items = FURNITURE[room.key];
    assert.ok(items && items.length >= 3, `room "${room.key}" needs at least three pieces`);
    for (const [symbol] of items) {
      assert.ok(
        INDEX.includes(`<symbol id="${symbol}"`),
        `${room.key} places "${symbol}", which is not defined in index.html's <defs>`
      );
    }
  }
});

test('every symbol in the defs is actually placed by a room', () => {
  // The OTHER direction, and the one that goes wrong quietly. Restyling a room swaps
  // `fp-round` for `fp-coffee` and the check above stays green — the symbol it stopped
  // naming is still defined, just never drawn. It is then dead markup inside index.html's
  // inline <defs>, which is render-blocking bytes on the page whose LCP is already the
  // thing being budgeted, and nothing on the page can ever reveal it.
  //
  // <symbol> only. The two <pattern>s (fp-grid, fp-hatch) are painted by CSS `fill:
  // url(#…)` rather than placed from this table, and fp-wall/floor/door/furn/key are
  // classes mountRoom generates, not symbols — none of them can appear in FURNITURE, so
  // matching on `<symbol id="fp-…"` is what keeps this check about placeable pieces.
  const placed = new Set(Object.values(FURNITURE).flat().map(([symbol]) => symbol));
  for (const [, id] of INDEX.matchAll(/<symbol id="(fp-[^"]+)"/g)) {
    assert.ok(
      placed.has(id),
      `"${id}" is defined in index.html's <defs> but no room places it — it cannot render, ` +
      'so either give it to a room or delete the symbol.'
    );
  }
});

test('every furniture symbol fills its box instead of being letterboxed into it', () => {
  // THE ONE THAT MADE THE METRE SIZES FICTION. mountRoom sizes each <use> to a real
  // footprint — 108 x 40.5 units for a 2.4 x 0.9 m sofa. A <symbol> without
  // `preserveAspectRatio="none"` takes the default, xMidYMid meet, which scales its 24x24
  // viewBox by the SMALLER of the two ratios and centres the result: that sofa drew as a
  // 0.9 m square, a 1.8 m bookcase as a stub a third of its length, and every layout number
  // in FURNITURE was decorative. Nothing failed. The plan just looked like a wireframe, and
  // the reason was invisible in both the table and the symbol.
  //
  // Scoped to the fp-* furniture: the two <pattern>s in the same <defs> have no viewBox and
  // are not sized to anything, and the sheet's own drawing is authored in viewBox units.
  const symbols = [...INDEX.matchAll(/<symbol id="(fp-[^"]+)"([^>]*)>/g)];
  assert.ok(symbols.length >= 10, 'the furniture symbols are defined in index.html');
  for (const [, id, attrs] of symbols) {
    assert.match(
      attrs, /preserveAspectRatio="none"/,
      `"${id}" would be letterboxed to its smaller side, silently ignoring the metre `
      + 'footprint every placement of it declares'
    );
    assert.match(
      attrs, /vector-effect="non-scaling-stroke"/,
      `"${id}" is stretched non-uniformly to its footprint, so without a non-scaling stroke `
      + 'its horizontals and verticals draw at different weights'
    );
  }
});

test('no placement stretches a symbol far from the proportions it is drawn in', () => {
  // Each symbol's viewBox IS its nominal footprint in centimetres — `0 0 210 90` is a
  // 2.1 x 0.9 m sofa — so a placement at that size stretches it 1:1 and everything inside it
  // keeps the proportions it was drawn with. That is the entire reason the block was
  // re-authored: in a square 24x24 box the sofa was stretched 4.3x across against 1.7x down,
  // which turned 49x54cm seat cushions into tall thin slots and made the piece read as a
  // radiator. Nothing inside a piece can be proportioned until its box has the proportions of
  // the thing.
  //
  // So a placement whose aspect is nothing like its symbol's silently undoes that, and it is
  // invisible in both files: the table looks reasonable, the symbol looks reasonable, only the
  // render is squashed. A quarter turn draws into a SWAPPED box, which is why the turn has to
  // be folded in here rather than compared against the raw width and depth.
  const aspects = {};
  for (const [, id, w, h] of INDEX.matchAll(/<symbol id="(fp-[^"]+)" viewBox="0 0 ([\d.]+) ([\d.]+)"/g)) {
    aspects[id] = parseFloat(w) / parseFloat(h);
  }
  assert.ok(Object.keys(aspects).length >= 10, 'the furniture symbols declare a footprint viewBox');

  for (const [key, items] of Object.entries(FURNITURE)) {
    for (const [symbol, , , wm, hm, turn] of items) {
      const nominal = aspects[symbol];
      assert.ok(nominal, `"${symbol}" has no viewBox to be proportioned against`);
      const quarter = turn === 90 || turn === 270;
      const drawn = (quarter ? hm : wm) / (quarter ? wm : hm);
      const stretch = drawn / nominal;
      assert.ok(
        stretch >= 0.8 && stretch <= 1.25,
        `${key}: "${symbol}" at ${wm}x${hm}${turn ? ` turned ${turn}` : ''} stretches its symbol `
        + `by ${stretch.toFixed(2)}x. Either place it nearer its drawn footprint, or redraw the `
        + 'symbol — past about a quarter the detail inside it stops being the shape it depicts.'
      );
    }
  }
});

test('furniture is only ever turned by a quarter', () => {
  // The turn is what lets one symbol serve every orientation, and mountRoom pays for it by
  // SWAPPING the box it draws into — a piece turned 90 has its width down the sheet. That
  // swap is exactly right for a quarter turn and wrong for anything else: at 45 the piece
  // would cover a footprint neither this table nor the checks below it describe, so the
  // overhang, label-band and door-swing assertions would all go on passing while a chair
  // hung through a wall.
  for (const [key, items] of Object.entries(FURNITURE)) {
    for (const [symbol, , , , , turn] of items) {
      if (turn === undefined) continue;
      assert.ok(
        [90, 180, 270].includes(turn),
        `${key}: "${symbol}" is turned ${turn}°, which is not a quarter turn — the footprint `
        + 'it declares would no longer be the footprint it covers'
      );
    }
  }
});

test('no furniture intrudes into the label band at the top of a room', () => {
  // The room's name and area figure are anchored in the top LABEL_BAND of its depth, and
  // furniture starts below. Asserted against the module's own exported constant so the
  // two cannot drift: raise the band without moving the furniture and a sofa goes
  // through a room name.
  const sizes = roomSizes();
  for (const [key, items] of Object.entries(FURNITURE)) {
    const room = sizes[key];
    assert.ok(room, `no room in the markup is called "${key}"`);
    for (const [symbol, , fy, , hm] of items) {
      const top = fy - hm / room.hm / 2;
      assert.ok(
        top >= LABEL_BAND - 1e-9,
        `${key}: "${symbol}" reaches ${top.toFixed(3)} of the room's depth, inside the top ` +
          `${LABEL_BAND} reserved for the room name. Move it down.`
      );
    }
  }
});

test('no furniture overhangs a wall', () => {
  const sizes = roomSizes();
  for (const [key, items] of Object.entries(FURNITURE)) {
    const { wm, hm } = sizes[key];
    for (const [symbol, fx, fy, itemW, itemH] of items) {
      const hw = itemW / wm / 2;
      const hh = itemH / hm / 2;
      assert.ok(
        fx - hw >= -0.01 && fx + hw <= 1.01 && fy - hh >= -0.01 && fy + hh <= 1.01,
        `${key}: "${symbol}" (${itemW}x${itemH} m) at ${fx}/${fy} sticks out through a wall`
      );
    }
  }
});

/**
 * Pieces that are SUPPOSED to share floor with something, and what each may share it with.
 *
 * Deliberately a pairing, not a list of exempt symbols: `fp-counter` is allowed to hold a
 * sink and a hob, and that is the whole permission. Left as "fp-counter is exempt" it would
 * also excuse a counter run parked through the dining table one metre below it.
 * @type {Array<[string, string]>}
 */
const STACKABLE = [
  // `['fp-rug', '*']` used to head this list — the one blanket permission, because a rug is
  // a floor finish and every seating group stood on one. The rug is gone (a dashed
  // rectangle read as a checkered box at the size a room renders), and so is its
  // exemption: nothing else on the sheet may share floor with an arbitrary neighbour.
  // Inset appliances. The sink and the hob are holes in the counter run, not free pieces
  // standing next to it, so their footprints are inside its by construction.
  ['fp-counter', 'fp-sink'],
  ['fp-counter', 'fp-hob'],
];

/** @param {string} a @param {string} b */
function mayStack(a, b) {
  return STACKABLE.some(([one, two]) =>
    (one === a && (two === b || two === '*')) || (one === b && (two === a || two === '*')));
}

test('no two pieces of furniture stand on the same floor', () => {
  // THE ONE THE OTHER FOUR CHECKS LET THROUGH. Overhang, label band and door swing all
  // measure a piece against the ROOM, so a plan can satisfy every one of them and still
  // draw a planter through the arm of a sofa — which is exactly what basics shipped: a
  // 0.65 m plant and a 2.3 m sofa overlapping by 0.13 x 0.65 m, rendered, with 31 tests
  // green. Furniture is the only thing on the sheet measured against its neighbours, so
  // it is the only clash arithmetic cannot otherwise see.
  //
  // Metre space, not fractions: the rooms are different shapes, so a fraction-space
  // rectangle is a different rectangle in every room and the tolerance would mean nothing.
  // Entries 4 and 5 are the ON-PLAN footprint whatever the turn (see FURNITURE), so
  // rotation needs no special case here — that invariant is what this check rests on, and
  // `furniture is only ever turned by a quarter` above is what keeps it true.
  const TOLERANCE = 0.005; // 5 mm — pieces may touch, they may not intersect.
  const sizes = roomSizes();
  for (const [key, items] of Object.entries(FURNITURE)) {
    const { wm, hm } = sizes[key];
    const boxes = items.map(([symbol, fx, fy, itemW, itemH]) => ({
      symbol,
      x0: fx * wm - itemW / 2, x1: fx * wm + itemW / 2,
      y0: fy * hm - itemH / 2, y1: fy * hm + itemH / 2,
    }));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (mayStack(a.symbol, b.symbol)) continue;
        const over = {
          x: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
          y: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0),
        };
        assert.ok(
          over.x <= TOLERANCE || over.y <= TOLERANCE,
          `${key}: "${a.symbol}" and "${b.symbol}" occupy the same floor — they overlap by ` +
            `${over.x.toFixed(2)} x ${over.y.toFixed(2)} m (${(over.x * over.y).toFixed(2)} m²). ` +
            'Move one clear, or add the pair to STACKABLE if one is genuinely drawn under ' +
            'or inside the other.'
        );
      }
    }
  }
});

// --------------------------------------------------------------------------
// Markup and asset wiring
// --------------------------------------------------------------------------

test('data-lang sits on the sibling spans, never on the summary or the details', () => {
  // data-lang assigns textContent, so a key one level up deletes everything nested
  // inside it. English looks perfect; the section collapses on the first language
  // switch. Same trap, same guard shape, as home-whyus.test.js:253.
  assert.doesNotMatch(
    INDEX,
    /<details[^>]*\bclass="faq-q faq-room"[^>]*\bdata-lang/,
    'a room <details> carries data-lang directly'
  );
  for (const room of roomsInMarkup()) {
    assert.doesNotMatch(
      room.body, /<summary[^>]*\bdata-lang/,
      `${room.key}'s <summary> carries data-lang — it would wipe the label and the question`
    );
    for (const [cls, field] of [['faq-room__label', 'label'], ['faq-room__q', 'question'], ['faq-room__a', 'answer']]) {
      assert.match(
        room.body,
        new RegExp(`class="${cls}" data-lang="faq\\.rooms\\.${room.key}\\.${field}"`),
        `${room.key} is missing .${cls}[data-lang="faq.rooms.${room.key}.${field}"]`
      );
    }
  }
});

test('every room shows it opens, on the widths where nothing else says so', () => {
  // `.faq-q > summary` sets `list-style: none` AND hides ::-webkit-details-marker, so
  // below 1001px — where the drawing is gone and the accordion is the whole section —
  // there is no UA affordance left. The homepage shipped with none of its own: nine rows
  // of text that happened to be clickable. guides.html had its +/- the whole time.
  //
  // Both halves are asserted because either alone is a silent failure. Without the span
  // the affordance is missing on mobile; without plan mode hiding it again, a chevron
  // floats over the linework on desktop. faq-plan.css already carried the hide rule for
  // `.faq-q__icon` before any element existed to hide — a guard can outlive its subject,
  // so this one names the markup too.
  const rooms = roomsInMarkup();
  for (const room of rooms) {
    assert.match(
      room.body, /<span class="faq-q__caret" aria-hidden="true"><\/span>/,
      `room ${room.no} (${room.key}) has no open/close affordance in accordion mode`
    );
  }

  const home = fs.readFileSync(path.join(PUBLIC, 'styles', 'home.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(home, /\.faq-q__caret\s*\{[^}]*\}/, 'the caret is styled in home.css');
  assert.match(
    home, /\.faq-q\[open\]\s+\.faq-q__caret::before\s*\{[^}]*transform:/,
    'the caret must turn over when the room opens, or it is decoration rather than state'
  );
  // home.css, not faq-plan.css: that sheet is lazy AND gated at 1001px, so an affordance
  // defined there would be absent on exactly the widths that need it.
  const plan = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const gateAt = plan.indexOf('@media screen and (min-width: 1001px)');
  assert.ok(gateAt > 0, 'faq-plan.css still opens with the plan-mode gate');
  assert.doesNotMatch(
    plan.slice(0, gateAt), /\.faq-q__caret\s*\{/,
    'the caret must not be defined in the lazy sheet — it has to survive that sheet failing'
  );
  assert.match(
    plan.slice(gateAt), /\.faq-room\s+\.faq-q__caret[^{]*\{[^}]*display:\s*none/,
    'plan mode must hide the caret; the drawing has no room for one'
  );
});

test('the accordion fallback survives on both pages that use it', () => {
  const rooms = roomsInMarkup();
  // .faq-q is what home.css styles; losing it strips the section on every phone.
  assert.equal(rooms.length, 9, 'all nine <details> still carry faq-q alongside faq-room');
  assert.match(INDEX, /<div class="faq-plan__sheet faq-accordion">/, 'the sheet is still the accordion grid');
  for (const room of rooms) {
    assert.match(room.body, /<p class="faq-room__a"/, `${room.key}'s answer is a <p class="faq-room__a">`);
  }

  // Exclusive open is required here (two open rooms would paint two answers into the
  // notes column at once) and wrong on guides.html, whose items are independent.
  assert.equal(
    (INDEX.match(/<details[^>]*\bname="faq-room"/g) || []).length, 9,
    'every room opts into the native exclusive accordion'
  );
  assert.doesNotMatch(GUIDES, /<details[^>]*\bname=/, 'guides.html items must not be exclusive');
});

test('the notes column ships its static content', () => {
  // The hint is authored, not generated, so it survives a JS failure.
  assert.match(INDEX, /class="faq-plan__notes"[^>]*aria-hidden="true"/, 'the notes column is decorative');
  assert.match(INDEX, /class="faq-plan__hint" data-lang="faq.plan.hint"/, 'the hint is translated');

  // The same three-copies trap the rooms have: language-loader.js overwrites this from the
  // pack, so an inline fallback that has drifted is invisible in English and invisible in
  // every other language too — it only ever shows in the split second before hydration,
  // and to a visitor with JS off.
  const english = JSON.parse(
    fs.readFileSync(path.join(PUBLIC, 'languages', 'english.json'), 'utf8')
  );
  const authored = /class="faq-plan__hint"[^>]*>([^<]*)</.exec(INDEX);
  assert.ok(authored, 'the hint ships inline text, not an empty element');
  assert.equal(
    authored[1].trim(), english.faq.plan.hint.trim(),
    'the authored hint has drifted from english.json, which is what a visitor actually reads'
  );

  // A drafting title block (Project / Drawing / Scale / Sheet) used to sit at the foot
  // of this column, and a per-room spec line under the question. Both restated what the
  // page already showed — the drawing IS the FAQ, and the scale is the scale bar — so
  // both went. Pinned so neither creeps back as "authentic marginalia".
  assert.doesNotMatch(INDEX, /faq-plan__title-block/, 'the title block is gone for good');
  assert.doesNotMatch(INDEX, /faq.plan.fields/, 'its pack keys went with it');
});

test('faq-plan.css confines the whole drawing to one media query, and hides its parts below it', () => {
  // The degradation contract, enforced structurally rather than by screenshot.
  //
  // Everything that only makes sense as a drawing has to be BOTH gated behind
  // `min-width: 1001px` AND explicitly hidden outside it. Gating alone is not enough:
  // the per-room <svg> the module injects has no styling of its own, and an SVG with no
  // fill declared paints solid black — which is precisely what shipped under every
  // answer on mobile the first time.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  for (const q of [...css.matchAll(/@media([^{]+)\{/g)].map((m) => m[1].trim())) {
    assert.match(
      q, /^screen and \(min-width: 1001px\)/,
      `faq-plan.css has an @media that is not the plan-mode gate: "${q}"`
    );
  }

  const defaultBlock = css.slice(0, css.indexOf('@media'));
  const planBlock = css.slice(css.indexOf('@media'));
  // `.faq-room__label` is on this list for a different reason than the other four, and it
  // is the reason it must stay: it is not drawing furniture, it is the room NAME, so both
  // halves of the pair are a live requirement pulling opposite ways. Drop the default hide
  // and the name comes back as a topic chip beside every question on mobile — the question
  // restated in eight louder characters, which is what it was doing before. Drop the
  // `display` inside the gate and every room on the drawing goes nameless.
  for (const cls of ['.faq-plan__ink', '.faq-room__ink', '.faq-plan__notes', '.faq-room__no', '.faq-room__label']) {
    assert.ok(
      new RegExp(`\\${cls}[,\\s]`).test(defaultBlock),
      `${cls} is not hidden outside plan mode — it will render unstyled below 1001px, in ` +
        'print, and whenever the lazy sheet loses the race'
    );
    // The other half of the pair, and the easier one to forget. A plan-mode rule that
    // only POSITIONS an element cannot undo `display: none`, so an element can be
    // correctly hidden on mobile and invisible on desktop at once — which is exactly how
    // the per-room ink silently vanished once it joined the hide list.
    assert.match(
      planBlock, new RegExp(`\\${cls}\\s*(,[^{]*)?\\{[^}]*display:\\s*(block|flex)`),
      `${cls} is hidden by default but never given a display back inside the media query`
    );
  }
});

test('the ink keeps a graded line weight, which is what makes it read as a drawing', () => {
  // A flat drawing is a wireframe. The envelope has to outweigh the partitions, and both
  // have to outweigh the annotation — collapse the hierarchy and the whole illusion goes
  // with it, without a single test failing anywhere else.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /** @param {string} sel */
  const weight = (sel) => {
    const rule = new RegExp(`\\${sel}\\s*(,[^{]*)?\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `${sel} has no rule`);
    const m = /stroke-width:\s*([\d.]+)/.exec(rule[2]);
    assert.ok(m, `${sel} declares no stroke-width`);
    return Number(m[1]);
  };
  const envelope = weight('.fp-envelope');
  const partition = weight('.fp-partition');
  const dim = weight('.fp-dim path');
  assert.ok(envelope > partition, `envelope (${envelope}) must outweigh partitions (${partition})`);
  assert.ok(partition > dim, `partitions (${partition}) must outweigh dimension lines (${dim})`);
  assert.ok(envelope / dim >= 4, 'the heaviest and lightest lines need real separation');
});

test('nothing on the sheet is sized below a readable floor', () => {
  // Every size on this sheet is `clamp(floor, Ncqw, ceiling)` so the type scales with
  // the drawing. That is right, but it means the FLOOR is the only thing standing
  // between a short viewport and 6px lettering — and 6px is exactly what the title
  // block shipped at, because the scale was tuned while the sheet was clamped to 820px
  // and every value had already bottomed out.
  //
  // The floors are the promise: below them the sheet stops shrinking the words.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const clamps = [...css.matchAll(/font-size:\s*clamp\(\s*([\d.]+)px\s*,([^,]+),\s*([\d.]+)px\s*\)/g)];
  assert.ok(clamps.length >= 4, `expected the sheet's type scale, found ${clamps.length} clamps`);

  for (const [whole, floor, , ceiling] of clamps) {
    assert.ok(
      Number(floor) >= 7.5,
      `${whole.trim()} floors at ${floor}px — too small to read on a short viewport`
    );
    assert.ok(Number(ceiling) > Number(floor), `${whole.trim()} has an inverted clamp`);
  }

  // The answer is body copy and gets a higher floor than the marginalia.
  const answer = /\.faq-room\s*>\s*\.faq-room__a\s*\{[^}]*font-size:\s*clamp\(\s*([\d.]+)px/.exec(css);
  assert.ok(answer, 'the answer declares a clamped font-size');
  assert.ok(
    Number(answer[1]) >= 11,
    `the answer floors at ${answer[1]}px; body copy needs at least 11px`
  );
});

test('the room highlight appears whole, and survives reduced motion', () => {
  // Two rules that used to be one, and both are about the same rectangle.
  //
  // IT APPEARS, IT DOES NOT TRACE. The highlight was revealed with a stroke-dashoffset run
  // clockwise from the room's top-left, which is lovely once and slow nine times: at 0.42s
  // a room you cannot skim the plan, and a plain hover reads as though it is loading
  // something. So no rule on .fp-wall may carry a dash reveal again — not in the settled
  // block, where it would leave the wall permanently half-drawn, and not in the motion
  // block either, which is where it lived and where re-adding it would bring the tracing
  // back for everyone who has not asked for less motion.
  //
  // VISIBILITY RIDES ON OPACITY. House doctrine (home.css:2141, home-figures.js:336):
  // STATES survive reduced motion and only ARRIVE instantly. That is why the hidden state
  // has to be `opacity: 0` in the settled block — a reduced-motion visitor still gets the
  // highlight on hover, just without the fade.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const motionStart = css.indexOf('prefers-reduced-motion: no-preference');
  assert.ok(motionStart > 0, 'the motion block is written as an additive no-preference query');

  const settled = css.slice(0, motionStart);
  const motion = css.slice(motionStart);
  const wall = /\.fp-wall\s*\{([^}]*)\}/.exec(settled);
  assert.ok(wall, '.fp-wall has a settled rule outside the motion block');
  assert.match(wall[1], /opacity:\s*0/, '.fp-wall hides via opacity, so reduced motion keeps hover feedback');

  // Selector-scoped rather than a bare search for `stroke-dash`, because the one-time
  // draft-in of the envelope and partitions still uses one — that is autonomous motion
  // that plays once, correctly suppressed under reduce, and nothing to do with hover.
  const wallRules = [...css.matchAll(/([^{};]*\.fp-wall[^{};]*)\{([^}]*)\}/g)];
  assert.ok(wallRules.length >= 2, 'the highlight is styled in both the settled and motion blocks');
  for (const [, selector, body] of wallRules) {
    assert.doesNotMatch(
      body, /stroke-dash/,
      `the highlight must appear, not trace itself on — dash reveal found on \`${selector.trim()}\``
    );
  }
  assert.match(
    motion, /\.fp-wall\s*\{[^}]*transition:[^}]*opacity/,
    'the fade is ADDED under no-preference, so reduce gets the same states instantly'
  );
  assert.doesNotMatch(
    settled, /@media[^{]*prefers-reduced-motion:\s*reduce/,
    'motion is added under no-preference here, never removed under reduce'
  );
});

test('the draft-in is one sweep across the sheet, and it is over inside a second', () => {
  // WHAT WENT WRONG THE FIRST TIME, because the numbers alone do not say it. The labels,
  // the furniture and the key bubbles each staggered all nine rooms independently over a
  // ~1.7s span, so room 01's key landed AFTER room 09's label — three passes over the
  // same drawing, and the section read as slow and out of step with its own container.
  //
  // The fix is a ratio, not a duration: each room's three pieces start close together
  // (they resolve as one room) while consecutive rooms are much closer still (the rooms
  // read as a wave). Widen the per-room step or narrow the intra-room spacing and it
  // silently degrades back to three passes, with nothing else failing — hence this guard.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /** The `calc(<base>s + var(--n, 0) * <step>ms)` delay on one of the staggered waves. */
  const wave = (/** @type {string} */ sel) => {
    const rule = new RegExp(`\\.is-drafted\\s+${sel}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `no drafted rule for ${sel}`);
    const m = /transition:\s*opacity\s+([\d.]+)s\s+[^;]*?calc\(\s*([\d.]+)s\s*\+\s*var\(--n[^)]*\)\s*\*\s*([\d.]+)ms\s*\)/.exec(rule[1]);
    assert.ok(m, `${sel} has no calc() stagger delay: ${rule[1].trim()}`);
    return { dur: Number(m[1]) * 1000, base: Number(m[2]) * 1000, step: Number(m[3]) };
  };

  const label = wave('\\.faq-room__label');
  const furn = wave('\\.fp-furn');
  const key = wave('\\.fp-key');

  const steps = new Set([label.step, furn.step, key.step]);
  assert.equal(steps.size, 1, `the three waves must share one per-room step, got ${[...steps]}`);
  const step = label.step;

  const spread = key.base - label.base;
  assert.ok(label.base < furn.base && furn.base < key.base, 'a room draws itself label, furniture, key');
  assert.ok(
    spread >= step * 3,
    `intra-room spread (${spread}ms) must dominate the per-room step (${step}ms), or the `
      + 'waves restage the whole sheet three times instead of sweeping across it once'
  );

  // Nine rooms is what index.html authors; asserted against the markup so a tenth room
  // extending the tail past the budget is caught here rather than on the live site.
  const last = roomsInMarkup().length - 1;
  const end = key.base + last * step + key.dur;
  assert.ok(end <= 1000, `the sweep must be settled inside 1s; the last key ends at ${end}ms`);

  // The walls are the floor of the whole thing — nothing can be quick while they are not.
  const walls = /\.is-drafted\s+\.fp-envelope,[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(walls, 'no drafted rule for the wall network');
  const draw = /transition:\s*stroke-dashoffset\s+([\d.]+)s/.exec(walls[1]);
  assert.ok(draw, 'the wall network still draws itself on with a dashoffset transition');
  assert.ok(Number(draw[1]) <= 0.6, `walls draw in ${draw[1]}s; past ~0.6s the sheet reads as loading`);
});

test('the question previews at the top of the column without moving as it fades', () => {
  // Two halves of one arrangement.
  //
  // WHERE IT SITS. `top: 11%` is the READING offset — it reserves the band above for the
  // "05 / 09" key, which only exists once a room is open. Previewing there is nothing above
  // it, so the question rides up by a transform to the top of the panel instead.
  //
  // WHY THE SHIFT LIVES ON THE RESTING STATE. Scoped to `:hover` it was a bug you could
  // watch: leaving a room dropped the question back to the reading offset the same instant
  // its 0.22s fade-out started, so it slid downwards as it disappeared. The resting state
  // is invisible, so giving it the PREVIEW position costs nothing and means the only two
  // states the eye ever sees between are identical in position. Nothing hover-scoped may
  // move it again — not `top`, not `transform`.
  //
  // WHY THE SHIFT IS A TRANSFORM. home-faq-plan.js reads `offsetTop` here to lay each answer
  // under its own question. A transform does not touch layout, so the measurement keeps
  // seeing the reading offset; moving the box with `top` would feed it the preview's offset
  // and put every answer 4.4% of the sheet too high the moment a room opened.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const plan = css.slice(css.indexOf('@media'));

  const resting = /\.faq-room__q\s*\{([^}]*)\}/.exec(plan);
  assert.ok(resting, 'plan mode gives the question a resting rule');
  assert.match(resting[1], /top:\s*[\d.]+%/, 'the reading offset is a percentage of the sheet');
  const lift = /transform:\s*translateY\(\s*(-?[\d.]+)cq[hwbi]/.exec(resting[1]);
  assert.ok(lift, 'the preview lift is a transform in container units, so `offsetTop` is untouched');
  assert.ok(
    parseFloat(lift[1]) < 0,
    'the lift must be UPWARDS, or the preview is not at the top of the column'
  );

  const open = /\.faq-room\[open\]\s+\.faq-room__q\s*\{([^}]*)\}/.exec(plan);
  assert.ok(open, 'opening a room drops the question to its reading offset');
  assert.match(open[1], /transform:\s*none/, 'an open room clears the lift, making room for the key');

  // THE REGRESSION ITSELF. Any rule that both selects the question and depends on a pointer
  // or focus state, and moves it, reintroduces the slide-while-fading.
  for (const [, selector, body] of plan.matchAll(/([^{};]*\.faq-room__q[^{};]*)\{([^}]*)\}/g)) {
    if (!/:hover|:focus-visible/.test(selector)) continue;
    assert.doesNotMatch(
      body, /(^|[\s;])(top|bottom|transform|translate|margin-top):/,
      `hover must not move the question — it fades, and a fade that also slides is the bug `
      + `this arrangement exists to prevent. Offending rule: \`${selector.trim()}\``
    );
  }
});

test('the notes column hands its pointer events to the text underneath it', () => {
  // `.faq-plan__notes` is the LAST element in the sheet, so it paints over the entire
  // notes column — while the open room's question and answer are positioned into that
  // same box from inside their own <details>, which come earlier. Hit-testable, it
  // swallowed every event over the column: the answer could not be clicked into, let
  // alone dragged across to copy. It is aria-hidden decoration, so it must take none.
  //
  // The question is the mirror image. Nine of them stack in one box and a closed one is
  // only `opacity: 0` — still painted, still hit-testable — so events go to the OPEN one
  // alone, or the last room in the DOM quietly eats the whole band.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Plan mode only. `.faq-room__q` also has an accordion-mode rule above the media query,
  // and none of this applies there — the fallback is a normal document flow.
  const plan = css.slice(css.indexOf('@media'));
  /** @param {string} sel */
  const rule = (sel) => {
    const m = new RegExp(`(^|[},])\\s*${sel}\\s*\\{([^}]*)\\}`, 'm').exec(plan);
    assert.ok(m, `faq-plan.css has no rule for ${sel}`);
    return m[2];
  };
  assert.match(
    rule('\\.faq-plan__notes'), /pointer-events:\s*none/,
    'the notes column must not intercept pointer events, or the answer is unselectable'
  );
  assert.match(rule('\\.faq-room > \\.faq-room__a'), /pointer-events:\s*auto/);
  assert.match(rule('\\.faq-room__q'), /pointer-events:\s*none/);
  assert.match(
    rule('\\.faq-room\\[open\\] \\.faq-room__q'), /pointer-events:\s*auto/,
    'only the open question takes events; the other eight are invisible but still there'
  );
  // The key number sits between the question and the answer in the DOM, so without this
  // a drag from one to the other pastes "…the result?05 / 09As much as you want…".
  assert.match(
    rule('\\.faq-room__no'), /user-select:\s*none/,
    'the drawing callout is aria-hidden and must stay out of copied text too'
  );
});

test('the answer starts under its own question, not under the longest possible one', () => {
  // The question and the answer cannot share a normal flow — one has to be inside the
  // <summary> to be the accessible name, the other outside it to be the disclosure
  // content — so a fixed `top` on the answer had to reserve room for three lines, the
  // worst German and Russian reach. Behind a one-line English question that was a band of
  // empty paper. The offset is measured now, so the gap is the same in every language.
  const sheet = 760;
  const gap = Math.round(sheet * ANSWER_GAP);
  assert.equal(answerTop(84, 30, sheet), 84 + 30 + gap, 'one line');
  assert.equal(answerTop(84, 90, sheet), 84 + 90 + gap, 'three lines — same gap, lower start');
  // It has to scale with the sheet like everything else on it: the type is sized in cqw,
  // so a fixed px gap would read as generous at 1160 and cramped at 640.
  assert.ok(
    answerTop(50, 30, 420) - 80 < answerTop(84, 30, sheet) - 114,
    'the gap shrinks with the sheet'
  );
  assert.ok(ANSWER_GAP > 0.02 && ANSWER_GAP < 0.06, `${ANSWER_GAP} is not a plausible gap`);

  // The measurement is an enhancement, so the static value it replaces has to survive as
  // the fallback — no module, no ResizeObserver, or a throw must not stack the answer on
  // top of the question. `var(--a-top, …)` with NO fallback is the failure mode: a bare
  // var() that does not resolve drops the whole declaration.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const fallback = /\.faq-room\s*>\s*\.faq-room__a\s*\{[^}]*top:\s*var\(--a-top,\s*(\d+)%\s*\)/.exec(css);
  assert.ok(fallback, 'the answer reads --a-top WITH a static fallback');
  assert.ok(
    Number(fallback[1]) >= 20,
    `the fallback is ${fallback[1]}% — it has to clear a three-line question unaided`
  );
});

test('the notes column is backed, and backed BENEATH the text it backs', () => {
  // Body copy set over the ruled grid is hard to read — the lines cut through the x-height
  // and the eye keeps resolving them as strokes. The column gets paper; the grid stays
  // everywhere it is texture rather than noise.
  //
  // The half of this that is easy to lose is the stacking. .faq-plan__notes is the LAST
  // element in the sheet while the question and answer are positioned onto it from inside
  // their own <details>, which come earlier — so in plain DOM order the backing paints
  // OVER the very text it exists to make legible, and the column goes blank. It only
  // works as a pair: notes below, rooms above.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const plan = css.slice(css.indexOf('@media'));
  const notes = /\.faq-plan__notes\s*\{([^}]*)\}/.exec(plan);
  assert.ok(notes, 'plan mode styles the notes column');
  assert.match(notes[1], /background:/, 'the notes column carries the paper backing');
  assert.match(notes[1], /z-index:\s*0/, 'the backing is given an explicit stacking level');

  // OPACITY IS NOT THE DIAL. The backing is a light panel on a dark sheet — it reads as a
  // leaf of vellum rather than the near-black hole it used to be — and the only reason a
  // light colour is safe here is that it is fully opaque. Reach for alpha to make it feel
  // less heavy and the grid comes straight back through the body copy, which is the one
  // thing this element exists to stop. Tune the colour, never the transparency.
  const bg = /background:\s*([^;]*);/.exec(notes[1]);
  assert.ok(bg, 'the backing declares a background');
  assert.doesNotMatch(
    bg[1], /rgba\(|hsla\(|transparent|#[0-9a-f]{4}\b|#[0-9a-f]{8}\b/i,
    'the paper backing must be opaque — any alpha lets the ruled grid back through the copy'
  );
  assert.doesNotMatch(
    notes[1], /opacity:/,
    'fading the whole backing lets the grid through the copy exactly as an alpha fill would'
  );

  const room = /\.faq-room,\s*\.faq-room\[open\]\s*\{([^}]*)\}/.exec(plan);
  assert.ok(room, 'plan mode styles the room layers');
  assert.match(
    room[1], /z-index:\s*1/,
    'the rooms must sit ABOVE the backing, or it paints over the question and answer'
  );
});

test('a room closed with the mouse stops claiming the notes column', () => {
  // A <summary> keeps DOM focus after a click. Under `:focus-within` that meant a room you
  // had just closed went on printing its question in the notes column with nothing on the
  // plan selected — the two halves of the sheet disagreeing about what was open.
  //
  // :focus-visible is the distinction that matters: false for a mouse click, true for Tab,
  // so the keyboard preview survives and the stale one goes.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    css, /\.faq-room:focus-within/,
    ':focus-within survives a mouse click, so it leaves a closed room looking selected'
  );
  assert.match(css, /\.faq-room:has\(:focus-visible\)\s*\.faq-room__q/, 'Tab still previews');

  // Specificity, not preference: `.faq-room:has(:focus-visible)` is (0,2,0), the same as
  // the `:focus-within` it replaced. Spelt `> summary:focus-visible` it would be (0,3,1)
  // and would start OUTRANKING the `[open]` rules that follow it, so a focused open room
  // would render with the dimmer hover fill instead of its own.
  assert.doesNotMatch(
    css, /\.faq-room\s*>\s*summary:focus-visible\s+\.fp-/,
    'keep the focus selector at :has(:focus-visible) — a heavier one beats the [open] rules'
  );
});

test('selecting the question does not close the room out from under the selection', () => {
  // A <summary> activates on `click`, which fires after any mousedown/mouseup pair on the
  // same element — so dragging across the question to copy it toggled the room shut on
  // release, and the answer (`display: none` once closed) fell out of the selection.
  //
  // The guard has to stay narrow: suppress the toggle ONLY for a selection anchored in
  // this summary. A blanket "is anything selected?" check would swallow the first click on
  // a room name whenever text elsewhere on the page happened to be highlighted.
  /** @param {string} name */
  const node = (name) => ({ name });
  /** @param {object[]} owned */
  const makeSummary = (owned) => {
    /** @type {{ handler: ((e: object) => void) | null, contains: (n: object) => boolean }} */
    const summary = {
      handler: null,
      /** @param {string} type @param {(e: object) => void} fn */
      addEventListener(type, fn) {
        assert.equal(type, 'click');
        summary.handler = fn;
      },
      /** @param {object} n */
      contains: (n) => owned.includes(n),
    };
    return summary;
  };

  const inside = node('question-text');
  const elsewhere = node('some-other-paragraph');
  const summary = makeSummary([inside]);
  wireSelectionGuard([
    /** @type {any} */ ({ el: { querySelector: () => summary } }),
    /** @type {any} */ ({ el: { querySelector: () => null } }), // a room with no <summary>
  ]);
  assert.ok(summary.handler, 'the guard wires a click listener on the summary');

  /** @param {object | null} sel */
  const clickWith = (sel) => {
    let prevented = false;
    const prior = /** @type {any} */ (globalThis).window;
    /** @type {any} */ (globalThis).window = { getSelection: () => sel };
    try {
      /** @type {any} */ (summary.handler)({ preventDefault: () => { prevented = true; } });
    } finally {
      /** @type {any} */ (globalThis).window = prior;
    }
    return prevented;
  };

  assert.equal(
    clickWith({ isCollapsed: false, anchorNode: inside }), true,
    'a drag across the question must not toggle the room'
  );
  assert.equal(
    clickWith({ isCollapsed: false, anchorNode: elsewhere }), false,
    'a selection somewhere else must never block opening a room'
  );
  assert.equal(clickWith({ isCollapsed: true, anchorNode: inside }), false, 'a plain click opens');
  assert.equal(clickWith({ isCollapsed: false, anchorNode: null }), false);
  assert.equal(clickWith(null), false, 'engines without getSelection still toggle');
});

test('the plan assets are wired in the right places', () => {
  assert.match(
    INDEX,
    /<link rel="stylesheet" href="styles\/faq-plan\.css" media="print" data-lazy-css>/,
    'faq-plan.css must load non-render-blocking'
  );
  assert.doesNotMatch(GUIDES, /faq-plan\.css/, 'guides.html must not download the drawing sheet');

  // The module MUST be deferred: it is below-fold decoration, and index-deferred.js is
  // the only list that runs after `load`.
  const deferred = fs.readFileSync(path.join(PUBLIC, 'scripts', 'index-deferred.js'), 'utf8');
  assert.match(deferred, /scripts\/home-faq-plan\.js/, 'home-faq-plan.js belongs in DEFERRED');
  assert.doesNotMatch(
    INDEX, /<script[^>]*src="scripts\/home-faq-plan\.js"/,
    'home-faq-plan.js must not get its own tag in <head>'
  );
});

// --------------------------------------------------------------------------
// Deep links
// --------------------------------------------------------------------------

test('every room is addressable, under the id roomId() derives from its own key', () => {
  // THREE COPIES OF THE SAME STRING, and only one of them is authored: the <details> id,
  // the fragment home-faq-plan.js matches against, and the `url` each Question publishes
  // in #faq-jsonld. The module derives its copy with roomId(), so the two that can rot
  // are the markup and the JSON-LD — and both rot silently. A stale id in the markup
  // makes the link a no-op that still scrolls to the section, which looks like it worked;
  // a stale url in the JSON-LD is only ever seen by a crawler.
  //
  // `whyStagify` is why roomId() lower-cases at all. Left verbatim it would publish
  // `#faq-whyStagify`, where the capital is both ugly in a shared link and load-bearing,
  // since fragments are case-sensitive.
  const rooms = roomsInMarkup();
  const seen = new Set();
  for (const room of rooms) {
    const id = (room.tag.match(/\bid="([^"]*)"/) || [])[1] || '';
    assert.equal(
      id, roomId(room.key),
      `"${room.key}" ships id="${id}" but the module will look for "${roomId(room.key)}" — ` +
      'a #faq-… link to it would open nothing'
    );
    assert.ok(!seen.has(id), `two rooms answer to "${id}"`);
    seen.add(id);
  }
  assert.equal(seen.size, 9, 'all nine rooms are linkable');

  const ld = JSON.parse(
    /** @type {RegExpMatchArray} */
    (INDEX.match(/<script type="application\/ld\+json" id="faq-jsonld">([\s\S]*?)<\/script>/))[1]
  );
  assert.equal(ld.mainEntity.length, rooms.length);
  ld.mainEntity.forEach((/** @type {{url: string}} */ entry, /** @type {number} */ i) => {
    assert.equal(
      entry.url, `https://stagify.ai/#${roomId(rooms[i].key)}`,
      `#faq-jsonld publishes a url for "${rooms[i].key}" that no element on the page carries`
    );
  });
});

test('a fragment opens the room it names, and only that room', () => {
  // The UA will not do this for us: it opens a <details> when the target is INSIDE one,
  // and here the id is ON the <details>. Without this wiring a shared link scrolls to a
  // closed accordion, which is the same thing as not having deep links at all.
  /** @param {string} id */
  const room = (id) => ({ el: { id, open: false, scrollIntoView() { this.scrolled = true; }, scrolled: false } });
  const rooms = [room('faq-basics'), room('faq-privacy')];

  const priorLocation = /** @type {any} */ (globalThis).location;
  const priorWindow = /** @type {any} */ (globalThis).window;
  /** @type {Array<() => void>} */
  const hashListeners = [];
  /** @type {any} */ (globalThis).location = { hash: '#faq-privacy' };
  /** @type {any} */ (globalThis).window = {
    /** @param {string} type @param {() => void} fn */
    addEventListener(type, fn) {
      assert.equal(type, 'hashchange');
      hashListeners.push(fn);
    },
  };
  try {
    wireDeepLinks(/** @type {any} */ (rooms));
    assert.equal(rooms[1].el.open, true, 'the named room opens');
    assert.equal(rooms[0].el.open, false, 'its neighbour is left alone — <details name> closes it');
    assert.equal(rooms[1].el.scrolled, true, 'and it is brought into view');

    // A hash that names nothing must be inert, not a throw: #faq itself is a real link on
    // this page (faq-redirect.js sends /faq.html to it) and lands here on every visit.
    /** @type {any} */ (globalThis).location.hash = '#faq';
    rooms[1].el.open = false;
    hashListeners.forEach((fn) => fn());
    assert.equal(rooms[1].el.open, false, 'an unrelated fragment opens nothing');

    /** @type {any} */ (globalThis).location.hash = '#faq-basics';
    hashListeners.forEach((fn) => fn());
    assert.equal(rooms[0].el.open, true, 'a later hash change is honoured too');
  } finally {
    /** @type {any} */ (globalThis).location = priorLocation;
    /** @type {any} */ (globalThis).window = priorWindow;
  }
});

// --------------------------------------------------------------------------
// Colour contracts
// --------------------------------------------------------------------------

test('the window openings are painted with the sheet\'s own ground, stop for stop', () => {
  // `.fp-win__gap` is not a colour choice, it is the ground showing through a hole in the
  // poché — so it has to BE the ground. The ground is a gradient, which a flat stroke can
  // only match in one band: tuned near the 52% stop, the three north windows painted a bar
  // visibly darker than the wall they were cutting through, and read as slots.
  //
  // The fix duplicates the stops into an SVG <linearGradient>, because CSS gradients and
  // SVG paint servers cannot share one definition. This is the guard that makes the
  // duplicate safe. Retune the sheet and it fails, naming both places.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const gap = /\.fp-win__gap\s*\{([^}]*)\}/.exec(css);
  assert.ok(gap, 'plan mode styles the window gaps');
  assert.match(
    gap[1], /stroke:\s*url\(#fp-ground\)/,
    'the gap must reference the ground gradient, not restate a colour that can only match ' +
    'one band of it'
  );

  const sheet = /\.faq-plan__sheet\s*\{([^}]*)\}/.exec(css);
  assert.ok(sheet, 'plan mode styles the sheet');
  const cssStops = [...sheet[1].matchAll(/(#[0-9a-f]{6})\s+([\d.]+)%/gi)].map(
    ([, hex, pos]) => [hex.toLowerCase(), Number(pos) / 100]
  );
  assert.equal(cssStops.length, 3, 'the sheet ground is a three-stop gradient');

  const svg = /<linearGradient id="fp-ground"([^>]*)>([\s\S]*?)<\/linearGradient>/.exec(INDEX);
  assert.ok(svg, 'index.html defines #fp-ground');
  const svgStops = [...svg[2].matchAll(/<stop offset="([\d.]+)" stop-color="(#[0-9a-f]{6})"/gi)].map(
    ([, offset, hex]) => [hex.toLowerCase(), Number(offset)]
  );
  assert.deepEqual(
    svgStops, cssStops,
    '#fp-ground has drifted from the sheet background in faq-plan.css — the windows would ' +
    'stop matching the ground they punch through'
  );

  // The gradient has to be in SHEET coordinates, or "the same stops" still paints a
  // different colour at every window: objectBoundingBox would resolve against each path's
  // own bounding box, which for a horizontal window line is zero-height.
  assert.match(svg[1], /gradientUnits="userSpaceOnUse"/, '#fp-ground must span the viewBox');
});

test('the open room\'s name leaves the accent, because the accent cannot carry it', () => {
  // --ink-hot is one rung up the blue ramp from --brand-pale, and the room name is TEXT at
  // up to 14px, so it owes 4.5:1. On the bare ground the accent measures ~4.7:1 and is fine.
  // An open room also paints .fp-floor at 17%, which lifts the local ground and takes the
  // same pair to ~3.6:1 — and no ground colour recovers it, because with the floor tint
  // removed the accent still only reaches 4.7. So the tint is the entire margin, and the
  // label steps up to white.
  //
  // The reason this is a test and not a comment: reuniting the two selectors is a one-line
  // "simplification" that looks like tidying and silently reintroduces the failure.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const open = /\.faq-room\[open\]\s+\.faq-room__label\s*\{([^}]*)\}/.exec(css);
  assert.ok(open, 'the open room styles its label');
  assert.doesNotMatch(
    open[1], /--ink-hot/,
    'the open room\'s label must not take --ink-hot — over its own floor tint that is 3.7:1'
  );
  // Written as the resting white at full strength rather than `#fff`: this sheet's whole
  // vocabulary is white-at-alpha, and css-tokens.test.js would otherwise push the hex onto
  // --bg-elevated, which is a surface token being used as ink.
  assert.match(
    open[1], /color:\s*rgba\(255,\s*255,\s*255,\s*1\)/,
    'it takes full-strength white, which clears AA at ~6.6:1 over the open room\'s floor'
  );

  // And it has to come after the hover rule, at the same weight, or hovering the room that
  // is already open drops back to the accent.
  const hover = css.indexOf('.faq-room__label:hover {');
  assert.ok(hover > -1 && css.indexOf('.faq-room[open] .faq-room__label {') > hover,
    'the [open] rule must follow the :hover rule — they are both (0,2,0), so order settles it');
});

test('the question never changes position while it is fading', () => {
  // THE BUG THIS PINS was visible on every click from one room to another: the outgoing
  // question slid 4.4% of the sheet upwards THROUGH its own 0.22s fade, which reads as the
  // text being sucked away rather than simply going. It came from one symmetric
  // `transform 0.22s` covering three different journeys — and only one of them is watched
  // the whole way through (closing a room the pointer is still on, where the question does
  // not fade at all, it stays on as the preview).
  //
  // The fix is a zero-duration transform with a delay PAST the end of the fade, so the
  // position change lands on an already-invisible element. Zeroing the duration alone is
  // the trap: without the delay the jump happens at full opacity, which is worse.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const motion = css.slice(css.indexOf('prefers-reduced-motion: no-preference'));
  assert.ok(motion, 'the motion block exists');

  /** @param {string} block @returns {{duration: number, delay: number} | null} */
  const transformTiming = (block) => {
    const part = block.split(',').map((s) => s.trim()).find((s) => /^transform\b/.test(s));
    if (!part) return null;
    const times = [...part.matchAll(/([\d.]+)s\b/g)].map((m) => Number(m[1]));
    return { duration: times[0] ?? 0, delay: times[1] ?? 0 };
  };

  const rest = /\n\s*\.faq-room__q\s*\{([^}]*)\}/.exec(motion);
  assert.ok(rest, 'the resting question declares its own transition');
  const opacity = rest[1].split(',').map((s) => s.trim()).find((s) => /opacity/.test(s));
  const fade = Number((/([\d.]+)s\b/.exec(/** @type {string} */ (opacity)) || [])[1]);
  assert.ok(fade > 0, 'the question fades on a timer');

  const resting = transformTiming(rest[1]);
  assert.ok(resting, 'the resting rule still governs transform — leaving it out inherits nothing');
  assert.equal(
    resting.duration, 0,
    `the outgoing question transitions transform over ${resting.duration}s — that is the ` +
    'upward drift through the fade. It must move instantly, after the fade.'
  );
  assert.ok(
    resting.delay >= fade,
    `the position change is delayed ${resting.delay}s but the fade takes ${fade}s — the jump ` +
    'would land while the question is still visible'
  );

  // And the one journey that IS watched end to end keeps its glide.
  const glide = /\.faq-room__label:hover\s*~\s*\.faq-room__q\s*,[^{]*\{([^}]*)\}/.exec(motion);
  assert.ok(glide, 'the hovered/focused question overrides the transition');
  const glideTiming = transformTiming(glide[1]);
  assert.ok(
    glideTiming && glideTiming.duration > 0,
    'closing a room the pointer is still on leaves the question visible — without a glide ' +
    'it teleports between the reading and preview offsets in full view'
  );
});

test('printing gives the questions and stops there', () => {
  // A closed <details> prints closed in Firefox and Safari, but Chrome auto-expands them
  // for print. With nothing declared, the same page printed a nine-question index on two
  // engines and nine full answers on the third — and only one of those is the intent.
  //
  // The rule lives in home.css, and that is the load-bearing half. faq-plan.css is LAZY —
  // it ships `media="print"` and is flipped to `all` by index-lazy-css.js — so a print
  // rule in there would be the one rule that stops working whenever the lazy load loses
  // its race. home.css is render-blocking and always present. (faq-plan.css also has a
  // structural rule, enforced above, that every @media in it is the plan-mode gate.)
  const home = fs.readFileSync(path.join(PUBLIC, 'styles', 'home.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const print = /@media print\s*\{\s*(\.faq-q\s*>\s*\.faq-room__a\s*\{[^}]*\})/.exec(home);
  assert.ok(print, 'home.css settles what printing the homepage FAQ does');
  assert.match(print[1], /display:\s*none/, 'print must suppress the answers');

  const lazy = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    lazy, /@media print/,
    'the print rule must not move into the lazy sheet, where it would apply only when the ' +
    'stylesheet happens to have arrived'
  );

  // Scoped so guides.html, which shares .faq-q for 17 troubleshooting items, still prints
  // in full — it has no .faq-room__a.
  assert.doesNotMatch(GUIDES, /faq-room__a/, 'the print rule must not reach the guides list');
});
