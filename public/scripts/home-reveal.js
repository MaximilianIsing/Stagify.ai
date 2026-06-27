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
          el._revLock = false;
          el.classList.remove("exit-up", "exit-down");
          if (el.dataset.seen) el.classList.add("is-visible");
        });
      });
    }

    // A compact signature of the element's current visual state, so we can tell
    // whether a decision actually changed anything.
    const stateKey = (el) =>
      (el.classList.contains("is-visible") ? "V" : "") +
      (el.classList.contains("exit-up") ? "U" : "") +
      (el.classList.contains("exit-down") ? "D" : "");

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

    // The reveal/exit transition is 0.6s plus an optional --reveal-delay. While
    // it plays, the element physically moves (translateY ±52px), which makes the
    // observer re-fire and — near a trigger point — flip the state back, moving
    // it again: an endless in/out loop. So once we change an element's state we
    // LOCK it for the duration of the transition, ignoring further callbacks,
    // then re-check its real (settled) position exactly once.
    const SETTLE_MS = 760;

    function commit(el, ratio, r, root) {
      if (el._revLock) return;
      const before = stateKey(el);
      decide(el, ratio, r, root);
      if (stateKey(el) === before) return; // dead-zone hold: nothing changed
      el._revLock = true;
      clearTimeout(el._revTimer);
      el._revTimer = setTimeout(() => {
        el._revLock = false;
        settle(el);
      }, SETTLE_MS);
    }

    // Recompute geometry from the live layout (the observer won't fire again on
    // its own unless a threshold is re-crossed) and apply the correct state.
    function settle(el) {
      const vh =
        window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = vh * 0.06; // matches the rootMargin below
      const root = { top: margin, bottom: vh - margin };
      const r = el.getBoundingClientRect();
      const overlap =
        Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top);
      const ratio = Math.max(0, Math.min(overlap, r.height)) / (r.height || 1);
      commit(el, ratio, r, root);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          commit(
            entry.target,
            entry.intersectionRatio,
            entry.boundingClientRect,
            entry.rootBounds
          );
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
