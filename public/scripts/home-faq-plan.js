/* Stagify.ai — #faq, the architectural sheet.
 *
 * WHAT THIS MODULE DOES, AND ONLY THIS: it generates SVG. It does not open, close,
 * toggle, filter or translate anything. The FAQ is a native <details> accordion and
 * stays one — `name="faq-room"` gives exclusive open/close for free, the UA hides the
 * closed answers, and faq-plan.css does the positioning. That division is why this file
 * is ~370 lines instead of 600: everything the platform already does is left to it.
 *
 * WHERE THE GEOMETRY COMES FROM. Nowhere in this file. Each <details> carries
 * `--x/--y/--w/--h` as percentages of the SHEET in an inline style, and CSS lays the
 * room box out from them. This module reads the same four numbers back with
 * getComputedStyle and derives every wall, door, dimension and furniture placement from
 * them. One copy of the numbers, so the drawing cannot drift from the boxes.
 *
 * THE COORDINATE SYSTEM. The sheet's aspect-ratio (1160/760) matches the marginalia
 * SVG's viewBox, so one viewBox unit is exactly 1/1160 of the sheet's width and 1/760 of
 * its height at any size. The envelope is 684x631 units = 15.2m x 14.0m, i.e. 45 units
 * per metre in BOTH axes. That isotropy is what lets furniture be specified in real
 * metres and what makes the scale bar in index.html honest.
 *
 * FURNITURE IS ALWAYS DRAWN, for every room, not just the open one. An earlier version
 * furnished only the active room, which left eight empty rectangles and made the plan
 * look unfinished rather than unfurnished. Opening a room brightens its own furniture;
 * it does not conjure it. This is also why the room label sits in the TOP band of each
 * room rather than dead centre — it frees the floor for furniture that reads at true
 * scale instead of being shoved into corners.
 *
 * PROGRESSIVE ENHANCEMENT IS THE CONTRACT. Everything here is additive. `.is-armed` is
 * the signal to faq-plan.css that this module ran: every rule that HIDES something for
 * the draft-in is scoped behind it, so if this file fails to load or throws, nothing is
 * hidden and the sheet renders fully drawn and static. Without the stylesheet as well,
 * it is the accordion it has always been.
 *
 * NOT VIEWPORT-GATED. This builds its nodes at every width and lets CSS hide them below
 * 1001px. Gating on a media query would mean a tablet rotated from 900px to 1200px got
 * an empty sheet — a class of bug traded for a few dozen nodes created at idle, after
 * `load`.
 */

const NS = 'http://www.w3.org/2000/svg';

/** viewBox units per metre, both axes. See the header. */
const U = 45;

/** viewBox units per 1% of the sheet, per axis. */
const UX = 11.6;
const UY = 7.6;

/** Door leaf: 0.9 m, the usual internal door. */
const DOOR = 0.9 * U;

/**
 * Fraction of a room's depth reserved at the top for its key bubble and name. Furniture
 * starts below it. Exported so the test asserts against THIS number rather than a copy —
 * raising it here without moving the furniture would silently put a sofa through a room
 * name, and the reverse would leave a gap down the middle of every room.
 */
export const LABEL_BAND = 0.36;

/**
 * The square a door sweeps as it opens, in fractions of the room, so furniture can be
 * kept out of it. A plan that parks an armchair inside a door swing is the single
 * clearest tell that nobody drew it — and it is pure arithmetic, so a test can see it.
 *
 * @param {string} door e.g. "e0.55"
 * @param {number} wm room width in metres @param {number} hm room depth in metres
 * @returns {{x0: number, y0: number, x1: number, y1: number} | null} null if no door
 */
export function doorSwing(door, wm, hm) {
  const m = /^([nsew])(0?\.\d+|[01])$/.exec(String(door || '').trim());
  if (!m) return null;
  const wall = m[1];
  const t = Math.min(1, Math.max(0, parseFloat(m[2])));
  const along = wall === 'n' || wall === 's' ? wm : hm;
  const d = Math.min(DOOR / U, along * 0.7);
  const start = Math.min(t * along, along - d);
  const box = (x0, y0, x1, y1) => ({ x0: x0 / wm, y0: y0 / hm, x1: x1 / wm, y1: y1 / hm });
  if (wall === 'n') return box(start, 0, start + d, d);
  if (wall === 's') return box(start, hm - d, start + d, hm);
  if (wall === 'w') return box(0, start, d, start + d);
  return box(wm - d, start, wm, start + d);
}

