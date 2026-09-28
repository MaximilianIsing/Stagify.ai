/* Stagify.ai — the hero CTA's "moving day" scene: mounting and swapping.
 *
 * #hero-upload is, on desktop, a night street with a house on the right. Hover and a
 * removal van drives in from the left, parks in the gap between the label and the house,
 * the lantern comes on, the front door swings open and an up-arrow glows in the hallway.
 * Leave and it all reverses: door first, then the van pulls away. The whole sequence is
 * CSS (styles/hero-picker.css, `#hero-upload.hu`); this file puts the right SVG inside
 * the button, swaps the house when the hero picker changes furniture style — each of the
 * eight styles is drawn as a different house, see STYLE_HOUSE in hero-van-art.js — and sets
 * three state classes the CSS reads: `.hu-out` (the pointer left; drive on, off the right edge),
 * `.hu-quick` (it left mid-drive; skip the leave delays) and `.hu-hold` (a click opened a
 * modal over the button; keep the end state until it closes).
 *
 * DESKTOP AND A REAL POINTER ONLY. The scene is hover-driven, so on a phone it would be a
 * parked van in front of a dark house that never opens. Below 769px, or without a hovering
 * pointer, this module leaves the button exactly as index.css/styles.css paint it — the
 * classic gradient CTA — and mounts nothing. The 769px line is the same breakpoint
 * index.css already uses for this button's desktop sizing.
 *
 * THE SECOND MODULE TAG IN <head>, right behind hero-picker.js. Modules run in document
 * order once the document is parsed, so this executes in the same turn as the picker —
 * before the visitor can reach the button — and the street is simply there on first
 * paint. It was in index-deferred.js's after-`load` list at first, and the button painted
 * as a bare navy plate for the second before the SVG arrived, which read as a glitch.
 * The cost is one ~30 KB module pair in the early window; index.html modulepreloads
 * hero-van-art.js so the two fetch in parallel rather than in series. ONE plate is built
 * at mount; the other seven are built the first time the picker asks for them and
 * cached, so a style change costs one string build and one off-document parse.
 *
 * THE PICKER TELLS US, WE DO NOT ASK. scripts/home/hero-picker.js owns the style state and has
 * no imports (by design — it must run before app.js's graph). It publishes the current
 * style two ways: `data-hp-style` on the [data-hp-stage] element, which we read at mount
 * because the picker's tag comes first, and a `stagify:hero-style` CustomEvent on
 * `document` for every later pick. Neither side imports the other.
 */

import { BEAM, ENT, FAR, H, LAMP, LAMPS, ROAD, SKY, STARS, STYLE_HOUSE, TREE, VAN } from './hero-van-art.js';

/** The media condition under which the scene is mounted at all. */
export const SCENE_MEDIA = '(min-width: 769px) and (hover: hover) and (pointer: fine)';

/** The event scripts/home/hero-picker.js dispatches on `document` when the style changes. */
export const STYLE_EVENT = 'stagify:hero-style';

/** How long, from pointerenter, before the door has opened. A leave before this is "quick". */
const DOOR_OPEN_MS = 1050;

/** The van's parked translateX, in scene units — the CSS drive-in's end value. */
const PARK_X = 210;

/** Where the drive-out ends, in scene units — the CSS `hu-drive-out` keyframe's `to`. */
const OFF_X = 420;

/**
 * The pull-away from the parking bay (a standstill) takes this long; from anywhere else on
 * a full visit it is scaled to the distance left, clamped so a van at the edge does not
 * blink out. Its curve is the CSS default on `.hu-out .van`.
 */
const OUT_PARKED_MS = 850;
const OUT_MIN_MS = 350;
const OUT_MAX_MS = 1600;

/**
 * The drive-out's wait (0.25s, door first) plus a margin: added to its duration for the
 * fallback timer that clears `.hu-out` if no animationend ever comes — under
 * prefers-reduced-motion nothing animates, so nothing ends.
 */
