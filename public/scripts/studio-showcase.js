// The homepage studio showcase: one 3D carousel holding the four panels that used
// to be four stacked sections (AI Designer, Masking Studio, Exterior Studio, and
// the saved-renders gallery mock).
//
// WHAT THIS OWNS
//   - which panel is in front, and the transform ladder that arcs the rest behind it
//   - the stage height, which follows the FRONT panel rather than the tallest one
//   - mounting the front panel's walkthrough player, and only that one
//   - the four deep links, which are redirect targets and not merely anchors
//
// PROGRESSIVE ENHANCEMENT. The panels are plain stacked blocks until this file adds
// `.shw--ready` (see the fallback block in styles/home.css). If this script never
// loads, the page degrades to the four sections it replaced rather than to four
// absolutely-positioned panels piled on top of each other.
//
// THE DEEP LINKS ARE THE FRAGILE PART. #ai-designer-demo is where ai-designer-gate.js
// and ai-designer-app.js send signed-out, free and mobile visitors who try to open the
// AI Designer; four tests assert that URL. Those ids now live on the panels, so this
// script has to bring the matching panel to the front on load and on hashchange —
// otherwise the redirect lands on a section showing the wrong studio.

/**
 * Below this width the arc has no room either side, so the carousel goes flat and
 * shows one panel at a time. Mirrors `.shw__stage { perspective: none }` in
 * styles/home.css — move one and you must move the other.
 */
const FLAT_QUERY = '(max-width: 900px)';

/** Pointer travel (px) that commits to a step rather than being read as a stray drag. */
const DRAG_THRESHOLD = 60;

/** Minimum gap (ms) between wheel-driven steps, so one trackpad flick is one step. */
const WHEEL_COOLDOWN = 420;

/**
 * Descendants that would otherwise be tab stops inside a panel that is not in front.
 * `.ba-handle` (role=slider, tabindex=0) is the one that actually bites: without this
 * sweep, tabbing through the page walks into the exterior slider of a panel that is
 * rotated 30 degrees away and half transparent.
 */
const FOCUSABLE = 'a[href], button, input, select, textarea, iframe, [tabindex]';

/**
 * @typedef {object} Showcase
 * @property {HTMLElement} root
 * @property {HTMLElement} stage
 * @property {HTMLElement[]} panels
 * @property {HTMLElement[]} tabs
 * @property {HTMLElement[]} dots
 * @property {number} active
 * @property {boolean} sized whether the stage has been measured at least once
 */

/**
 * Shortest signed distance from `active` to `i` around a ring of `n`.
 * With the shipped n=4 this yields one left neighbour, one right neighbour and one
 * panel at distance 2 that stays hidden behind the front one.
 *
 * @param {number} i
 * @param {number} active
 * @param {number} n
 * @returns {number}
 */
export function offsetOf(i, active, n) {
  let d = i - active;
  if (d > n / 2) d -= n;
  else if (d < -n / 2) d += n;
  return d;
}

/**
 * The transform ladder. Note the front panel resolves to an identity transform:
 * the walkthrough player and the .ba drag slider both hit-test against
 * getBoundingClientRect(), which reports post-transform boxes, so anything other
 * than identity here silently skews every pointer interaction inside the panel.
 *
 * @param {number} d signed ring distance from the front panel
 * @param {boolean} flat narrow viewport — no arc, one panel at a time
 * @returns {{ transform: string, opacity: number, z: number, state: 'front'|'side'|'hidden' }}
 */
export function geometryFor(d, flat) {
  if (d === 0) {
    return { transform: 'translate3d(0, 0, 0) rotateY(0deg) scale(1)', opacity: 1, z: 3, state: 'front' };
  }
  const sign = d > 0 ? 1 : -1;
  if (flat || Math.abs(d) > 1) {
    return {
      transform: `translate3d(${sign * 110}%, 0, -460px) rotateY(${-sign * 36}deg) scale(0.8)`,
      opacity: 0,
      z: 1,
      state: 'hidden',
    };
  }
  // Pushed out to 64% and scaled down rather than sitting at full size just off centre:
  // the front card is translucent glass, so a neighbour that still overlaps it reads
  // THROUGH it and its heading collides with the front panel's subtitle.
  return {
    transform: `translate3d(${sign * 64}%, 0, -340px) rotateY(${-sign * 28}deg) scale(0.88)`,
    opacity: 0.34,
    z: 2,
    state: 'side',
  };
}

/**
 * Take every focusable descendant of a panel out of (or back into) the tab order.
 * The original tabindex is parked on `data-shw-tabindex` so restoring it does not
 * invent `tabindex="0"` on elements that never had one.
 *
 * @param {HTMLElement} panel
 * @param {boolean} on
 */
