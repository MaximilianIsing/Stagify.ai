// The homepage studio showcase: one 3D carousel holding the four panels that used
// to be four stacked sections (AI Designer, Masking Studio, Exterior Studio, and
// the saved-renders gallery mock).
//
// WHAT THIS OWNS
//   - which panel is in front, and the transform ladder that arcs the rest behind it
//   - the stage height: the tallest panel while the arc is on show, the front panel
//     alone once the narrow layout has hidden the neighbours
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

/** @returns {boolean} whether the carousel is in the narrow, one-panel-at-a-time mode. */
function isFlat() {
  return window.matchMedia(FLAT_QUERY).matches;
}

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
 * @property {HTMLElement[]} dots position dots for the narrow stepper; empty if unbuilt
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
  const flat = isFlat();
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
 * The stage height rule, split out from the DOM work so it can be tested: given every
 * panel's natural height, which one does the stage adopt?
 *
 * @param {number[]} heights natural panel heights, in panel order
 * @param {number} active index of the front panel
 * @param {boolean} flat narrow viewport — the neighbours are not rendered
 * @returns {number}
 */
export function stageHeightFor(heights, active, flat) {
  if (!heights.length) return 0;
  if (flat) return heights[active] || 0;
  return heights.reduce((max, h) => Math.max(max, h), 0);
}

/**
 * The height the stage should take, in px.
 *
 * WIDE: the TALLEST panel, so all five cards match and the section does not resize as
 * you cycle — the neighbours are visible in the arc, and cards of visibly different
 * heights side by side is the thing that rule exists to stop.
 *
 * FLAT (narrow): the FRONT panel only. Below 900px the neighbours are not rendered at
 * all (geometryFor sends every non-front panel to `hidden`), so there is nothing left
 * for a shared height to line up with — it just parks the tallest panel's height under
 * every other one. On a phone that was up to ~270px of empty glass inside the card,
 * split above and below the demo by .shw__panel-body's centring, on a viewport whose
 * scrollable area is ~480px tall to begin with.
 *
 * Measuring means briefly dropping equal-height mode: with `.shw--equal` on, every
 * panel reports the stage's height and asking them how tall they want to be is
 * circular. Two forced layouts, on init/resize/mount only — not per frame.
 *
 * @param {Showcase} sc
 * @returns {number} the natural height to adopt, or 0 if nothing measured
 */
function naturalHeight(sc) {
  const wasEqual = sc.root.classList.contains('shw--equal');
  if (wasEqual) sc.root.classList.remove('shw--equal');
  const h = stageHeightFor(sc.panels.map((p) => p.offsetHeight), sc.active, isFlat());
  if (wasEqual) sc.root.classList.add('shw--equal');
  return h;
}

/**
 * @param {Showcase} sc
 */
