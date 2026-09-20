/* Stagify.ai — the hero CTA's "moving day" scene: mounting and swapping.
 *
 * #hero-upload is, on desktop, a night street with a house on the right. Hover and a
 * removal van drives in from the left, parks in the gap between the label and the house,
 * the lantern comes on, the front door swings open and an up-arrow glows in the hallway.
 * Leave and it all reverses: door first, then the van pulls away. The whole sequence is
 * CSS (styles/hero-picker.css, `#hero-upload.hu`); this file only puts the right SVG
 * inside the button and swaps it when the hero picker changes furniture style — each of
 * the eight styles is drawn as a different house, see STYLE_HOUSE in hero-van-art.js.
 *
 * DESKTOP AND A REAL POINTER ONLY. The scene is hover-driven, so on a phone it would be a
 * parked van in front of a dark house that never opens. Below 769px, or without a hovering
 * pointer, this module leaves the button exactly as index.css/styles.css paint it — the
 * classic gradient CTA — and mounts nothing. The 769px line is the same breakpoint
 * index.css already uses for this button's desktop sizing.
 *
 * LOADED FROM scripts/index-deferred.js, after `load`. The button is fully usable before
 * this arrives (hero-cta-boot.js binds the click; hero-picker.css paints the plate shell),
 * so a visitor who hovers in the first second sees a navy plate with the label and no
 * street — and then the street is there. That is the LCP trade the homepage makes for
 * everything below the hero photo, and this is 30 KB of SVG-building JS that nobody needs
 * before they can see the page. ONE plate is built at mount; the other seven are built the
 * first time the picker asks for them and cached, so a style change costs one string build
 * and one innerHTML.
 *
 * THE PICKER TELLS US, WE DO NOT ASK. scripts/hero-picker.js owns the style state and has
 * no imports (by design — it must run before app.js's graph). It publishes the current
 * style two ways: `data-hp-style` on the [data-hp-stage] element, which we read at mount
 * because the picker ran long before us, and a `stagify:hero-style` CustomEvent on
 * `document` for every later pick. Neither side imports the other.
 */

import { BEAM, ENT, FAR, H, LAMP, ROAD, SKY, STARS, STYLE_HOUSE, TREE, VAN } from './hero-van-art.js';

/** The media condition under which the scene is mounted at all. */
export const SCENE_MEDIA = '(min-width: 769px) and (hover: hover) and (pointer: fine)';

/** The event scripts/hero-picker.js dispatches on `document` when the style changes. */
export const STYLE_EVENT = 'stagify:hero-style';

/** How long, from pointerenter, before the door has opened. A leave before this is "quick". */
const DOOR_OPEN_MS = 1050;

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

  // The picker ran long before this module (it is the first module tag; we come after
  // `load`), so its current pick is on the stage element. Fall back to the default when
  // the attribute is absent — an older cached picker, or the picker bailed on a page
  // without the hero.
  const initial = (stage && stage.getAttribute('data-hp-style')) || DEFAULT_STYLE;
  setStyle(initial);
  btn.classList.add('hu-mounted');

  doc.addEventListener(STYLE_EVENT, (ev) => {
    const key = /** @type {CustomEvent<{ style?: string }>} */ (ev).detail?.style;
    if (typeof key === 'string' && key) setStyle(key);
  });

  // "Quick" leave: if the pointer goes before the door has opened there is nothing to wait
  // for, so the CSS drops its leave delays and the van reverses at once instead of pausing
  // for a door that never moved. Cleared on the next hover so a full visit gets the ordered
  // leave (door closes, then the van goes).
  let enteredAt = 0;
  btn.addEventListener('pointerenter', () => {
    enteredAt = win.performance ? win.performance.now() : Date.now();
    btn.classList.remove('hu-quick');
  });
  btn.addEventListener('pointerleave', () => {
    const now = win.performance ? win.performance.now() : Date.now();
    if (now - enteredAt < DOOR_OPEN_MS) btn.classList.add('hu-quick');
  });

  return { current: () => current, setStyle };
}

/* Injected after `load` by index-deferred.js, so the readyState guard takes the direct
   branch; written in the guarded form anyway so the file is correct wherever it is loaded. */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initHeroVan());
  } else {
    initHeroVan();
  }
}