/**
 * @typedef {object} Room
 * @property {string} key   the `data-room` name, matching a faq.rooms.* pack key
 * @property {string} no    the two-digit key number shown in the callout bubble
 * @property {number} x     left edge, percent of the sheet
 * @property {number} y     top edge, percent of the sheet
 * @property {number} w     width, percent of the sheet
 * @property {number} h     height, percent of the sheet
 * @property {string} door  wall letter + fraction along it, e.g. "n0.68"
 * @property {Element} el   the <details> the numbers were read from
 */

/**
 * @param {string} tag
 * @param {Record<string, string|number>} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {SVGElement}
 */
function svg(tag, attrs, children) {
  const node = document.createElementNS(NS, tag);
  if (attrs) Object.keys(attrs).forEach((k) => node.setAttribute(k, String(attrs[k])));
  if (children) children.forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return node;
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Furniture per room: `[symbol, fx, fy, widthMetres, depthMetres, quarterTurn?]`, where
 * fx/fy are the item's CENTRE as a fraction of the room.
 *
 * SIZES ARE REAL METRES, not fractions, because the rooms are different shapes — a sofa
 * scaled to "20% of the room" would be a different sofa in every room, which is the tell
 * that gives away a fake plan. Note this only became true when the symbols got
 * `preserveAspectRatio="none"`: before that every one was letterboxed to its smaller side,
 * so a 2.4 x 0.9 m sofa drew as a 0.9 m square and these numbers were decorative.
 *
 * WIDTH AND DEPTH ARE ALWAYS THE ON-PLAN FOOTPRINT, before and after any turn. The
 * optional sixth entry rotates the SYMBOL, in quarter turns clockwise, and mountRoom swaps
 * the box it draws into so the piece still lands in exactly the rectangle these two numbers
 * describe. That keeps one meaning for the sizes, which is what lets the spec check
 * overhang, label-band and door-swing clearance without knowing anything about rotation.
 *
 * Everything is drawn facing SOUTH, so the turn is the piece's facing: 90 faces west, 180
 * faces north, 270 faces east. A backed piece against a wall wants its back TO the wall.
 *
 * Exported so the test can assert that every room in the markup has an entry, that every
 * symbol it names exists in index.html's <defs>, that nothing overhangs a wall, that
 * nothing intrudes into the label band at the top of the room, and that every turn is a
 * quarter one.
 *
 * @type {Record<string, Array<[string, number, number, number, number] | [string, number, number, number, number, number]>>}
 */
export const FURNITURE = {
  // Living room: sofa facing a media unit across a rug, armchair turned in at the side.
  basics: [
    ['fp-rug', 0.37, 0.66, 2.8, 1.5], ['fp-sofa', 0.375, 0.505, 2.3, 0.9],
    ['fp-coffee', 0.36, 0.755, 1.1, 0.6], ['fp-tv', 0.36, 0.935, 1.5, 0.4, 180],
    ['fp-armchair', 0.7, 0.6, 0.9, 0.85, 90], ['fp-lamp', 0.76, 0.9, 0.5, 0.5],
    ['fp-plant', 0.085, 0.47, 0.6, 0.6],
  ],
  // Study: desk facing the room, bookcase along the west wall, chair pushed in.
  turnaround: [
    ['fp-shelf', 0.075, 0.7, 0.5, 1.8, 270], ['fp-desk', 0.42, 0.5, 1.9, 0.85],
    ['fp-chair', 0.42, 0.75, 0.75, 0.75, 180], ['fp-nightstand', 0.72, 0.5, 0.6, 0.5],
    ['fp-lamp', 0.66, 0.9, 0.5, 0.5], ['fp-plant', 0.9, 0.88, 0.65, 0.65],
  ],
  // Dining: table with a chair drawn up on each side, sideboard on the south wall.
  pricing: [
    ['fp-table', 0.58, 0.6, 1.6, 0.9], ['fp-chair', 0.315, 0.6, 0.7, 0.7, 270],
    ['fp-chair', 0.86, 0.6, 0.7, 0.7, 90], ['fp-shelf', 0.55, 0.92, 1.8, 0.5, 180],
    ['fp-plant', 0.9, 0.9, 0.6, 0.6], ['fp-lamp', 0.1, 0.915, 0.5, 0.5],
  ],
  // Sitting room: sofa and armchair facing each other over a coffee table.
  studios: [
    ['fp-rug', 0.55, 0.68, 2.4, 1.5], ['fp-sofa', 0.55, 0.49, 2, 0.85],
    ['fp-coffee', 0.55, 0.7, 1, 0.5], ['fp-armchair', 0.55, 0.888, 0.85, 0.75, 180],
    ['fp-shelf', 0.93, 0.6, 0.45, 1.5, 90], ['fp-plant', 0.1, 0.9, 0.6, 0.6],
  ],
  // The deep room: a study at the top, a sitting area below it, bookcase down one wall.
  control: [
    ['fp-desk', 0.5, 0.45, 1.8, 0.8], ['fp-chair', 0.5, 0.575, 0.75, 0.75, 180],
    ['fp-sofa', 0.52, 0.705, 2, 0.9], ['fp-coffee', 0.52, 0.818, 1, 0.55],
    ['fp-shelf', 0.09, 0.62, 0.45, 1.6, 270], ['fp-armchair', 0.2, 0.93, 0.85, 0.8],
    ['fp-plant', 0.9, 0.93, 0.6, 0.6],
  ],
  // Bedroom: bed between two nightstands, wardrobe on the far wall, chair by the window.
  photos: [
    ['fp-rug', 0.32, 0.74, 2.6, 1.5], ['fp-bed', 0.32, 0.6, 1.7, 2.1],
    ['fp-nightstand', 0.09, 0.45, 0.5, 0.45], ['fp-nightstand', 0.55, 0.45, 0.5, 0.45],
    ['fp-wardrobe', 0.32, 0.94, 2.2, 0.6, 180], ['fp-armchair', 0.85, 0.55, 0.9, 0.85, 90],
    ['fp-lamp', 0.87, 0.72, 0.5, 0.5], ['fp-plant', 0.86, 0.93, 0.65, 0.65],
  ],
  // The one round table on the sheet. Nine rooms of rectangles read as a grid of boxes
  // however well each box is drawn, so one room gets a different geometry.
  disclosure: [
    ['fp-round', 0.58, 0.645, 1.15, 1.15], ['fp-chair', 0.33, 0.645, 0.65, 0.65, 270],
    ['fp-chair', 0.83, 0.645, 0.65, 0.65, 90], ['fp-shelf', 0.5, 0.925, 1.7, 0.45, 180],
    ['fp-plant', 0.92, 0.9, 0.55, 0.55],
  ],
  privacy: [
    ['fp-desk', 0.6, 0.5, 1.7, 0.8], ['fp-chair', 0.6, 0.78, 0.75, 0.75, 180],
    ['fp-shelf', 0.94, 0.7, 0.4, 1.3, 90], ['fp-plant', 0.3, 0.89, 0.6, 0.6],
    ['fp-lamp', 0.3, 0.6, 0.45, 0.45],
  ],
  // Kitchen and dining: a run with a sink and a hob, table below it.
  whyStagify: [
    ['fp-counter', 0.5, 0.43, 3.4, 0.65], ['fp-sink', 0.28, 0.43, 0.6, 0.45],
    ['fp-hob', 0.7, 0.43, 0.6, 0.45], ['fp-table', 0.5, 0.7, 1.5, 0.9],
    ['fp-chair', 0.5, 0.5625, 0.7, 0.7], ['fp-chair', 0.5, 0.8375, 0.7, 0.7, 180],
    ['fp-shelf', 0.22, 0.935, 1.45, 0.42, 180], ['fp-plant', 0.9, 0.93, 0.6, 0.6],
  ],
};

/**
 * A room's outline, clockwise from the top-left.
 *
 * The direction used to matter — the highlight was revealed with a stroke-dashoffset and
 * anticlockwise made it trace backwards. That reveal is gone (the rectangle fades in
 * finished now, see .fp-wall in faq-plan.css), and with it the `--len` this file used to
 * set from a `perimeter()` helper. The winding is kept anyway because a closed rect path
 * has to wind SOME way and this is the one a drafter would write.
 * @param {number} w viewBox width @param {number} h viewBox height
 */
export function rectPath(w, h) {
  return `M0 0H${round(w)}V${round(h)}H0Z`;
}

/**
 * A door: the leaf, plus its quarter-circle swing arc, hinged on the named wall and
 * opening into the room.
 *
 * The sweep flag differs per wall because SVG measures angles in a y-down system — the
 * short arc that lands INSIDE the room runs one way on a north wall and the other on a
 * south wall. Get it wrong and the door swings out through the wall, which an architect
 * spots instantly and nobody else ever does.
 *
 * @param {string} door e.g. "n0.68"; anything unparseable yields no door, never a throw
 * @param {number} w viewBox width @param {number} h viewBox height
 * @returns {string} a path `d`, or '' when there is nothing to draw
 */
export function doorArc(door, w, h) {
  const m = /^([nsew])(0?\.\d+|[01])$/.exec(String(door || '').trim());
  if (!m) return '';
  const wall = m[1];
  const t = Math.min(1, Math.max(0, parseFloat(m[2])));
  const d = Math.min(DOOR, (wall === 'n' || wall === 's' ? w : h) * 0.7);
  const arc = (x1, y1, x2, y2, sweep) =>
    `M${round(x1)} ${round(y1)}A${round(d)} ${round(d)} 0 0 ${sweep} ${round(x2)} ${round(y2)}`;

  if (wall === 'n') {
    const x = Math.min(t * w, w - d);
    return `M${round(x)} 0V${round(d)}` + arc(x, d, x + d, 0, 0);
  }
  if (wall === 's') {
    const x = Math.min(t * w, w - d);
    return `M${round(x)} ${round(h)}V${round(h - d)}` + arc(x, h - d, x + d, h, 1);
  }
  if (wall === 'w') {
    const y = Math.min(t * h, h - d);
    return `M0 ${round(y)}H${round(d)}` + arc(d, y, 0, y + d, 1);
  }
  const y = Math.min(t * h, h - d);
  return `M${round(w)} ${round(y)}H${round(w - d)}` + arc(w - d, y, w, y + d, 0);
}

/**
 * Real-world size of a room, from the same percentages CSS lays it out with.
 * @param {{w: number, h: number}} room
 * @returns {{ wm: number, hm: number, area: number }} metres and square metres
 */
export function roomMetrics(room) {
  const wm = (room.w * UX) / U;
  const hm = (room.h * UY) / U;
  return { wm, hm, area: wm * hm };
}

/**
 * Read the room table back off the DOM.
 * @param {Element} root
 * @returns {Room[]}
 */
export function readRooms(root) {
  /** @type {Room[]} */
  const out = [];
  root.querySelectorAll('[data-room]').forEach((el) => {
    const cs = getComputedStyle(el);
    const num = (/** @type {string} */ n) => parseFloat(cs.getPropertyValue(n));
    const x = num('--x');
    const y = num('--y');
    const w = num('--w');
    const h = num('--h');
    // A room missing a coordinate cannot be drawn. Skip it rather than emit NaN into a
    // path `d`, which some engines treat as "ignore the attribute" and others as "render
    // nothing at all" — one inert room is a far better failure than a blank section.
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return;
    out.push({
      key: el.getAttribute('data-room') || '',
      no: el.getAttribute('data-no') || '',
      x, y, w, h,
      door: el.getAttribute('data-door') || '',
      el,
    });
  });
  return out;
}

/**
 * Build one room's ink layer, plus the key number that appears in the notes column.
 * @param {Room} room
 */
function mountRoom(room) {
  const w = room.w * UX;
  const h = room.h * UY;

  /** @type {Array<Node>} */
  const kids = [
    svg('rect', { class: 'fp-floor', x: 0, y: 0, width: round(w), height: round(h) }),
    svg('path', { class: 'fp-wall', d: rectPath(w, h) }),
  ];

  const door = doorArc(room.door, w, h);
  if (door) kids.push(svg('path', { class: 'fp-door', d: door }));

  const items = FURNITURE[room.key] || [];
  if (items.length) {
    kids.push(svg('g', { class: 'fp-furn' }, items.map(([symbol, fx, fy, wmItem, hmItem, turn]) => {
      // wmItem/hmItem are the ON-PLAN footprint. A quarter turn puts the symbol's width down
      // the sheet, so the box it is drawn into has to be swapped BEFORE the rotation for the
      // piece to end up filling the rectangle the table describes. Skip that and every turned
      // piece silently draws at the wrong size — and the spec, which measures the footprint
      // from those same two numbers, goes on passing.
      const quarter = turn === 90 || turn === 270;
      const iw = (quarter ? hmItem : wmItem) * U;
      const ih = (quarter ? wmItem : hmItem) * U;
      const cx = fx * w;
      const cy = fy * h;
      const node = svg('use', {
        href: `#${symbol}`,
        x: round(cx - iw / 2),
        y: round(cy - ih / 2),
        width: round(iw),
        height: round(ih),
      });
      // About the item's own centre, so the turn never moves it.
      if (turn) node.setAttribute('transform', `rotate(${turn} ${round(cx)} ${round(cy)})`);
      return node;
    })));
  }

  // The callout bubble, top-left of the room, matching the big number in the notes
  // column. Always visible, so the plan reads as a keyed drawing at rest.
  if (room.no) {
    kids.push(svg('g', { class: 'fp-key' }, [
      svg('circle', { cx: 16, cy: 16, r: 9.5 }),
      svg('text', { x: 16, y: 19.5, 'text-anchor': 'middle' }, [room.no]),
    ]));
  }

  const ink = svg('svg', {
    class: 'faq-room__ink',
    viewBox: `0 0 ${round(w)} ${round(h)}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  }, kids);

  // The key at the head of the notes column, in HTML rather than SVG so it sets with
  // the rest of the column. It is two digits, so it needs no pack key and cannot go
  // stale in ten languages.
  //
  // There was a spec line here too — "16.5 m² · 5.2 × 3.2 m" under the question. It
  // went with the title block: the drawing already carries a scale bar, so quoting
  // every room's measurements was restating what the plan says, in the one place the
  // answer needed the room.
  const summary = room.el.querySelector('summary');
  if (summary) {
    // THE INK GOES IN THE <summary>, NOT THE <details>. Everything inside a <details>
    // except its <summary> is the disclosure content, which the UA hides while the
    // element is closed — so ink appended to the <details> is invisible for every room
    // but the open one, and the whole drawing empties out. Inserted FIRST so it paints
    // beneath the room's name rather than over it.
    summary.insertBefore(ink, summary.firstChild);

    const no$ = document.createElement('span');
    no$.className = 'faq-room__no';
    no$.setAttribute('aria-hidden', 'true');
    no$.textContent = room.no ? `${room.no} / 09` : '';
    summary.appendChild(no$);

  }
}

/**
 * Run `fn` once, when `el` is genuinely on screen.
 *
 * Its OWN observer, not a watch on home-reveal.js's `.is-visible`: that script's
 * showAll() fallback (no IntersectionObserver, or reduced motion) adds the class to every
 * `.reveal` on the page at once, so the sheet would draft itself in for a section still
 * thousands of pixels below the fold. Same shape as home-figures.js:197.
 *
 * @param {Element} el @param {() => void} fn
 */
function playWhenInView(el, fn) {
  if (!('IntersectionObserver' in window)) {
    fn();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        fn();
        return;
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  observer.observe(el);
}

/**
 * `<details name>` gives an exclusive accordion natively. Where it is missing, two open
 * rooms would paint two answers into the notes column at once, so close the others.
 * @param {Room[]} rooms
 */
function wireExclusiveFallback(rooms) {
  if ('name' in document.createElement('details')) return;
  rooms.forEach(({ el }) => {
    el.addEventListener('toggle', () => {
      if (!(/** @type {HTMLDetailsElement} */ (el).open)) return;
      rooms.forEach((other) => {
        if (other.el !== el) /** @type {HTMLDetailsElement} */ (other.el).open = false;
      });
    });
  });
}

/** The space between the question and the answer, as a fraction of the sheet's height. */
export const ANSWER_GAP = 0.034;

/**
 * Where the answer should start, in px down the sheet.
 *
 * @param {number} qTop question's offset within the sheet
 * @param {number} qHeight how tall the question actually rendered
 * @param {number} sheetHeight
 */
export function answerTop(qTop, qHeight, sheetHeight) {
  return Math.round(qTop + qHeight + sheetHeight * ANSWER_GAP);
}

/**
 * Start the answer under its own question rather than under the longest possible one.
 *
 * The question and the answer cannot share a normal flow: the question is half the
 * <summary>'s accessible name so it has to live inside the <summary>, while the answer is
 * the disclosure content the UA hides, so it has to live outside it. Both are therefore
 * positioned onto the notes column independently, and a fixed `top` on the answer has to
 * reserve room for the WORST case — three lines, which is what German and Russian reach.
 * A one-line English question then left a band of empty paper between the two.
 *
 * So the offset is measured instead. A ResizeObserver on each question covers both things
 * that change its height — the sheet resizing, and language-loader.js swapping the text —
 * without anything having to know which one happened. All nine questions are laid out at
 * all times (a closed <details> still renders its <summary>), so this needs no open/close
 * hook and there is no first-open flash.
 *
 * Purely an enhancement: the CSS carries a static fallback, so no ResizeObserver, no
 * module, or an exception here all leave the answer where it used to be.
 * @param {Room[]} rooms
 */
function wireAnswerOffsets(rooms) {
  if (typeof ResizeObserver === 'undefined') return;
  /** @param {HTMLElement} el */
  const sync = (el) => {
    const q = /** @type {HTMLElement | null} */ (el.querySelector('.faq-room__q'));
    // el IS the full-sheet layer, so its height is the sheet's. Zero means the stylesheet
    // has not landed or we are in accordion mode, where this offset means nothing.
    const sheetHeight = el.offsetHeight;
    if (!q || !q.offsetHeight || !sheetHeight) return;
    const next = `${answerTop(q.offsetTop, q.offsetHeight, sheetHeight)}px`;
    // Only on change: a write is cheap but a no-op write inside a ResizeObserver callback
    // is exactly what trips the "loop completed with undelivered notifications" warning.
    if (el.style.getPropertyValue('--a-top') !== next) el.style.setProperty('--a-top', next);
  };

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const room = /** @type {HTMLElement | null} */ (entry.target.closest('.faq-room'));
      if (room) sync(room);
    }
  });
  rooms.forEach(({ el }) => {
    const q = el.querySelector('.faq-room__q');
    if (!q) return;
    sync(/** @type {HTMLElement} */ (el));
    observer.observe(q);
  });
}

/**
 * Let the open room's question be selected without the drag closing the room.
 *
 * The question is half the <summary>'s accessible name, so it lives inside the <summary> —
 * and a <summary> activates on `click`, which fires after any mousedown/mouseup pair on the
 * same element. Dragging across the question to copy it therefore toggled the room shut on
 * release, taking the answer (`display: none` once closed) out of the selection with it.
 *
 * The guard is deliberately narrow. It suppresses the toggle only when the selection that
 * exists at click time is anchored INSIDE this summary, which is true exactly after a drag
 * across the question. Clicking a room's name never trips it: mousedown on the name
 * collapses whatever was selected before `click` runs.
 * Exported so the spec can drive it — there is no jsdom in this repo, and the whole point
 * of the guard is a branch (`summary.contains(anchor)`) that no source scan can check.
 * @param {Room[]} rooms
 */
export function wireSelectionGuard(rooms) {
  rooms.forEach(({ el }) => {
    const summary = el.querySelector('summary');
    if (!summary) return;
    summary.addEventListener('click', (event) => {
      const selection = window.getSelection && window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode) return;
      if (!summary.contains(selection.anchorNode)) return;
      event.preventDefault();
    });
  });
}

/**
 * Arm the one-time draft-in on the two hand-authored wall paths. They are already in the
 * markup at the right weights, so the animation rides on them rather than on a duplicate
 * "wall network" path drawn over the top.
 * @param {Element} ink
 */
function armDraftIn(ink) {
  for (const sel of ['.fp-envelope', '.fp-partition']) {
    const path = /** @type {SVGPathElement | null} */ (ink.querySelector(sel));
    if (!path) continue;
    // getTotalLength() IS the right call here, unlike per-room: these are multi-subpath
    // paths whose length is not a formula, it runs once, and it happens at idle after
    // `load` on an element that is already in the document.
    const len = typeof path.getTotalLength === 'function' ? path.getTotalLength() : 0;
    if (len > 0) path.style.setProperty('--net-len', String(Math.ceil(len)));
  }
}

/** Exported so test/frontend/home-faq-plan.test.js can drive it against a fake DOM. */
export function initFaqPlan() {
  const plan = document.querySelector('.faq-plan');
  if (!plan) return;
  const sheet = plan.querySelector('.faq-plan__sheet');
  const ink = plan.querySelector('.faq-plan__ink');
  if (!sheet || !ink) return;

  const rooms = readRooms(sheet);
  if (!rooms.length) return;

  rooms.forEach((room, i) => {
    /** @type {HTMLElement} */ (room.el).style.setProperty('--n', String(i));
    mountRoom(room);
  });

  armDraftIn(ink);
  wireExclusiveFallback(rooms);
  wireSelectionGuard(rooms);
  wireAnswerOffsets(rooms);

  // Only now: `.is-armed` tells the stylesheet the drawing is complete and it may hide
  // the pieces the draft-in animates. Setting it earlier would leave a half-built sheet
  // hidden if anything above threw.
  plan.classList.add('is-armed');
  playWhenInView(plan, () => plan.classList.add('is-drafted'));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFaqPlan);
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired long
    // ago — a bare listener would never run and the sheet would silently stay unfurnished.
    // See the trap note at the top of index-deferred.js.
    initFaqPlan();
  }
}