function measure(sc) {
  const h = naturalHeight(sc);
  if (h <= 0) return;
  // Set `height` outright rather than feeding a custom property that the stylesheet
  // then reads: one less indirection to get wrong, and an inline height cannot lose
  // to a stylesheet rule the way a var()-driven one can.
  const next = `${h}px`;
  // Writing the same value is skipped, not merely harmless. The ResizeObserver below
  // watches the panels, and measuring resizes them twice — so an unconditional write
  // gives that observer something to react to on every pass, and the two can drive
  // each other indefinitely. A settled measurement must produce NO mutation.
  if (sc.stage.style.height === next) return;
  if (sc.sized) {
    sc.stage.style.height = next;
    return;
  }
  // The FIRST measurement jumps rather than animates. The stylesheet ships a
  // placeholder height for the frame before this runs, and transitioning off it
  // would show as the whole section visibly growing once on load.
  sc.sized = true;
  const prev = sc.stage.style.transition;
  sc.stage.style.transition = 'none';
  sc.stage.style.height = next;
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
 * Position dots for the narrow layout, where the CSS hides every tab but the active one
 * and the strip becomes a `‹ Masking Studio ›` stepper. The label alone says WHICH studio
 * you are on but not that there are five of them, or where in the five you are — the dots
 * are the only thing carrying that, which is what the four hidden tabs used to carry.
 *
 * Built here rather than authored in index.html so the count is derived from the panels
 * and cannot drift from them. Decoration, not a control: `aria-hidden`, no roles, no
 * strings — the tabs (wide) and the arrows (narrow) are the real controls, and a screen
 * reader already gets "tab 3 of 5" from the tablist itself.
 *
 * @param {HTMLElement} root
 * @param {number} count
 * @returns {HTMLElement[]} the dots, in panel order (empty if there is nowhere to put them)
 */
function buildDots(root, count) {
  const nav = root.querySelector('.shw__nav');
  if (!nav || !nav.parentNode) return [];
  const wrap = document.createElement('div');
  wrap.className = 'shw__dots';
  wrap.setAttribute('aria-hidden', 'true');
  const dots = [];
  for (let i = 0; i < count; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'shw__dot';
    wrap.appendChild(dot);
    dots.push(dot);
  }
  nav.parentNode.insertBefore(wrap, nav.nextSibling);
  return dots;
}

/**
 * Reflect `active` in the tablist and its dots, which is the only chrome the carousel
 * has: everything else is the panels themselves, plus drag / wheel / click-a-side-panel.
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
  // Every route into select() lands here — arrows, a swipe, a wheel flick, a deep link —
  // so the dots follow the carousel however it was moved, not only when a tab was clicked.
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
    // Cycling while a panel is expanded would swap the fullscreen content out from
    // under the viewer, who cannot see the carousel behind it to know what happened.
    if (document.fullscreenElement) return;
    const target = /** @type {HTMLElement} */ (e.target);
    // .hgal-grid is the gallery mock's scroller: a touch drag inside it must scroll
    // the cards, not flick the carousel to the next studio.
    if (target.closest('.ba, .designer-demo, .hgal-grid, a, button, input, [role="slider"]')) return;
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
      if (document.fullscreenElement) return; // see the note in wireDrag
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
 * The prev/next arrows either side of the tablist. They are the narrow layout's control:
 * below 900px the CSS shows only the active tab, so the pair steps through the studios
 * one at a time instead of asking for a sideways scroll inside a page that scrolls down.
 *
 * They wrap rather than dead-ending at the ends — select() already reduces modulo the
 * panel count, and the drag and wheel paths wrap too, so a disabled state at the ends
 * would be the odd one out. That also means neither arrow ever needs `aria-disabled`.
 *
 * Not folded into wireTabs(): these sit OUTSIDE role="tablist", which may contain only
 * tabs, and the keydown gate there is scoped to `.shw__tabs` for that reason.
 *
 * @param {Showcase} sc
 */
function wireArrows(sc) {
  const arrows = /** @type {HTMLElement[]} */ ([].slice.call(sc.root.querySelectorAll('[data-shw-arrow]')));
  arrows.forEach((arrow) => {
    const step = Number(arrow.dataset.shwArrow);
    if (!step) return;
    arrow.addEventListener('click', () => select(sc, sc.active + step));
  });
}

/**
 * The fullscreen control on each media panel. The button toggles rather than only
 * entering, so the same control gets you back out — `aria-pressed` carries the state,
 * which means the label never has to change and the i18n pack needs one key, not two.
 *
 * @param {Showcase} sc
 */
function wireFullscreen(sc) {
  const buttons = /** @type {HTMLElement[]} */ ([].slice.call(sc.root.querySelectorAll('[data-shw-fullscreen]')));
  if (!buttons.length) return;
  // Some embedding contexts disallow fullscreen outright. Hide the control instead of
  // shipping a button whose only behaviour is a rejected promise.
  if (!document.fullscreenEnabled) {
    buttons.forEach((btn) => { btn.hidden = true; });
    return;
  }
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const media = btn.closest('.shw__media');
      if (!media) return;
      if (document.fullscreenElement === media) document.exitFullscreen();
      // A rejection here is normal — a user gesture can be refused — and there is
      // nothing to recover, so swallow it rather than surfacing an unhandled rejection.
      else media.requestFullscreen().catch(() => {});
    });
  });
  document.addEventListener('fullscreenchange', () => {
    buttons.forEach((btn) => {
      const on = document.fullscreenElement === btn.closest('.shw__media');
      btn.classList.toggle('is-fs', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // The player and the before/after slider both hit-test against their own box,
    // which just changed size — re-measure so the stage still matches on the way out.
    measure(sc);
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
  if (!stage || panels.length < 2 || tabs.length !== panels.length) return null;
  return { root, stage, panels, tabs, dots: buildDots(root, panels.length), active: 0, sized: false };
}

function init() {
  const root = /** @type {HTMLElement|null} */ (document.querySelector('[data-showcase]'));
  if (!root) return;
  const sc = build(root);
  // Bail with the markup untouched rather than half-upgrading it: the CSS fallback
  // keeps the panels as readable stacked blocks for as long as .shw--ready is absent.
  if (!sc) return;

  wireTabs(sc);
  wireArrows(sc);
  wireDrag(sc);
  wireWheel(sc);
  wireFullscreen(sc);

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

  /* role="tabpanel" is applied HERE, not authored in index.html, because it is only
     true once the tabbed presentation exists. Without this script the CSS fallback
     hides .shw__tabs and stacks the panels as plain blocks — but the panels used to
     carry role="tabpanel" regardless, leaving five tabpanels whose owning tablist
     was display:none and therefore absent from the accessibility tree. Orphaned
     tabpanels are worse than no ARIA at all; plain <div>s degrade correctly.

     The panels are <div>s and not <article>s for the same reason from the other end:
     `tabpanel` is not an allowed role on <article>, whose implicit `article` role only
     permits document/feed/main/region/none/presentation/application. Lighthouse reported
     that pairing as a malformed accessibility tree. A <div> carries no implicit role, so
     the role applied here is legal.

     aria-labelledby deliberately STAYS in the markup: it is the declared pairing
     between tab i and panel i, and test/frontend/studio-showcase.test.js reads it
     out of the source to prove the positional wiring is right. On a no-JS page it
     points at a display:none tab, which yields no accessible name — the same
     nameless <article> you would get without it, so it costs nothing there.

     The ids also stay in the markup — they are deep-link targets (see the panel-id
     warning in index.html) and must exist whether or not this runs. */
  sc.panels.forEach((panel) => panel.setAttribute('role', 'tabpanel'));

  root.classList.add('shw--ready');
  // Equal-height mode. measure() drops this for the duration of a measurement and
  // puts it back, so it must be on before the first select().
  root.classList.add('shw--equal');

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
