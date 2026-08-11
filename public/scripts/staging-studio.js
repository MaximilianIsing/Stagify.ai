/* Stagify.ai — the before/after drag comparison on the homepage.
   Wipes between a real listing photo before and after Stagify worked on it.

   ONE widget now, not two. `mountWipe` owns everything about the wipe — pos state,
   pointer/touch drag, keyboard, the one-time sweep hint — and is mounted against a
   single root:
     #exterior-studio-demo  the Exterior Studio pair, inside the showcase carousel

   It used to also drive #staging-studio, the interior before/after, together with a
   `mountExamples` toggle that switched which of three photo pairs the wipe showed.
   That section is now #restage (scripts/home-restage.js): one empty room and a button
   that deals a different staging on every press. The toggle, the EXAMPLES array and
   the six media-webp/Homepage/BeforeAfter/ photos went with it.

   KEEP THIS FILE even though only one caller is left. The showcase panel is a real
   mount and the `.ba*` rules in home.css exist for it — see the note above them.

   Images live in media-webp/Homepage/Exterior/. */
(() => {
  "use strict";

  /**
   * Wire the wipe on one comparison widget: drag, keyboard, and the one-time
   * sweep hint the first time it scrolls into view. Everything here is generic —
   * nothing about it knows which section it is mounted on.
   * @param {HTMLElement} root - A section containing `.ba` and `.ba-handle`.
   * @returns {{ ba: HTMLElement } | null} The wipe's root element for callers that
   *   need to observe it, or null when this section has no wipe to mount.
   */
  function mountWipe(root) {
    const ba = /** @type {HTMLElement} */ (root.querySelector(".ba"));
    const handle = /** @type {HTMLElement} */ (root.querySelector(".ba-handle"));
    if (!ba || !handle) return null;

    /* ---- before/after wipe ---- */
    let pos = 50;
    function setPos(p) {
      pos = Math.max(0, Math.min(100, p));
      ba.style.setProperty("--pos", pos + "%");
      const v = Math.round(pos);
      handle.setAttribute("aria-valuenow", String(v));
      // Without this the value is announced as a bare "50". Deliberately "50%"
      // and not "50% staged": the widget is rendered in 11 languages and a screen
      // reader speaks "%" in the user's own language, so this adds the unit without
      // adding an English string that would need a key in every pack.
      handle.setAttribute("aria-valuetext", v + "%");
    }
    setPos(pos);

    /* ---- drag ----
       Pointer Events, NOT mouse+touch, and deliberately without any
       preventDefault() on the touch path.

       The old version bound `touchstart` with {passive:false} and called
       e.preventDefault() unconditionally, which cancelled the browser's scroll
       gesture for ANY touch starting on .ba — including a straight vertical swipe.
       .ba is full-width at aspect-ratio 3/2, so on a phone it covers most of the
       screen, and there are two of these widgets: the page simply would not scroll
       under your thumb. It also registered a non-passive `touchmove` on WINDOW,
       which made every scroll on the site wait for this handler.

       `touch-action: pan-y` (home.css) is what does the work now: the browser
       keeps vertical panning for itself and hands us horizontal movement, so there
       is nothing to preventDefault. When it decides the gesture is a vertical pan
       it fires pointercancel, which ends the drag. The 12px axis lock mirrors
       studio-showcase.js's wireDrag so both widgets feel the same.

       Pointer capture replaces the old window-level move/up listeners: moves
       outside the element still arrive, and they stop when the gesture does. */
    const AXIS_LOCK_PX = 12;
    let dragId = /** @type {number|null} */ (null);
    let startX = 0;
    let startY = 0;
    let axis = /** @type {'x'|'y'|null} */ (null);

    function pct(clientX) {
      const r = ba.getBoundingClientRect();
      return ((clientX - r.left) / r.width) * 100;
    }

    function beginDrag() {
      axis = "x";
      ba.classList.add("is-dragging");
      // preventScroll: the handle sits mid-widget, and focusing it without this
      // yanks the page on touch — the exact jump this rewrite exists to stop.
      handle.focus({ preventScroll: true });
    }

    function endDrag() {
      if (dragId !== null && ba.hasPointerCapture && ba.hasPointerCapture(dragId)) {
        ba.releasePointerCapture(dragId);
      }
      dragId = null;
      axis = null;
      ba.classList.remove("is-dragging");
    }

    ba.addEventListener("pointerdown", (e) => {
      dragId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      axis = null;
      if (e.pointerType === "mouse") {
        // A mouse has no scroll gesture to protect, so keep the old feel: jump to
        // the click position immediately. preventDefault stops the image drag-ghost.
        e.preventDefault();
        beginDrag();
        setPos(pct(e.clientX));
      }
      // Guarded: capturing a pointer that the browser has already released throws
      // NotFoundError, and losing the capture is not a reason to lose the drag.
      try {
        if (ba.setPointerCapture) ba.setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation here, not a requirement */
      }
    });

    ba.addEventListener("pointermove", (e) => {
      if (dragId === null || e.pointerId !== dragId) return;
      if (axis === null) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx + dy <= AXIS_LOCK_PX) return;
        if (dy > dx) {
          // Vertical intent: let the page scroll and stay out of the way.
          endDrag();
          return;
        }
        beginDrag();
      }
      if (axis !== "x") return;
      setPos(pct(e.clientX));
    });

    ba.addEventListener("pointerup", endDrag);
    ba.addEventListener("pointercancel", endDrag);
    /* The full WAI-ARIA slider key set, not just Left/Right. Up/Down are required
       by the pattern and are what a screen-reader user reaches for first; Home/End
       jump to the pure "before" and pure "after" frames, which is the single most
       useful thing this control can do and was previously 25 keypresses away. */
    const KEY_STEPS = {
      ArrowLeft: -4,
      ArrowDown: -4,
      ArrowRight: 4,
      ArrowUp: 4,
      PageDown: -20,
      PageUp: 20,
    };
    handle.addEventListener("keydown", (e) => {
      let next;
      if (e.key in KEY_STEPS) next = pos + KEY_STEPS[e.key];
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 100;
      else return;
      setPos(next);
      e.preventDefault();
    });

    /* ---- one-time auto-sweep hint when scrolled into view ---- */
    const reduce =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let swept = false;
    function sweep() {
      if (swept || reduce) return;
      swept = true;
      const dur = 1500;
      const startPos = 50;
      const peak = 74;
      const t0 = performance.now();
      function ease(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      }
      function frame(now) {
        // Any live pointer on the widget wins over the hint — including a touch
        // that has not locked to an axis yet, so the sweep never fights a thumb.
        if (dragId !== null) {
          setPos(startPos);
          return;
        }
        const t = Math.min((now - t0) / dur, 1);
        setPos(startPos + Math.sin(ease(t) * Math.PI) * (peak - startPos));
        if (t < 1) requestAnimationFrame(frame);
        else setPos(startPos);
      }
      requestAnimationFrame(frame);
    }
    // `typeof IntersectionObserver !== "undefined"` rather than the usual
    // `"IntersectionObserver" in window`: the `in` form narrows `window` to `never` in
    // the else branch (the property is declared non-optional on Window), so the
    // no-IntersectionObserver fallback below would not typecheck.
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              setTimeout(sweep, 280);
              obs.unobserve(en.target);
            }
          });
        },
        { threshold: 0.4 }
      );
      io.observe(ba);
    }

    return { ba };
  }

  function init() {
    // Each root is independent: a page with only one of the two sections (or a
    // section whose markup changed) mounts what it has and skips the rest, rather
    // than one missing element taking both widgets down.
    // The Exterior Studio pair is the ONLY remaining `.ba` on the site. The home page's
    // interior before/after wipe was replaced by #restage (scripts/home-restage.js), and
    // mountExamples() — the Bedroom/Living/Dining toggle that swapped which pair the wipe
    // showed — went with it, along with the EXAMPLES array and its six photos.
    const exterior = document.getElementById("exterior-studio-demo");
    if (exterior) mountWipe(exterior);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
