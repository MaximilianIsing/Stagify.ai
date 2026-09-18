// The immersive ("rotate to landscape") view, shared by the homepage showcase and the
// guides walkthroughs.
//
// WHY THIS EXISTS. Both pages carry a fullscreen button over their demo media. On a
// phone that button was dead: iPhone Safari has no Element.requestFullscreen at all
// (video only), so `document.fullscreenEnabled` is falsy and both handlers bailed —
// and on guides it bailed into a button that was still painted (see the [hidden]
// note in guides.css). Even where native fullscreen exists on a phone, a 16:9 demo
// blown up inside a portrait viewport is a 60px-tall letterbox: useless.
//
// So on phones the button stops being a fullscreen toggle and becomes a ROTATE
// toggle. It opens a full-viewport overlay and, while the device is held upright,
// turns the content 90deg so a demo authored for a wide frame is actually readable.
// Turn the phone and the rotation drops itself; turn it back and it returns.
//
// WHY AN OVERLAY AND NOT NATIVE FULLSCREEN + screen.orientation.lock().
// `lock('landscape')` requires fullscreen and exists only on Android Chrome. iOS has
// neither half. We still TAKE the native pair where it is offered (see tryNativeLock)
// because a real OS rotation beats a simulated one — but the overlay is what actually
// carries the presentation, and the CSS rotation is what every iPhone gets.
//
// WHY THE TARGET IS PORTALED TO <body> RATHER THAN EXPANDED IN PLACE. On the homepage
// the media sits inside .shw__panel, which studio-showcase.js gives a transform on
// EVERY panel including the front one (geometryFor returns an identity transform, not
// `none`), inside .shw__stage which has `perspective: 1800px`, inside .shw__panel-inner
// which has a `backdrop-filter`. Any one of those three makes the ancestor the
// containing block for `position: fixed`, so a fixed overlay authored down there is
// clipped to the ~520px panel box. Moving the node to <body> is the only robust answer,
// and it is also what native fullscreen does (the top layer) — which is why the
// `:fullscreen` CSS both pages already ship can be reused almost verbatim for the
// `.is-immersive` class path.

/**
 * Phones and small tablets. `max-width: 900px` mirrors FLAT_QUERY in
 * studio-showcase.js and the breakpoint in home.css; `pointer: coarse` is what keeps a
 * merely-narrow desktop window on the native fullscreen path, where it belongs.
 */
export const PHONE_QUERY = '(max-width: 900px) and (pointer: coarse)';

/** The device is held upright, so the content has to be the thing that turns. */
export const PORTRAIT_QUERY = '(orientation: portrait)';

/**
 * Evaluated at CLICK time, never cached at wire time: a tablet gets rotated, a window
 * gets resized, and on iPadOS the coarse/fine pointer flips when a trackpad connects.
 *
 * @param {any} [win]
 * @returns {boolean}
 */
export function isPhone(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  return !!(w && w.matchMedia && w.matchMedia(PHONE_QUERY).matches);
}

/**
 * @param {any} [win]
 * @returns {boolean} whether the CSS rotation should be applied right now.
 */
export function wantsRotation(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  return !!(w && w.matchMedia && w.matchMedia(PORTRAIT_QUERY).matches);
}

/** How many controllers are open. A module singleton so the carousel can ask. */
let openCount = 0;

/**
 * True while any immersive view is up. The carousel's drag / wheel / select guards
 * consult this alongside `document.fullscreenElement`: cycling panels while the media
 * is portaled out would relayout the stage around an empty slot AND swap the content
 * out from under a viewer who cannot see the carousel behind the overlay.
 *
 * @returns {boolean}
 */
export function anyImmersiveOpen() {
  return openCount > 0;
}

/** Above ai-designer.css's 10001 and above any third-party widget. */
const Z = '2147483000';

/**
 * Viewport metrics in PIXELS. Not `100dvh` — dvh is unsupported below iOS 15.4 and
 * lies during the URL-bar collapse, and the duplicated sizing rules need an exact
 * number to compute an aspect ratio against.
 *
 * @param {any} win
 * @param {boolean} rotated
 * @returns {{ vw: number, vh: number, box: number }}
 */