function setPanelFocusable(panel, on) {
  const nodes = /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll(FOCUSABLE));
  nodes.forEach((el) => {
    if (on) {
      const prev = el.getAttribute('data-shw-tabindex');
      if (prev === null) return;
      if (prev === '') el.removeAttribute('tabindex');
      else el.setAttribute('tabindex', prev);
      el.removeAttribute('data-shw-tabindex');
    } else {
      if (el.hasAttribute('data-shw-tabindex')) return;
      el.setAttribute('data-shw-tabindex', el.getAttribute('tabindex') ?? '');
      el.setAttribute('tabindex', '-1');
    }
  });
}

/**
 * Position every panel for the current `active` index.
 * @param {Showcase} sc
 */
function layout(sc) {
  const flat = window.matchMedia(FLAT_QUERY).matches;
  const n = sc.panels.length;
  sc.panels.forEach((panel, i) => {
    const g = geometryFor(offsetOf(i, sc.active, n), flat);
    panel.style.transform = g.transform;
    panel.style.opacity = String(g.opacity);
    panel.style.zIndex = String(g.z);
    panel.dataset.shwState = g.state;
    const front = g.state === 'front';
    // A side panel stays clickable (that is how you bring it forward), so it cannot
    // be `inert` — inert would kill the click too. aria-hidden plus the tabindex
    // sweep gets the same result for assistive tech without disabling the pointer.
    if (front) panel.removeAttribute('aria-hidden');
    else panel.setAttribute('aria-hidden', 'true');
    setPanelFocusable(panel, front);
  });
}

/**
 * Size the stage to the front panel. Panels are absolutely positioned, so the stage
 * has no natural height of its own; without this it would have to be padded out to
 * the tallest of the four and the short ones would float in a hole.
 *
 * @param {Showcase} sc
 */
function measure(sc) {
  const front = sc.panels[sc.active];
  if (!front) return;
  const h = front.offsetHeight;
  if (h <= 0) return;
  // Set `height` outright rather than feeding a custom property that the stylesheet
  // then reads: one less indirection to get wrong, and an inline height cannot lose
  // to a stylesheet rule the way a var()-driven one can.
  if (sc.sized) {
    sc.stage.style.height = `${h}px`;
    return;
  }
  // The FIRST measurement jumps rather than animates. The stylesheet ships a
  // placeholder height for the frame before this runs, and transitioning off it
  // would show as the whole section visibly growing once on load.
  sc.sized = true;
  const prev = sc.stage.style.transition;
  sc.stage.style.transition = 'none';
  sc.stage.style.height = `${h}px`;
  void sc.stage.offsetHeight; // flush the change so the restored transition ignores it
  sc.stage.style.transition = prev;
}

/**
 * Mount the front panel's walkthrough player, if it has one and it is not already up.
 * Only the front panel is ever mounted — designer-demo.js used to mount both players
 * on idle whether or not anyone scrolled this far.
 *
 * @param {Showcase} sc
 */
function mountFrontDemo(sc) {
  const front = sc.panels[sc.active];
  if (!front) return;
  const host = /** @type {HTMLElement|null} */ (front.querySelector('.designer-demo[data-demo]'));
  if (!host) return;
  const mount = window.stagifyMountDemo;
  // If designer-demo.js has not executed yet there is nothing to call. It fires
  // `stagify:demo-mount-ready` when it does, and init() retries on that event — the
  // deferred scripts are injected dynamically, so their execution order is not
  // guaranteed and this cannot assume it has already run.
  if (typeof mount === 'function') mount(host);
}

/**
 * Reflect `active` in the tablist and the dots.
 * @param {Showcase} sc
 */
function updateChrome(sc) {
  sc.tabs.forEach((tab, i) => {
    const on = i === sc.active;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    // Roving tabindex: the tablist is one tab stop, arrow keys move within it.
    if (on) tab.removeAttribute('tabindex');
    else tab.setAttribute('tabindex', '-1');
  });
  sc.dots.forEach((dot, i) => dot.classList.toggle('is-active', i === sc.active));
}

/**
 * @param {Showcase} sc
 * @param {number} next index, wrapped
 * @param {{ focusTab?: boolean }} [opts]
 */
function select(sc, next, opts) {
  const n = sc.panels.length;
  const i = ((next % n) + n) % n;
  sc.active = i;
  layout(sc);
  updateChrome(sc);
  mountFrontDemo(sc);
  measure(sc);
  if (opts && opts.focusTab && sc.tabs[i]) sc.tabs[i].focus();
}

/**
 * Map a location.hash onto a panel index. Takes plain ids rather than the Showcase so
 * the deep-link rule — the fragile part of this file — is unit-testable without a DOM.
 *
 * @param {string[]} panelIds in panel order
 * @param {string} hash e.g. '#ai-designer-demo'
 * @returns {number} panel index, or -1 when the hash names nothing here
 */