const OUT_SLACK_MS = 450;

/**
 * A style change is a "rolling road": the two houses slide off to the left at their
 * parallax depths, the lamp and tree with them, while the new ones slide in from the
 * right, the road's dashes roll under them and the skyline crossfades. Sky, stars, road and van stay
 * where they are — the van in particular, so a drive in progress is never cut. This is the
 * CSS duration (`--hu-swap-ms`), for the fallback timer that ends the swap if no
 * animationend arrives.
 */
const SWAP_MS = 950;
const SWAP_SLACK_MS = 150;

/**
 * The bands a style swap replaces, top-level children of the scene <svg>, in depth order.
 * `.skyline` (the far skyline; the stars are a separate `.far` and stay), `.mid`, `.home`
 * and `.props` (lamp and tree). What is NOT here — sky, stars, road, van — is kept from the
 * old scene.
 */
const SWAP_BANDS = ['.skyline', '.mid', '.home', '.props'];

/**
 * A motion segment as the CSS plays it: a translateX from `from` to `to` over `ms` on the
 * timing curve `cubic-bezier(x1, y1, x2, y2)`.
 * `spin0` is the wheel angle at `from`, set once the segment is scheduled.
 * @typedef {{ from: number, to: number, ms: number, x1: number, y1: number, x2: number, y2: number, spin0?: number }} Segment
 */

/**
 * Wheel rotation per scene unit of travel: the tyre is r 7.4, so one turn every 46.5
 * units. Every segment spins the wheels by exactly its distance times this, on the van's
 * own duration and curve, so the wheels roll at the van's speed rather than on a clock of
 * their own — and each segment starts from the angle the last one reached (`spin0`), so
 * the spokes never jump at a join.
 */
const DEG_PER_UNIT = 360 / (2 * Math.PI * 7.4);

/** The CSS drive-in (`hu-drive-in` + the `.van` hover rule), so its speed can be read. */
const DRIVE_IN = { from: -150, to: PARK_X, ms: 1250, x1: 0.32, y1: 0.06, x2: 0.2, y2: 1, spin0: 0 };

/** The CSS pull-away (`.hu-out .van`), likewise. `ms` is set per leave. */
const PULL_AWAY = { from: PARK_X, to: OFF_X, ms: OUT_PARKED_MS, x1: 0.5, y1: 0, x2: 0.8, y2: 0.55 };

/**
 * A van that is still arriving when the pointer leaves does not stop and set off again: it
 * drives past, at the speed it has at that instant, settling to this (scene units per
 * second) by the edge — the pull-away's average pace, so a mid-drive exit ends up no
 * faster than a parked one. The drive-in peaks near 640, so it usually means easing off.
 */
const CRUISE = 250;

/** Bounds for a planned segment's duration: never a crawl, never a blink. */
const ROLL_MIN_S = 0.3;
const ROLL_MAX_S = 2.2;
const PARK_MAX_S = 1.4;

/** One coordinate of a unit cubic bezier (P0 = 0, P3 = 1) with inner controls a, b. */
const bez = (a, b, t) => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
const bezD = (a, b, t) => 3 * a * (1 - t) * (1 - t) + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;

/**
 * The van's speed, in scene units per second, at a point on a segment.
 *
 * Inverts the curve's y (progress) for the bezier parameter, then takes dy/dx there; the
 * curve's x is time, so that slope times the segment's average speed is the speed. Pure —
 * no clock involved, the position alone says where on the curve the van is.
 *
 * @param {Segment} seg
 * @param {number} x scene units; clamped to the segment
 * @returns {number}
 */
export function speedAt(seg, x) {
  const span = seg.to - seg.from;
  const p = Math.min(1, Math.max(0, (x - seg.from) / span));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bez(seg.y1, seg.y2, mid) < p) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  const dx = bezD(seg.x1, seg.x2, t);
  const dy = bezD(seg.y1, seg.y2, t);
  const slope = dx > 1e-6 ? dy / dx : 0;
  return (Math.abs(span) / seg.ms) * 1000 * slope;
}

