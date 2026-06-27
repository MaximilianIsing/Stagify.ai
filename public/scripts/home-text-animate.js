/* Stagify.ai — scroll text animations for homepage sections (not hero).
   Each [data-tx] element gets its own effect — blur, rise, slide, shiny, fade, clip. */
(() => {
  "use strict";

  let ready = false;
  const observers = new WeakMap();
  let played = new WeakSet();

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
    // Children mode animates existing child elements (e.g. the hero <h1>'s
    // per-word data-lang spans). Never collapse those to text — just strip the
    // animation classes so the original markup (and i18n) stays intact.
    if (el.hasAttribute("data-tx-children")) {
      el.querySelectorAll(":scope > .tx-seg").forEach((s) => {
        s.classList.remove(
          "tx-seg",
          "tx-in-blur",
          "tx-in-rise",
          "tx-in-slide",
          "tx-in-wave"
        );
        s.style.removeProperty("--tx-i");
      });
      return;
    }
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

    if (type === "decrypt") {
      playDecrypt(el);
      return;
    }

    resetClasses(el);

    if (SEGMENT_TYPES.has(type)) {
      const useChildren = el.hasAttribute("data-tx-children");
      const mode = el.dataset.txBy || SEGMENT_MODE[type] || "words";
      const stagger = parseInt(
        el.dataset.txStagger || String(DEFAULT_STAGGER[mode]),
        10
      );
      el.style.setProperty("--tx-stagger", `${stagger}ms`);

      let segs;
      if (useChildren) {
        // Animate existing child elements in place (preserves their markup/i18n).
        // Skip structural nodes like <br>.
        segs = Array.from(el.children).filter((c) => c.tagName !== "BR");
        segs.forEach((seg, i) => {
          seg.classList.add("tx-seg");
          seg.style.setProperty("--tx-i", String(i));
        });
      } else {
        wrapSegments(el, mode);
        segs = Array.from(el.querySelectorAll(".tx-seg"));
      }

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

  // Decrypted text — characters scramble, then resolve left-to-right into the
  // final string. Used sparingly as a signature moment.
  function playDecrypt(el) {
    if (played.has(el)) return;
    const finalText = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!finalText) {
      markDone(el);
      return;
    }

    const glyphs = "!<>-_\\/[]{}=+*^?#@%&".split("");
    const total = finalText.length;
    // Reserve current width so swapping glyphs doesn't reflow / re-center.
    el.style.minWidth = el.offsetWidth + "px";
    el.classList.add("tx-decrypting");

    let revealed = 0;
    const interval = setInterval(() => {
      let out = "";
      for (let i = 0; i < total; i++) {
        const ch = finalText[i];
        if (ch === " ") {
          out += " ";
        } else if (i < revealed) {
          out += ch;
        } else {
          out += glyphs[Math.floor(Math.random() * glyphs.length)];
        }
      }
      el.textContent = out;
      revealed += 1;
      if (revealed > total) {
        clearInterval(interval);
        el.textContent = finalText;
        el.classList.remove("tx-decrypting");
        el.style.removeProperty("min-width");
        markDone(el);
      }
    }, 45);
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
      const delay = parseInt(el.dataset.txDelay || "0", 10);
      if (delay > 0) setTimeout(() => play(el, type), delay);
      else play(el, type);
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
      ".hero-content [data-tx], .home-section [data-tx], .home-info [data-tx]"
    );
  }

  function setupAll() {
    targets().forEach(bindScroll);
  }

  function refresh() {
    played = new WeakSet();
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