function metrics(win, rotated) {
  const vv = win.visualViewport;
  const vw = Math.round((vv && vv.width) || win.innerWidth || 0);
  const vh = Math.round((vv && vv.height) || win.innerHeight || 0);
  // `box` is the stage's OWN height once rotated — the dimension the media has to fit
  // inside. Rotating swaps it for the viewport width.
  return { vw, vh, box: rotated ? vw : vh };
}

/**
 * Build one immersive controller for one media element and its button.
 *
 * Everything is injected rather than read off the globals so the unit test can drive
 * this against a stand-in — there is no jsdom in this repo.
 *
 * @param {{
 *   target: any,
 *   button: any,
 *   doc?: any,
 *   win?: any,
 *   onChange?: (open: boolean) => void,
 * }} deps
 */
export function createImmersive({ target, button, doc, win, onChange }) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const w = win || (typeof window !== 'undefined' ? window : null);
  /** @type {any} */
  let overlay = null;
  /** @type {any} */
  let slot = null;
  let scrollY = 0;
  let pushed = false;
  let closingViaHistory = false;
  /** @type {Array<() => void>} */
  let teardown = [];
  /** @type {any[]} */
  let inerted = [];

  const isOpen = () => overlay !== null;

  /**
   * Register a listener and its removal in one move, so close() cannot forget one.
   * @param {any} node @param {string} type @param {any} fn @param {any} [opts]
   */
  function on(node, type, fn, opts) {
    if (!node || !node.addEventListener) return;
    node.addEventListener(type, fn, opts);
    teardown.push(() => { try { node.removeEventListener(type, fn, opts); } catch (_e) { /* gone */ } });
  }

  /** Push the current viewport numbers onto the overlay for the CSS to read. */
  function syncMetrics() {
    if (!overlay) return;
    const rotated = overlay.classList.contains('imv--rotated');
    const m = metrics(w, rotated);
    overlay.style.setProperty('--imv-vw', `${m.vw}px`);
    overlay.style.setProperty('--imv-vh', `${m.vh}px`);
    overlay.style.setProperty('--imv-box', `${m.box}px`);
  }

  /**
   * The demo players place their callout card in frame PIXELS and the frame just
   * changed size, so they have to be told. Twice: iOS reports a stale size on the
   * first frame after an orientation change, and the second pass is what catches it.
   * @param {boolean} onOpen
   */
  function notify(onOpen) {
    if (typeof onChange !== 'function') return;
    const fire = () => { try { onChange(onOpen); } catch (_e) { /* a reflow must never break the view */ } };
    if (w && typeof w.requestAnimationFrame === 'function') w.requestAnimationFrame(fire);
    else fire();
    if (w && typeof w.setTimeout === 'function') w.setTimeout(fire, 250);
  }

  /** Apply or drop the CSS rotation for the device's current orientation. */
  function syncRotation() {
    if (!overlay) return;
    const want = wantsRotation(w) && !overlay.dataset.imvNative;
    const had = overlay.classList.contains('imv--rotated');
    overlay.classList.toggle('imv--rotated', want);
    // staging-studio.js maps a before/after drag through getBoundingClientRect(),
    // which reports the AXIS-ALIGNED box of a rotated element — so it has to know.
    if (want) d.documentElement.dataset.imvRotate = '90';
    else delete d.documentElement.dataset.imvRotate;
    syncMetrics();
    if (want !== had) notify(true);
  }

  /**
   * Take the native pair where the platform offers it (Android Chrome). If the lock
   * resolves the OS did the rotation for real, so the CSS rotation stands down.
   * Isolated here so the whole attempt can be deleted in one edit if it misbehaves.
   */
  function tryNativeLock() {
    if (!overlay || !d.fullscreenEnabled || typeof overlay.requestFullscreen !== 'function') return;
    const orientation = w.screen && w.screen.orientation;
    if (!orientation || typeof orientation.lock !== 'function') return;
    // Every step can be refused by the UA and there is nothing to recover — the
    // overlay is already up and correct without any of it.
    Promise.resolve(overlay.requestFullscreen())
      .then(() => orientation.lock('landscape'))
      .then(() => {
        if (!overlay) return;
        overlay.dataset.imvNative = '1';
        syncRotation();
        // A lost lock (the user pulled down the shade, another app took over) puts us
        // back on the CSS path rather than leaving a portrait-letterboxed demo.
        on(orientation, 'change', () => {
          if (!overlay) return;
          if (/portrait/.test(String(orientation.type || ''))) delete overlay.dataset.imvNative;
          syncRotation();
        });
      })
      .catch(() => {});
  }

  /** Everything outside the overlay leaves the accessibility tree and the tab order. */
  /** @param {boolean} onFlag */
  function setInert(onFlag) {
    if (onFlag) {
      const kids = /** @type {any[]} */ ([].slice.call(d.body.children));
      inerted = kids.filter((el) => el !== overlay && !el.inert);
      inerted.forEach((el) => { el.inert = true; });
    } else {
      inerted.forEach((el) => { el.inert = false; });
      inerted = [];
    }
  }

  /**
   * iOS ignores `overflow: hidden` on <body> for rubber-banding; the fixed-body +
   * negative-top trick is the one that actually holds, and it is why close() has to
   * restore the scroll position by hand.
   */
  function lockScroll() {
    scrollY = Math.round((w && w.scrollY) || 0);
    d.documentElement.classList.add('imv-lock');
    d.body.style.position = 'fixed';
    d.body.style.top = `${-scrollY}px`;
    d.body.style.width = '100%';
  }

  function unlockScroll() {
    d.documentElement.classList.remove('imv-lock');
    d.body.style.position = '';
    d.body.style.top = '';
    d.body.style.width = '';
    if (w && typeof w.scrollTo === 'function') w.scrollTo(0, scrollY);
  }

  function open() {
    if (isOpen() || !target || !d || !w) return;
    try {
      // Freeze the hole the media leaves behind at its MEASURED size. Without it the
      // showcase's ResizeObserver sees the panel collapse and shrinks the stage, and
      // the section is the wrong height for the rest of the session.
      const rect = typeof target.getBoundingClientRect === 'function'
        ? target.getBoundingClientRect()
        : { width: 0, height: 0 };
      slot = d.createElement('div');
      slot.className = 'imv-slot';
      slot.setAttribute('aria-hidden', 'true');
      slot.style.width = `${Math.round(rect.width || 0)}px`;
      slot.style.height = `${Math.round(rect.height || 0)}px`;
      target.parentNode.insertBefore(slot, target);

      overlay = d.createElement('div');
      overlay.className = 'imv';
      overlay.style.zIndex = Z;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const stage = d.createElement('div');
      stage.className = 'imv__stage';
      overlay.appendChild(stage);
      d.body.appendChild(overlay);
      stage.appendChild(target);
      target.classList.add('is-immersive');

      lockScroll();
      syncRotation();
      setInert(true);
      openCount += 1;

      if (button) {
        button.classList.add('is-fs');
        button.setAttribute('aria-pressed', 'true');
        // While open the control is a CLOSE affordance, so it takes the fullscreen
        // toggle's label back. Rewriting the data-lang-attr KEY rather than the
        // aria-label is deliberate: language-loader.js re-applies data-lang-attr on
        // every subtree insertion, and the portal above IS one — a hand-set label
        // would be stomped the instant the node lands in the overlay.
        setLabel(button, 'home.showcase.fullscreen', 'Toggle fullscreen', w);
        if (typeof button.focus === 'function') button.focus();
      }

      // A history entry so Android's back gesture closes the view instead of leaving
      // the page — the one exit affordance a phone user reaches for first.
      if (w.history && typeof w.history.pushState === 'function') {
        try { w.history.pushState({ imv: true }, '', w.location.href); pushed = true; } catch (_e) { pushed = false; }
      }

      on(d, 'keydown', (/** @type {any} */ e) => { if (e.key === 'Escape') close(); });
      on(w, 'popstate', () => { closingViaHistory = true; close(); });
      on(w, 'orientationchange', syncRotation);
      on(w, 'resize', syncMetrics);
      on(w, 'pagehide', () => close());
      if (w.visualViewport) on(w.visualViewport, 'resize', syncMetrics);
      const mq = w.matchMedia && w.matchMedia(PORTRAIT_QUERY);
      if (mq && typeof mq.addEventListener === 'function') on(mq, 'change', syncRotation);

      tryNativeLock();
      notify(true);
    } catch (_e) {
      // A throw half-way through would strand the page with `body { position: fixed }`
      // and no way back. Unwind whatever landed.
      close();
    }
  }

  function close() {
    if (!isOpen()) return;
    const ov = overlay;
    overlay = null;
    openCount = Math.max(0, openCount - 1);
    try {
      teardown.forEach((fn) => fn());
      teardown = [];
      setInert(false);
      delete d.documentElement.dataset.imvRotate;
      if (d.fullscreenElement === ov && typeof d.exitFullscreen === 'function') {
        Promise.resolve(d.exitFullscreen()).catch(() => {});
      }
      if (slot && slot.parentNode) {
        slot.parentNode.insertBefore(target, slot);
        slot.parentNode.removeChild(slot);
      }
      slot = null;
      target.classList.remove('is-immersive');
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
      if (button) {
        button.classList.remove('is-fs');
        button.setAttribute('aria-pressed', 'false');
        setLabel(button, 'home.showcase.rotate', 'Rotate to landscape', w);
        if (typeof button.focus === 'function') button.focus();
      }
    } finally {
      // Unconditional: the scroll lock is the one piece of state that makes the page
      // unusable if it survives, so it is released even if the DOM unwind threw.
      unlockScroll();
      if (pushed && !closingViaHistory && w.history && typeof w.history.back === 'function') {
        try { w.history.back(); } catch (_e) { /* nothing to unwind */ }
      }
      pushed = false;
      closingViaHistory = false;
      notify(false);
    }
  }

  return {
    open,
    close,
    toggle() { if (isOpen()) close(); else open(); },
    get isOpen() { return isOpen(); },
  };
}