/**
 * Plan a segment from `x` to `to` that starts at `v0` and ends at `vEnd` units per second.
 *
 * Duration is the distance over the mean of the two speeds, clamped; the timing curve's
 * end slopes are set to those speeds relative to the average, so the van's speed is
 * continuous across the join. Pure.
 *
 * @param {number} x
 * @param {number} to
 * @param {number} v0
 * @param {number} vEnd
 * @param {number} maxS
 * @returns {Segment}
 */
export function planSegment(x, to, v0, vEnd, maxS) {
  const d = Math.max(1, Math.abs(to - x));
  const T = Math.min(maxS, Math.max(ROLL_MIN_S, d / Math.max(1, (v0 + vEnd) / 2)));
  const s0 = (v0 * T) / d;
  const sE = (vEnd * T) / d;
  const x1 = 0.35;
  const x2 = 0.65;
  const y1 = Math.min(1, Math.max(0, s0 * x1));
  const y2 = Math.min(1, Math.max(0, 1 - sE * (1 - x2)));
  return { from: x, to, ms: Math.round(T * 1000), x1, y1, x2, y2 };
}

/** @param {Segment} seg */
const easeOf = (seg) => `cubic-bezier(${seg.x1.toFixed(3)}, ${seg.y1.toFixed(3)}, ${seg.x2.toFixed(3)}, ${seg.y2.toFixed(3)})`;

/** The modals a click on the button can open; each shows and hides with `.hidden`. */
const MODAL_IDS = ['stage-modal', 'auth-modal'];

/** Furniture style key → the house key hero-van-art.js draws for it. */
const HOUSE_FOR = new Map(STYLE_HOUSE.map((m) => [m.key, m.house]));

/** The style the scene shows when the picker has said nothing (matches the picker's default). */
const DEFAULT_STYLE = 'modern';

/**
 * The complete scene for one furniture style, as an SVG string: its house twice (small
 * behind, full-size with the entrance), its skyline, and its own street lamp.
 *
 * Pure: same inputs, same markup, except that entrance clip ids are numbered per call so two
 * plates in one document never share one (ENT() in hero-van-art.js). `seq` only namespaces
 * the sky gradient for the same reason.
 *
 * @param {string} styleKey a key from hero-picker.js's STYLES; unknown keys draw the default
 * @param {string|number} [seq]
 * @returns {string}
 */
export function buildScene(styleKey, seq = 0) {
  const k = HOUSE_FOR.get(styleKey) || HOUSE_FOR.get(DEFAULT_STYLE) || 'modern';
  const house = H[k];
  const far = FAR[k] || '';
  const lamp = (LAMPS[k] || LAMP)(200);
  // Farmhouse and the low Craftsman bungalow have their own trees; the others get the one
  // by the lamp.
  const tree = k === 'farmhouse' || k === 'craftsman' ? '' : TREE(118);
  return (
    `<svg viewBox="0 0 376 74" preserveAspectRatio="xMidYMax slice" focusable="false">` +
    SKY(`hu${seq}`) +
    STARS +
    far +
    `<g class="mid">${house(140, 66, false)}</g>` +
    `<g class="home">${house(276, 100, true)}${ENT(k)}</g>` +
    ROAD +
    `<g class="near props">${lamp}${tree}</g>` +
    `<g class="van">${BEAM}${VAN()}</g>` +
    `</svg>`
  );
}

/**
 * Mount the scene inside #hero-upload and keep it in step with the picker.
 *
 * Idempotent per button (a second call finds `hu-mounted` and returns). Returns the
 * controller so tests can drive it; the page ignores the return value.
 *
 * @param {Document} [doc]
 * @param {Window & typeof globalThis} [win]
 * @returns {{ current: () => string, setStyle: (key: string) => void } | null}
 */
