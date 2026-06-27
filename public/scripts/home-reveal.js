/* Stagify.ai — reveal homepage sections on scroll.
   Elements animate in as they enter the viewport and animate OUT in the
   direction they leave: content above slides up and fades as you scroll down,
   content below slides down and fades as you scroll up (and back again).
   Also warms image decoding so photos don't hitch when they animate in.
   Falls back to showing everything if IntersectionObserver is unavailable
   or the user prefers reduced motion. */
(() => {
  "use strict";

  function showAll() {
    document
      .querySelectorAll(".reveal")
      .forEach((el) => el.classList.add("is-visible"));
  }

  // Decode section images ahead of time so they're ready before they scroll in.
  function warmImages() {
    document
      .querySelectorAll(
        ".info-row__media img, .ba img, .plus-card__logo, .sponsor-logo, .cmp-brandcell img"
      )
      .forEach((img) => {
        if (img && typeof img.decode === "function") {
          img.decode().catch(() => {});
        }
      });
  }

  function init() {
    if (document.readyState === "complete") warmImages();
    else window.addEventListener("load", warmImages);

    const els = document.querySelectorAll(".reveal");
    if (!els.length) return;

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      showAll();
      return;
    }

    // Hysteresis: show and hide use DIFFERENT trigger points with a wide dead
    // zone between them. A single threshold makes rows parked near the edge
    // flicker in/out on the tiniest scroll — and on mobile the address bar
    // sliding in/out resizes the viewport (changing the ratio) with no scroll
    // at all. Showing at 18% but only hiding once nearly gone (4%) means that
    // jitter lands in the dead zone, where we hold the current state.
    const SHOW_AT = 0.18;
    const HIDE_AT = 0.04;

    // Only animate elements OUT on desktop. On phones/small screens the exit
    // transform (translateY 52px) physically moves the very element the observer
    // is watching, and the mobile address bar resizes the viewport during
    // touch-scroll — both keep re-crossing the trigger and make rows flicker
    // in/out near the edge. So on small screens we reveal once and leave it.
    const exitMQ =
      window.matchMedia && window.matchMedia("(min-width: 901px)");
    const exitEnabled = () => !exitMQ || exitMQ.matches;

    // If the viewport shrinks to mobile, clear any in-progress exit so nothing
    // is left stuck mid-animation, and keep already-seen rows shown.
    if (exitMQ && exitMQ.addEventListener) {
      exitMQ.addEventListener("change", (e) => {
        if (e.matches) return; // became desktop — nothing to undo
        els.forEach((el) => {
          clearTimeout(el._revTimer);
          el.classList.remove("exit-up", "exit-down");
          if (el.dataset.seen) el.classList.add("is-visible");
        });
      });
    }

    // Apply the show/exit decision from a given geometry. `root` is the
    // margin-adjusted viewport box (top/bottom). Mutates classes only.
    function decide(el, ratio, r, root) {
      // A row taller than the viewport can never reach SHOW_AT by ratio alone;
      // if it spans the whole root, treat it as fully visible.
      const spans = !!root && r.top <= root.top && r.bottom >= root.bottom;

      if (ratio >= SHOW_AT || spans) {
        el.classList.add("is-visible");
        el.classList.remove("exit-up", "exit-down");
        el.dataset.seen = "1";
      } else if (ratio <= HIDE_AT && el.dataset.seen) {
        // On small screens, don't animate out — leave the row revealed.
        if (!exitEnabled()) {
          el.classList.remove("exit-up", "exit-down");
          return;
        }
        // Which edge did it leave through? Top => scrolled down (send it up);
        // bottom => scrolled up (send it down).
        el.classList.remove("is-visible");
        const topEdge = root ? root.top : 0;
        if (r.bottom <= topEdge + 1) {
          el.classList.add("exit-up");
          el.classList.remove("exit-down");
        } else {
          el.classList.add("exit-down");
          el.classList.remove("exit-up");
        }
      }
      // Between HIDE_AT and SHOW_AT: hold current state (hysteresis band).
    }

    // Reveal INSTANTLY, hide on a short debounce. Asymmetry is the whole trick:
    // a late reveal is the one thing you actually feel (content arriving a beat
    // after it should), so showing happens the moment a row crosses SHOW_AT. The
    // exit is what causes flicker — its ±52px transform moves the very element
    // the observer watches, re-firing it and flipping state in an endless loop.
    // So the hide decision waits for the callbacks to go quiet (DEBOUNCE_MS) and
    // then reads the element's real, settled geometry once. A near-boundary
    // wobble just keeps resetting that timer (no transform applied, nothing
    // re-fires the observer) and never strobes. You never notice content leaving
    // 90ms late.
    const DEBOUNCE_MS = 90;

    // Instant path — show now, cancel any pending hide.
    function revealNow(el) {
      clearTimeout(el._revTimer);
      el.classList.add("is-visible");
      el.classList.remove("exit-up", "exit-down");
      el.dataset.seen = "1";
    }

    // Debounced path — re-read live geometry, then decide (handles the exit).
    function evaluate(el) {
      const vh =
        window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = vh * 0.06; // matches the rootMargin below
      const root = { top: margin, bottom: vh - margin };
      const r = el.getBoundingClientRect();
      const overlap =
        Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top);
      const ratio = Math.max(0, Math.min(overlap, r.height)) / (r.height || 1);
      decide(el, ratio, r, root);
    }

    function schedule(el) {
      clearTimeout(el._revTimer);
      el._revTimer = setTimeout(() => evaluate(el), DEBOUNCE_MS);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          const r = entry.boundingClientRect;
          const root = entry.rootBounds;
          // A row taller than the viewport never reaches SHOW_AT by ratio alone;
          // treat it as visible if it spans the whole root.
          const spans =
            !!root && r.top <= root.top && r.bottom >= root.bottom;
          if (entry.intersectionRatio >= SHOW_AT || spans) {
            revealNow(el); // instant
          } else {
            schedule(el); // debounced hide / re-check
          }
        });
      },
      { threshold: [0, HIDE_AT, SHOW_AT, 0.5, 1], rootMargin: "-6% 0px -6% 0px" }
    );

    els.forEach((el) => observer.observe(el));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