export function indexForHash(panelIds, hash) {
  const id = hash.replace(/^#/, '');
  if (!id) return -1;
  return panelIds.indexOf(id);
}

/**
 * Carousel drag. Deliberately does NOT start from the front panel's interactive
 * content: the exterior panel's before/after slider is itself a drag, and the
 * walkthrough player has its own hit targets. Dragging works from panel chrome,
 * the stage background, and side panels.
 *
 * @param {Showcase} sc
 */
function wireDrag(sc) {
  let id = /** @type {number|null} */ (null);
  let startX = 0;
  let startY = 0;
  let axis = /** @type {'x'|'y'|null} */ (null);

  sc.stage.addEventListener('pointerdown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('.ba, .designer-demo, a, button, input, [role="slider"]')) return;
    id = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    axis = null;
  });

  sc.stage.addEventListener('pointermove', (e) => {
    if (id === null || e.pointerId !== id) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // Lock to an axis once past the noise floor, so a mostly-vertical drag scrolls
    // the page instead of flicking the carousel.
    if (axis === null && Math.abs(dx) + Math.abs(dy) > 12) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (axis !== 'x') return;
    if (Math.abs(dx) < DRAG_THRESHOLD) return;
    select(sc, sc.active + (dx < 0 ? 1 : -1));
    id = null;
  });

  const end = (/** @type {PointerEvent} */ e) => {
    if (id !== null && e.pointerId === id) id = null;
  };
  sc.stage.addEventListener('pointerup', end);
  sc.stage.addEventListener('pointercancel', end);
}

/**
 * Horizontal wheel / trackpad. Stays passive and never preventDefaults, so vertical
 * page scrolling over the carousel is completely untouched.
 *
 * @param {Showcase} sc
 */
function wireWheel(sc) {
  let last = 0;
  sc.stage.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const now = e.timeStamp;
      if (now - last < WHEEL_COOLDOWN) return;
      last = now;
      select(sc, sc.active + (e.deltaX > 0 ? 1 : -1));
    },
    { passive: true }
  );
}

/**
 * Tablist keyboard behaviour, per the WAI-ARIA tabs pattern.
 * @param {Showcase} sc
 */
function wireTabs(sc) {
  sc.tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(sc, i));
  });
  sc.root.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target.closest('.shw__tabs')) return;
    const n = sc.panels.length;
    let next = -1;
    if (e.key === 'ArrowRight') next = sc.active + 1;
    else if (e.key === 'ArrowLeft') next = sc.active - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === -1) return;
    e.preventDefault();
    select(sc, next, { focusTab: true });
  });
}

/**
 * @param {HTMLElement} root
 * @returns {Showcase|null}
 */
function build(root) {
  const stage = /** @type {HTMLElement|null} */ (root.querySelector('.shw__stage'));
  const panels = /** @type {HTMLElement[]} */ ([].slice.call(root.querySelectorAll('.shw__panel')));
  const tabs = /** @type {HTMLElement[]} */ ([].slice.call(root.querySelectorAll('.shw__tab')));
  const dots = /** @type {HTMLElement[]} */ ([].slice.call(root.querySelectorAll('.shw__dot')));
  if (!stage || panels.length < 2 || tabs.length !== panels.length) return null;
  return { root, stage, panels, tabs, dots, active: 0, sized: false };
}

function init() {
  const root = /** @type {HTMLElement|null} */ (document.querySelector('[data-showcase]'));
  if (!root) return;
  const sc = build(root);
  // Bail with the markup untouched rather than half-upgrading it: the CSS fallback
  // keeps the panels as readable stacked blocks for as long as .shw--ready is absent.
  if (!sc) return;

  wireTabs(sc);
  wireDrag(sc);
  wireWheel(sc);

  root.querySelectorAll('[data-shw-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = Number(/** @type {HTMLElement} */ (btn).dataset.shwStep) || 0;
      select(sc, sc.active + step);
    });
  });

  // Clicking a panel that is not in front brings it forward.
  sc.panels.forEach((panel, i) => {
    panel.addEventListener('click', () => {
      if (panel.dataset.shwState === 'side') select(sc, i);
    });
  });

  // designer-demo.js may not have executed yet — the deferred scripts are injected
  // dynamically, so their order is not guaranteed. Retry the mount when it announces.
  document.addEventListener('stagify:demo-mount-ready', () => mountFrontDemo(sc));

  // The player mounting, a font swap or an i18n string swap all change the front
  // panel's height after the fact; the stage has to follow.
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => measure(sc));
    sc.panels.forEach((p) => ro.observe(p));
  }
  window.addEventListener('resize', () => {
    layout(sc);
    measure(sc);
  });

  root.classList.add('shw--ready');

  const panelIds = sc.panels.map((p) => p.id);
  const fromHash = indexForHash(panelIds, location.hash);
  select(sc, fromHash >= 0 ? fromHash : 0);

  window.addEventListener('hashchange', () => {
    const i = indexForHash(panelIds, location.hash);
    if (i >= 0) select(sc, i);
  });

  // One more measure after load: .shw--ready has only just switched the panels to
  // absolute positioning, and lazy images below the fold may still be resolving.
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => measure(sc), { once: true });
  }
}

// Guarded on `document` so the unit test can import this module for the pure helpers
// exported above without it trying to initialise against a DOM that is not there.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // index-deferred.js injects this file after `load`, so DOMContentLoaded has long
    // since fired — a bare listener would never run. (See the trap note in that file.)
    init();
  }
}