/**
 * Point a button's i18n binding at a different key and apply it immediately.
 *
 * Both the attribute AND the resolved value are written: the attribute is what
 * language-loader.js's MutationObserver re-applies from then on (including when the
 * portal re-inserts the node), the value is what the button says before the packs
 * have loaded, or if they never do.
 *
 * @param {any} btn @param {string} key @param {string} fallback @param {any} win
 */
export function setLabel(btn, key, fallback, win) {
  btn.setAttribute('data-lang-attr', `${key}|aria-label`);
  const ls = win && win.LanguageSystem;
  let text = '';
  try {
    if (ls && typeof ls.isLoaded === 'function' && ls.isLoaded()) text = ls.getText(key) || '';
  } catch (_e) { text = ''; }
  btn.setAttribute('aria-label', text || fallback);
}

/**
 * Put a button on the rotate path: swap the glyph and the label, and keep both in
 * step if the media query flips later (a tablet rotating, a trackpad connecting).
 *
 * Returns nothing — the caller keeps asking `isPhone()` at click time; this is only
 * the presentation half.
 *
 * @param {any} btn @param {any} win
 */
export function markRotateButton(btn, win) {
  const apply = () => {
    const phone = isPhone(win);
    btn.classList.toggle('is-mobile-rotate', phone);
    if (!btn.classList.contains('is-fs')) {
      if (phone) setLabel(btn, 'home.showcase.rotate', 'Rotate to landscape', win);
      else setLabel(btn, 'home.showcase.fullscreen', 'Toggle fullscreen', win);
    }
  };
  apply();
  const mq = win && win.matchMedia && win.matchMedia(PHONE_QUERY);
  if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
}
