/* Stagify.ai — scroll text animations for homepage sections (not hero).
   Each [data-tx] element gets its own effect — blur, rise, slide, shiny, fade, clip. */
(() => {
  "use strict";

  let ready = false;
  const observers = new WeakMap();
  const played = new WeakSet();

  const SEGMENT_TYPES = new Set(["blur", "rise", "slide", "wave"]);
  const WHOLE_TYPES = new Set(["fade", "clip", "shiny"]);

  const SEGMENT_MODE = {
    blur: "letters",
    rise: "words",
    slide: "words",
    wave: "letters",
  };

  const DEFAULT_STAGGER = {
    letters: 24,
    words: 60,
  };

  const PRE_CLASS = {
    fade: "tx-pre-fade",
    clip: "tx-pre-clip",
    shiny: "tx-pre-shiny",
  };

  function prefersReducedMotion() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function splitWords(text) {
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function unwrap(el) {
    if (!el.querySelector(".tx-seg")) return;

    el.textContent = Array.from(el.childNodes)
      .map((node) => node.textContent || "")
      .join("");

    el.classList.remove("tx-ready");
    delete el.dataset.txWrapped;
    delete el.dataset.txWrappedMode;
  }

  function resetClasses(el) {
    el.classList.remove(
      "tx-in-blur",
      "tx-in-rise",
      "tx-in-slide",
      "tx-in-wave",
      "tx-in-fade",
      "tx-in-clip",
      "tx-in-shiny",
      "tx-pre-fade",
      "tx-pre-clip",
      "tx-pre-shiny",
      "tx-done"
    );
    el.querySelectorAll(".tx-seg").forEach((seg) => {
      seg.classList.remove("tx-in-blur", "tx-in-rise", "tx-in-slide", "tx-in-wave");
    });
  }

  function markDone(el) {
    el.classList.add("tx-done");
    played.add(el);
  }

  function wrapSegments(el, mode) {
    unwrap(el);
    const text = el.textContent.trim();
    if (!text) return;

    el.textContent = "";
    el.dataset.txWrapped = "1";
    el.dataset.txWrappedMode = mode;
    el.classList.add("tx-ready");

    if (mode === "letters") {
      let charIndex = 0;
      splitWords(text).forEach((word, wi) => {
        if (wi > 0) el.appendChild(document.createTextNode(" "));
        [...word].forEach((char) => {
          const span = document.createElement("span");
          span.className = "tx-seg";
          span.style.setProperty("--tx-i", String(charIndex++));
          span.textContent = char;
          el.appendChild(span);
        });
      });
      return;
    }

    splitWords(text).forEach((word, wi) => {
      if (wi > 0) el.appendChild(document.createTextNode(" "));
      const span = document.createElement("span");
      span.className = "tx-seg";
      span.style.setProperty("--tx-i", String(wi));
      span.textContent = word;
      el.appendChild(span);
    });
  }

  function maxAnimMs(el, type, mode) {
    const segs = el.querySelectorAll(".tx-seg");
    if (!segs.length) return 800;
    const stagger = parseInt(
      getComputedStyle(el).getPropertyValue("--tx-stagger") || "60",
      10
    );
    const base =
      type === "blur" ? 440 : type === "rise" ? 550 : type === "wave" ? 480 : 520;
    return base + segs.length * stagger + 100;
  }

  function scheduleDone(el, type, mode) {
    const ms = SEGMENT_TYPES.has(type)
      ? maxAnimMs(el, type, mode)
      : type === "clip"
        ? 820
        : type === "fade"
          ? 700
          : 1100;
    setTimeout(() => markDone(el), ms);
  }

  function play(el, type) {
    if (played.has(el)) return;

    resetClasses(el);

    if (SEGMENT_TYPES.has(type)) {
      const mode = el.dataset.txBy || SEGMENT_MODE[type] || "words";
      const stagger = parseInt(
        el.dataset.txStagger || String(DEFAULT_STAGGER[mode]),
        10
      );
      el.style.setProperty("--tx-stagger", `${stagger}ms`);
      wrapSegments(el, mode);

      const segs = el.querySelectorAll(".tx-seg");
      if (!segs.length) {
        markDone(el);
        return;
      }

      segs.forEach((seg) => seg.classList.add(`tx-in-${type}`));
      scheduleDone(el, type, mode);
      return;
    }

    if (WHOLE_TYPES.has(type)) {
      unwrap(el);
      const pre = PRE_CLASS[type];
      if (pre) el.classList.add(pre);

      requestAnimationFrame(() => {
        if (pre) el.classList.remove(pre);
        el.classList.add(`tx-in-${type}`);
        scheduleDone(el, type);
      });
    }
  }

  function showPlain(el) {
    resetClasses(el);
    unwrap(el);
    markDone(el);
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh * 0.92 && r.bottom > vh * 0.08;
  }

  function bindScroll(el) {
    const type = el.dataset.tx;
    if (!type || played.has(el)) return;

    if (prefersReducedMotion()) {
      showPlain(el);
      return;
    }

    const prev = observers.get(el);
    if (prev) prev.disconnect();

    const run = () => {
      play(el, type);
      const obs = observers.get(el);
      if (obs) obs.disconnect();
    };

    if (inView(el)) {
      run();
      return;
    }

    if (!("IntersectionObserver" in window)) {
      run();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) run();
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );

    observer.observe(el);
    observers.set(el, observer);
  }

  function targets() {
    return document.querySelectorAll(
      ".home-section [data-tx], .home-info [data-tx]"
    );
  }

  function setupAll() {
    targets().forEach(bindScroll);
  }

  function refresh() {
    played.clear();
    targets().forEach((el) => {
      resetClasses(el);
      unwrap(el);
      const prev = observers.get(el);
      if (prev) prev.disconnect();
      observers.delete(el);
      bindScroll(el);
    });
  }

  function init() {
    if (ready) return;
    ready = true;
    setupAll();
  }

  function boot() {
    window.addEventListener("languagechange", () => {
      if (!ready) init();
      else refresh();
    });

    if (document.body.classList.contains("language-loaded")) {
      init();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.HomeTextAnimate = { refresh, init };
})();