export function initHeroVan(doc = document, win = window) {
  const btn = doc.getElementById('hero-upload');
  const scene = btn ? btn.querySelector('.hu-scene') : null;
  if (!btn || !scene || btn.classList.contains('hu-mounted')) return null;
  if (!(win.matchMedia && win.matchMedia(SCENE_MEDIA).matches)) return null;

  const stage = doc.querySelector('[data-hp-stage]');
  /** @type {Map<string, string>} */
  const built = new Map();
  let seq = 0;
  let current = '';

  /** @param {string} key */
  function markupFor(key) {
    let html = built.get(key);
    if (!html) {
      html = buildScene(key, seq++);
      built.set(key, html);
    }
    return html;
  }

  /** The bands of the outgoing style, while they slide off; emptied by finishSwap(). */
  /** @type {Element[]} */
  let leaving = [];
  /** The incoming bands, carrying `.hu-in` until the swap ends. */
  /** @type {Element[]} */
  let entering = [];
  let swapTimer = 0;

  /** End the swap now: drop the old bands, settle the new ones, stop the road. Idempotent. */
  function finishSwap() {
    if (!leaving.length && !entering.length) return;
    for (const el of leaving) el.remove();
    for (const el of entering) el.classList.remove('hu-in');
    leaving = [];
    entering = [];
    btn.classList.remove('hu-swap');
    if (swapTimer && win.clearTimeout) win.clearTimeout(swapTimer);
    swapTimer = 0;
  }

  const reducedMotion = () => !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /**
   * Show the house for `key`.
   *
   * The first paint, and every change under prefers-reduced-motion, is a plain rebuild of
   * the scene. A later change on a mounted scene is the rolling-road swap instead: the new
   * scene is built off-document and only its SWAP_BANDS are grafted into the live <svg>,
   * each right after its outgoing counterpart (so depth order holds), with `.hu-in` on the
   * new band and `.hu-leave` on the old; `.hu-swap` on the button rolls the road. The CSS
   * plays the slides and fades; `animationend` of the home's slide-in (or the fallback
   * timer) ends the swap. A change that lands mid-swap finishes the running one first, so
   * the same house is never on the street twice — its entrance clip ids are per build, and
   * a cached build reuses them.
   * @param {string} key
   */
  function setStyle(key) {
    if (key === current) return;
    const mounted = !!current;
    current = key;
    finishSwap();
    const svg = mounted ? scene.querySelector('svg') : null;
    if (!svg || reducedMotion()) {
      scene.innerHTML = markupFor(key);
      return;
    }
    const holder = doc.createElement('div');
    holder.innerHTML = markupFor(key);
    const next = holder.querySelector('svg');
    if (!next) {
      scene.innerHTML = markupFor(key);
      return;
    }
    for (const sel of SWAP_BANDS) {
      const from = svg.querySelector(':scope > ' + sel);
      const to = next.querySelector(':scope > ' + sel);
      if (!from || !to) continue;
      from.classList.add('hu-leave');
      to.classList.add('hu-in');
      svg.insertBefore(to, from.nextSibling);
      leaving.push(from);
      entering.push(to);
    }
    if (!entering.length) {
      scene.innerHTML = markupFor(key);
      return;
    }
    btn.classList.add('hu-swap');
    if (win.setTimeout) swapTimer = win.setTimeout(finishSwap, SWAP_MS + SWAP_SLACK_MS);
  }

  // The picker's tag precedes ours, so its current pick is already on the stage element.
  // Fall back to the default when the attribute is absent — an older cached picker, or
  // the picker bailed on a page without the hero.
  const initial = (stage && stage.getAttribute('data-hp-style')) || DEFAULT_STYLE;
  setStyle(initial);
  btn.classList.add('hu-mounted');

  doc.addEventListener(STYLE_EVENT, (ev) => {
    const key = /** @type {CustomEvent<{ style?: string }>} */ (ev).detail?.style;
    if (typeof key !== 'string' || !key || key === current) return;
    setStyle(key);
  });

  // "Out": the van never reverses — it arrives from the left and leaves to the right, off
  // the far edge — so the leave is its own keyframe animation, played by `.hu-out`, which
  // starts from wherever the van is at that moment: `--hu-van-x` is read off the computed
  // transform, so a leave mid-arrival just rolls on instead of snapping to the parking bay.
  // It stays on until the drive-out has ENDED (animationend, with a timer behind it for
  // the reduced-motion case where nothing animates), and while it is on the CSS applies no
  // hover rule at all: a pointer that comes straight back after the van has passed the
  // door waits for it to be off the plate and then gets the whole arrival, instead of a
  // van that teleports from the right edge to the left. A leave during a drive-out changes
  // nothing — re-reading `--hu-van-x` mid-animation would move its `from` keyframe under it.
  //
  // "Park": a pointer that comes back while the van is still SHORT of the door does not
  // watch it drive past and wait for a new one: the drive-out is cut and `.hu-park` plays
  // a planned segment from where the van is to the parking bay (`hu-drive-park`), and the
  // rest of the hover — door, lights, camera — starts as normal. The class stays on while
  // the van is parked (the hover `.van` rule would otherwise restart the drive-in from the
  // left) and goes with the next leave.
  //
  // "Stay": the pointer is back before the van has even moved — the leave's first 0.25s,
  // while the door is still closing and the van waits for it. Nothing to retarget: the
  // drive-out is cut, `.hu-park` keeps the van in the bay (a zero-length park), and
  // `.hu-reopen` drops the entrance's hover delays so the door swings back open from
  // wherever it got to instead of pausing a second for a lantern that is already lit.
  // Only a PULL-AWAY can be stayed: a rolling exit passes through the bay at speed. The
  // wheels keep their angle across the stay, and the visit counts as full from here on,
  // so the next leave is the ordered one however soon it comes.
  //
  // SPEED IS CONTINUOUS. Every planned segment (a rolling drive-out, a park) starts at the
  // speed the van has at that instant — read off its current curve, see speedAt() — and its
  // timing curve and duration are built around that (planSegment()), so a leave or a
  // return mid-drive never shows a change of pace at the join. Only the pull-away from a
  // standstill keeps its fixed CSS curve.
  //
  // "Quick" leave: if the pointer goes before the door has opened there is nothing to wait
  // for, so the CSS drops its leave delays and the van rolls on at once instead of pausing
  // for a door that never moved. Cleared on the next hover so a full visit gets the ordered
  // leave (door closes, then the van goes).
  //
  // "Hold": a click opens the stage modal (or the sign-in modal) OVER the button, which ends
  // the hover, so the van drove off behind the modal the instant it appeared. A click now
  // pins the scene at its end state with `.hu-hold` (the CSS keys every hover rule off
  // `:is(:hover, .hu-hold)`) and releases it only once no modal is open any more — a class
  // watch on the modals, since both hide with `.hidden` — or, if the click opened nothing,
  // on the next pointer leave. Release clears `.hu-quick` too: the door has been open the
  // whole time, so the ordered leave is the right one.
  let enteredAt = 0;
  let held = false;
  const modalOpen = () => MODAL_IDS.some((id) => {
    const el = doc.getElementById(id);
    return !!el && !el.classList.contains('hidden');
  });
  /**
   * Where the van is right now, in scene units; null when it cannot be read (no van, or
   * no getComputedStyle).
   *
   * Read inside a momentary `.hu-hold`: by the time pointerleave fires the :hover state
   * is already gone, and a computed-style read would cancel the drive-in and report the
   * rest position. With the hold on, the selector still matches, the animation stays
   * live, and the read returns the van's actual mid-drive transform. Nothing paints in
   * between — the class is off again before this function returns.
   */
  const readVanX = () => {
    const van = scene.querySelector('.van');
    if (!van || !win.getComputedStyle) return null;
    const wasHeld = btn.classList.contains('hu-hold');
    if (!wasHeld) btn.classList.add('hu-hold');
    const t = win.getComputedStyle(van).transform;
    if (!wasHeld) btn.classList.remove('hu-hold');
    const m = /matrix\(([^)]+)\)/.exec(t || '');
    const x = m ? parseFloat(m[1].split(',')[4]) : NaN;
    return Number.isFinite(x) ? x : null;
  };
  /** readVanX() with the parking bay as the answer when the van cannot be read. */
  const vanX = () => readVanX() ?? PARK_X;
  let outRunning = false;
  let outTimer = 0;
  let hovering = false;
  /** The curve the van is on right now, for speedAt(); null when it is at rest. */
  /** @type {Segment | null} */
  let seg = null;
  /** The wheel angle while the van rests with no segment (after a stay); 0 for a fresh van. */
  let restSpin = 0;
  /** True while the current drive-out is the pull-away from the bay (not a rolling exit). */
  let leavingBay = false;
  const outDone = () => {
    if (!outRunning) return;
    outRunning = false;
    if (outTimer && win.clearTimeout) win.clearTimeout(outTimer);
    outTimer = 0;
    btn.classList.remove('hu-out');
    // Only now: `.hu-quick` zeroes the drive-out's animation-delay, and taking it off
    // while that animation runs re-times it and the van jumps backwards.
    btn.classList.remove('hu-quick');
    // With the gate open, a pointer still on the button gets the drive-in at once.
    seg = hovering ? DRIVE_IN : null;
    // The van that left is gone; the next one arrives with its wheels at zero.
    restSpin = 0;
    leavingBay = false;
  };
  /** The wheel angle at scene x on the current segment, kept within one turn. */
  const spinAt = (x) => (seg ? ((seg.spin0 || 0) + (x - seg.from) * DEG_PER_UNIT) % 360 : restSpin);
  /** Publish a planned segment's wheel rotation for the CSS `hu-spin-seg` keyframes. */
  const setSpin = (s) => {
    const spin0 = s.spin0 ?? 0;
    btn.style.setProperty('--hu-spin-from', `${spin0.toFixed(1)}deg`);
    btn.style.setProperty('--hu-spin-to', `${(spin0 + (s.to - s.from) * DEG_PER_UNIT).toFixed(1)}deg`);
  };
  /** @param {boolean} [rolling] the van was still moving (a quick leave) */
  const driveOut = (rolling = false) => {
    if (outRunning) return;
    outRunning = true;
    const x = vanX();
    const spin0 = spinAt(x);
    btn.classList.remove('hu-park');
    let ms;
    if (rolling) {
      const v0 = seg ? speedAt(seg, x) : 0;
      seg = planSegment(x, OFF_X, v0, CRUISE, ROLL_MAX_S);
      ms = seg.ms;
      btn.style.setProperty('--hu-out-ease', easeOf(seg));
    } else {
      ms = Math.round(Math.min(OUT_MAX_MS, Math.max(OUT_MIN_MS, (OUT_PARKED_MS * (OFF_X - x)) / (OFF_X - PARK_X))));
      seg = { ...PULL_AWAY, from: x, ms };
      leavingBay = true;
      btn.style.removeProperty('--hu-out-ease');
    }
    seg.spin0 = spin0;
    setSpin(seg);
    btn.style.setProperty('--hu-van-x', `${x}px`);
    btn.style.setProperty('--hu-out-ms', `${ms}ms`);
    btn.classList.add('hu-out');
    if (win.setTimeout) outTimer = win.setTimeout(outDone, ms + OUT_SLACK_MS);
  };
  /** The pointer is back while the van is still short of the door: cut the exit, park. */
  const park = () => {
    const x = vanX();
    const v0 = seg ? speedAt(seg, x) : 0;
    const spin0 = spinAt(x);
    outDone();
    seg = planSegment(x, PARK_X, v0, 0, PARK_MAX_S);
    seg.spin0 = spin0;
    setSpin(seg);
    btn.style.setProperty('--hu-van-x', `${x}px`);
    btn.style.setProperty('--hu-out-ms', `${seg.ms}ms`);
    btn.style.setProperty('--hu-out-ease', easeOf(seg));
    btn.classList.add('hu-park');
  };
  /** The pointer is back and the van never left the bay: cancel the leave, reopen the door. */
  const stay = () => {
    const spin0 = spinAt(PARK_X);
    outDone();
    seg = null;
    restSpin = spin0;
    // The door was open (a pull-away only follows a full visit), so whatever happens next
    // is an ordered leave, however soon it comes.
    enteredAt = (win.performance ? win.performance.now() : Date.now()) - DOOR_OPEN_MS;
    setSpin({ spin0, from: PARK_X, to: PARK_X });
    btn.style.setProperty('--hu-van-x', `${PARK_X}px`);
    btn.style.setProperty('--hu-out-ms', '0ms');
    btn.style.removeProperty('--hu-out-ease');
    btn.classList.add('hu-park');
    btn.classList.add('hu-reopen');
  };
  btn.addEventListener('animationend', (ev) => {
    const name = /** @type {AnimationEvent} */ (ev).animationName;
    if (name === 'hu-drive-out') outDone();
    // The home's slide-in is the longest leg of a style swap, so its end is the swap's end.
    if (name === 'hu-home-in') finishSwap();
  });
  // A style swap keeps the van, so nothing rebuilds the scene mid-drive any more; kept as
  // a safety net, since a cancelled drive-out that never clears `.hu-out` freezes the hover.
  btn.addEventListener('animationcancel', (ev) => {
    if (/** @type {AnimationEvent} */ (ev).animationName === 'hu-drive-out') outDone();
  });
  const release = () => {
    held = false;
    driveOut(); // read while still held: the van is parked
    btn.classList.remove('hu-hold');
    btn.classList.remove('hu-quick');
  };
  btn.addEventListener('pointerenter', () => {
    hovering = true;
    if (outRunning) {
      // Still in the bay (the pull-away's wait, before the van has moved): stay. Only for
      // a pull-away — a rolling exit from a quick leave passes THROUGH the bay on its way
      // off, and a van at 210 on that path is moving, not parked. Short of the door: park
      // from here. Past it, or unreadable: let it go, a fresh van arrives once it is off
      // the plate.
      const x = readVanX() ?? OFF_X;
      if (leavingBay && seg && Math.abs(x - seg.from) < 0.5) { stay(); return; }
      enteredAt = win.performance ? win.performance.now() : Date.now();
      if (x < PARK_X) park();
      return;
    }
    enteredAt = win.performance ? win.performance.now() : Date.now();
    btn.classList.remove('hu-quick');
    if (!btn.classList.contains('hu-park')) seg = DRIVE_IN;
  });
  btn.addEventListener('pointerleave', () => {
    hovering = false;
    // Only ever matters under :hover; the next fresh arrival gets the lantern-then-door timing.
    btn.classList.remove('hu-reopen');
    if (held) {
      if (!modalOpen()) release();
      return;
    }
    if (outRunning) return;
    const now = win.performance ? win.performance.now() : Date.now();
    const quick = now - enteredAt < DOOR_OPEN_MS;
    if (quick) btn.classList.add('hu-quick');
    driveOut(quick);
  });
  btn.addEventListener('click', () => {
    held = true;
    btn.classList.remove('hu-quick');
    btn.classList.add('hu-hold');
  });
  if (typeof win.MutationObserver === 'function') {
    const mo = new win.MutationObserver(() => {
      if (held && !modalOpen()) release();
    });
    for (const id of MODAL_IDS) {
      const el = doc.getElementById(id);
      if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
  }

  return { current: () => current, setStyle };
}

/* A module tag in <head> runs after parsing and before DOMContentLoaded, so the guard takes
   the addEventListener branch; the direct branch keeps the file correct if it is ever moved
   into index-deferred.js's after-`load` list. */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initHeroVan());
  } else {
    initHeroVan();
  }
}
