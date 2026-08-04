/* Stagify.ai — before/after drag comparisons on the homepage.
   Wipes between a real listing photo before and after Stagify worked on it.

   TWO widgets, one behaviour. `mountWipe` owns everything about the wipe — pos
   state, pointer/touch drag, keyboard, the one-time sweep hint — and is mounted
   against both roots:
     #staging-studio        interiors, plus a toggle between example rooms
     #exterior-studio-demo  the Exterior Studio pair, no toggle
   Only the interior widget has examples, so the switching/preloading below is
   attached separately by `mountExamples` rather than living inside the wipe. A
   root missing either piece is skipped, so neither section is load-bearing for
   the other.

   Images live in media-webp/Homepage/BeforeAfter/ and .../Homepage/Exterior/. */
(() => {
  "use strict";

  const EXAMPLES = [
    {
      before: "media-webp/Homepage/BeforeAfter/Before2.webp",
      after: "media-webp/Homepage/BeforeAfter/After2.webp",
    },
    {
      before: "media-webp/Homepage/BeforeAfter/Before1.webp",
      after: "media-webp/Homepage/BeforeAfter/After1.webp",
    },
    {
      before: "media-webp/Homepage/BeforeAfter/Before3.webp",
      after: "media-webp/Homepage/BeforeAfter/After3.webp",
    },
  ];

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
      handle.setAttribute("aria-valuenow", String(Math.round(pos)));
    }
    setPos(pos);

    let dragging = false;
    function pct(clientX) {
      const r = ba.getBoundingClientRect();
      return ((clientX - r.left) / r.width) * 100;
    }
    function start(e) {
      dragging = true;
      ba.classList.add("is-dragging");
      handle.focus();
      moveTo(e);
      e.preventDefault();
    }
    function moveTo(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      setPos(pct(x));
    }
    function end() {
      dragging = false;
      ba.classList.remove("is-dragging");
    }
    ba.addEventListener("mousedown", start);
    window.addEventListener("mousemove", moveTo);
    window.addEventListener("mouseup", end);
    ba.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", moveTo, { passive: false });
    window.addEventListener("touchend", end);
    handle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        setPos(pos - 4);
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        setPos(pos + 4);
        e.preventDefault();
      }
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
        if (dragging) {
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

  /**
   * Attach the example-room toggle to a widget that has one. The Exterior Studio
   * pair has no `.studio-ex` buttons and no second pair to swap in, so it returns
   * immediately — which is why this is separate from the wipe rather than a
   * branch inside it.
   * @param {HTMLElement} root - A section already passed through `mountWipe`.
   * @param {{ ba: HTMLElement }} wipe - That call's return value.
   * @returns {void}
   */
  function mountExamples(root, wipe) {
    const ba = wipe.ba;
    const beforeImg = /** @type {HTMLImageElement} */ (root.querySelector(".ba-before"));
    const afterImg = /** @type {HTMLImageElement} */ (root.querySelector(".ba-after"));
    const exBtns = Array.from(root.querySelectorAll(".studio-ex"));
    if (!exBtns.length || !beforeImg || !afterImg) return;

    // Preload every variant so toggling is instant — but NOT at init.
    //
    // media-webp/Homepage/BeforeAfter/ is 511 KB across the six files, and this used to
    // fire on DOMContentLoaded, i.e. squarely inside the LCP window. On PageSpeed's
    // mobile profile (~200 KB/s) that is ~2.5 s of bandwidth taken from the hero image,
    // for a widget that is below the fold and cannot be clicked until it is on screen.
    // Deferring costs nothing: show() already loads the pair it needs and only swaps
    // after both decode, so a cold tab click still renders correctly, just a beat later.
    let preloaded = false;
    function preloadVariants() {
      if (preloaded) return;
      preloaded = true;
      EXAMPLES.forEach((e) =>
        [e.before, e.after].forEach((s) => {
          const i = new Image();
          i.src = s;
        })
      );
    }

    /* ---- example switching ---- */
    function show(i) {
      const ex = EXAMPLES[i];
      if (!ex || !beforeImg || !afterImg) return;
      let n = 0;
      const done = () => {
        if (++n >= 2) {
          beforeImg.src = ex.before;
          afterImg.src = ex.after;
          requestAnimationFrame(() => ba.classList.remove("is-swapping"));
        }
      };
      ba.classList.add("is-swapping");
      const a = new Image();
      a.onload = done;
      a.onerror = done;
      a.src = ex.before;
      const b = new Image();
      b.onload = done;
      b.onerror = done;
      b.src = ex.after;
      exBtns.forEach((btn, bi) => {
        const on = bi === i;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
    }
    exBtns.forEach((btn, i) => btn.addEventListener("click", () => show(i)));

    // See mountWipe for why this is a `typeof` check and not `in window`.
    if (typeof IntersectionObserver !== "undefined") {
      // A separate observer from the sweep's in mountWipe, deliberately: this one
      // fires a screenful EARLY (rootMargin) and at threshold 0, so the variants are
      // warm by the time the widget is usable — whereas the sweep must wait until it
      // is 40% visible to be seen at all.
      const preloadIo = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              preloadVariants();
              obs.unobserve(en.target);
            }
          });
        },
        { rootMargin: "600px 0px" }
      );
      preloadIo.observe(ba);
    } else {
      // No IntersectionObserver: fall back to warming after the page has settled, which
      // is still off the LCP critical path.
      window.addEventListener("load", preloadVariants, { once: true });
    }

    // Whatever happens above, a click must never wait on the observer.
    exBtns.forEach((btn) =>
      /** @type {Element} */ (btn).addEventListener("pointerenter", preloadVariants, { once: true })
    );
  }

  function init() {
    // Each root is independent: a page with only one of the two sections (or a
    // section whose markup changed) mounts what it has and skips the rest, rather
    // than one missing element taking both widgets down.
    const studio = document.getElementById("staging-studio");
    if (studio) {
      const wipe = mountWipe(studio);
      // Examples only make sense on top of a mounted wipe — `show()` drives the same
      // `.ba` the drag does.
      if (wipe) mountExamples(studio, wipe);
    }

    // The Exterior Studio pair: one before/after, no room toggle.
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
