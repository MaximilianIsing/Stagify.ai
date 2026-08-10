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
  perimeter,
  doorArc,
  roomMetrics,
  doorSwing,
  readRooms,
  wireSelectionGuard,
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
  // The direction is not cosmetic: it is the order stroke-dashoffset reveals the wall
  // in, and anticlockwise makes the draw-on read backwards.
  assert.equal(rectPath(232, 182.4), 'M0 0H232V182.4H0Z');
  assert.equal(rectPath(100.04, 50.06), 'M0 0H100V50.1H0Z', 'coordinates round to 0.1');
});

test('perimeter is the arithmetic 2(w+h), not a measured length', () => {
  // getTotalLength() would force layout once per room on a section nobody has scrolled
  // to. It IS used for the two hand-authored wall paths, where the length is not a
  // formula — see armDraftIn.
  assert.equal(perimeter(232, 182.4), 828.8);
  assert.equal(perimeter(0, 0), 0);
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
  for (const cls of ['.faq-plan__ink', '.faq-room__ink', '.faq-plan__notes', '.faq-room__no']) {
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

test('reduced motion leaves the walls drawn-and-instant, not permanently on or off', () => {
  // The house doctrine (home.css:2141, home-figures.js:336) is that STATES survive
  // reduced motion and only arrive instantly; just autonomous motion is suppressed.
  //
  // For a stroke-drawn wall that is easy to get backwards. If visibility rode on
  // stroke-dashoffset, a reduced-motion visitor would get either nine permanently drawn
  // rooms (no hover feedback at all) or nine permanently blank ones. It has to ride on
  // `opacity`, with the dashoffset animation ADDED under `no-preference`.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'faq-plan.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const motionStart = css.indexOf('prefers-reduced-motion: no-preference');
  assert.ok(motionStart > 0, 'the motion block is written as an additive no-preference query');

  const settled = css.slice(0, motionStart);
  const motion = css.slice(motionStart);
  const wall = /\.fp-wall\s*\{([^}]*)\}/.exec(settled);
  assert.ok(wall, '.fp-wall has a settled rule outside the motion block');
  assert.match(wall[1], /stroke-dashoffset:\s*0/, '.fp-wall settles at dashoffset 0 (fully drawn)');
  assert.match(wall[1], /opacity:\s*0/, '.fp-wall hides via opacity, so reduced motion keeps hover feedback');
  assert.match(
    motion, /\.fp-wall\s*\{[^}]*stroke-dashoffset:\s*var\(--len\)/,
    'the undrawn start state belongs ONLY inside the no-preference block'
  );
  assert.doesNotMatch(
    settled, /@media[^{]*prefers-reduced-motion:\s*reduce/,
    'motion is added under no-preference here, never removed under reduce'
  );
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
