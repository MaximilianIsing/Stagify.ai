/* Stagify.ai — the hero CTA's "moving day" scene: mounting and swapping.
 *
 * #hero-upload is, on desktop, a night street with a house on the right. Hover and a
 * removal van drives in from the left, parks in the gap between the label and the house,
 * the lantern comes on, the front door swings open and an up-arrow glows in the hallway.
 * Leave and it all reverses: door first, then the van pulls away. The whole sequence is
 * CSS (styles/hero-picker.css, `#hero-upload.hu`); this file puts the right SVG inside
 * the button, swaps it when the hero picker changes furniture style — each of the eight
 * styles is drawn as a different house, see STYLE_HOUSE in hero-van-art.js — and sets three
 * state classes the CSS reads: `.hu-out` (the pointer left; drive on, off the right edge),
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
 * cached, so a style change costs one string build and one innerHTML.
 *
 * THE PICKER TELLS US, WE DO NOT ASK. scripts/hero-picker.js owns the style state and has
 * no imports (by design — it must run before app.js's graph). It publishes the current
 * style two ways: `data-hp-style` on the [data-hp-stage] element, which we read at mount
 * because the picker's tag comes first, and a `stagify:hero-style` CustomEvent on
 * `document` for every later pick. Neither side imports the other.
 */

import { BEAM, ENT, FAR, H, LAMP, ROAD, SKY, STARS, STYLE_HOUSE, TREE, VAN } from './hero-van-art.js';

/** The media condition under which the scene is mounted at all. */
export const SCENE_MEDIA = '(min-width: 769px) and (hover: hover) and (pointer: fine)';

/** The event scripts/hero-picker.js dispatches on `document` when the style changes. */
export const STYLE_EVENT = 'stagify:hero-style';

/** How long, from pointerenter, before the door has opened. A leave before this is "quick". */
const DOOR_OPEN_MS = 1050;

/** The van's parked translateX, in scene units — the CSS drive-in's end value. */
const PARK_X = 210;

/** Where the drive-out ends, in scene units — the CSS `hu-drive-out` keyframe's `to`. */
const OFF_X = 420;

/**
 * The drive-out from the parking bay takes this long; from anywhere else it is scaled to
 * the distance left (same road speed), clamped so a van that has barely arrived does not
 * crawl and a van at the edge does not blink out.
 */
const OUT_PARKED_MS = 750;
const OUT_MIN_MS = 350;
const OUT_MAX_MS = 1600;

/**
 * A van that is still arriving when the pointer leaves does not stop and set off again:
 * it drives past. Its drive-out runs at the arrival's pace rather than the pull-away's,
 * so the reference time is scaled down by this much (the CSS pairs it with a curve that
 * has no ease-in).
 */
const OUT_ROLLING_FACTOR = 0.7;

/**
 * The drive-out's wait (0.25s, door first) plus a margin: added to its duration for the
 * fallback timer that clears `.hu-out` if no animationend ever comes — under
 * prefers-reduced-motion nothing animates, so nothing ends.
 */
const OUT_SLACK_MS = 450;

/** The modals a click on the button can open; each shows and hides with `.hidden`. */
const MODAL_IDS = ['stage-modal', 'auth-modal'];

/** Furniture style key → the house key hero-van-art.js draws for it. */
const HOUSE_FOR = new Map(STYLE_HOUSE.map((m) => [m.key, m.house]));

/** The style the scene shows when the picker has said nothing (matches the picker's default). */
const DEFAULT_STYLE = 'modern';

/**
 * The complete scene for one furniture style, as an SVG string.
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
    `<g class="near">${LAMP(200)}${tree}</g>` +
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
 * @param {Window} [win]
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

  /** @param {string} key */
  function setStyle(key) {
    if (key === current) return;
    current = key;
    scene.innerHTML = markupFor(key);
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
    // The rebuild threw away the van that was driving out, and a detached element's
    // animationcancel never reaches us — so end the drive-out here.
    outDone();
  });

  // "Out": the van never reverses — it arrives from the left and leaves to the right, off
  // the far edge — so the leave is its own keyframe animation, played by `.hu-out`, which
  // starts from wherever the van is at that moment: `--hu-van-x` is read off the computed
  // transform, so a leave mid-arrival just rolls on instead of snapping to the parking bay.
  // It stays on until the drive-out has ENDED (animationend, with a timer behind it for
  // the reduced-motion case where nothing animates), and while it is on the CSS applies no
  // hover rule at all: a pointer that comes straight back waits for the van to be off the
  // plate and then gets the whole arrival, instead of a van that teleports from the right
  // edge to the left. A leave during a drive-out changes nothing — re-reading `--hu-van-x`
  // mid-animation would move its `from` keyframe under it.
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
   * Where the van is right now, in scene units, for the drive-out to start from.
   *
   * Read inside a momentary `.hu-hold`: by the time pointerleave fires the :hover state
   * is already gone, and a computed-style read would cancel the drive-in and report the
   * rest position. With the hold on, the selector still matches, the animation stays
   * live, and the read returns the van's actual mid-drive transform. Nothing paints in
   * between — the class is off again before this function returns.
   */
  const vanX = () => {
    const van = scene.querySelector('.van');
    if (!van || !win.getComputedStyle) return PARK_X;
    const wasHeld = btn.classList.contains('hu-hold');
    if (!wasHeld) btn.classList.add('hu-hold');
    const t = win.getComputedStyle(van).transform;
    if (!wasHeld) btn.classList.remove('hu-hold');
    const m = /matrix\(([^)]+)\)/.exec(t || '');
    const x = m ? parseFloat(m[1].split(',')[4]) : NaN;
    return Number.isFinite(x) ? x : PARK_X;
  };
  let outRunning = false;
  let outTimer = 0;
  const outDone = () => {
    if (!outRunning) return;
    outRunning = false;
    if (outTimer && win.clearTimeout) win.clearTimeout(outTimer);
    outTimer = 0;
    btn.classList.remove('hu-out');
    // Only now: `.hu-quick` zeroes the drive-out's animation-delay, and taking it off
    // while that animation runs re-times it and the van jumps backwards.
    btn.classList.remove('hu-quick');
  };
  /** @param {boolean} [rolling] the van was still arriving (a quick leave) */
  const driveOut = (rolling = false) => {
    if (outRunning) return;
    outRunning = true;
    const x = vanX();
    const ref = rolling ? OUT_PARKED_MS * OUT_ROLLING_FACTOR : OUT_PARKED_MS;
    const ms = Math.round(Math.min(OUT_MAX_MS, Math.max(OUT_MIN_MS, (ref * (OFF_X - x)) / (OFF_X - PARK_X))));
    btn.style.setProperty('--hu-van-x', `${x}px`);
    btn.style.setProperty('--hu-out-ms', `${ms}ms`);
    btn.classList.add('hu-out');
    if (win.setTimeout) outTimer = win.setTimeout(outDone, ms + OUT_SLACK_MS);
  };
  btn.addEventListener('animationend', (ev) => {
    if (/** @type {AnimationEvent} */ (ev).animationName === 'hu-drive-out') outDone();
  });
  // A style swap rebuilds the scene mid-animation, which cancels it without an end event.
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
    enteredAt = win.performance ? win.performance.now() : Date.now();
    if (!outRunning) btn.classList.remove('hu-quick');
  });
  btn.addEventListener('pointerleave', () => {
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
