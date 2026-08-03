/* Stagify.ai — before/after drag comparison studio.
   Wipes between a real listing photo before and after Stagify staged it,
   with a toggle between example rooms. Images live in
   media-webp/Homepage/BeforeAfter/. */
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

  function init() {
    const studio = document.getElementById("staging-studio");
    if (!studio) return;

    const ba = /** @type {HTMLElement} */ (studio.querySelector(".ba"));
    const handle = /** @type {HTMLElement} */ (studio.querySelector(".ba-handle"));
    const beforeImg = /** @type {HTMLImageElement} */ (studio.querySelector(".ba-before"));
    const afterImg = /** @type {HTMLImageElement} */ (studio.querySelector(".ba-after"));
    const exBtns = Array.from(studio.querySelectorAll(".studio-ex"));
    if (!ba || !handle) return;

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

      // Separate observer, deliberately: this one fires a screenful EARLY (rootMargin)
      // and at threshold 0, so the variants are warm by the time the widget is usable —
      // whereas the sweep above must wait until it is 40% visible to be seen at all.
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
