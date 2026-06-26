(() => {
  "use strict";

  // Maps language value -> flag asset (paths are relative to the page in /public).
  const FLAGS = {
    english: "media-webp/flags/US.webp",
    spanish: "media-webp/flags/Spain.webp",
    chinese: "media-webp/flags/China.webp",
    korean: "media-webp/flags/Korea.svg",
    french: "media-webp/flags/France.svg",
    german: "media-webp/flags/Germany.svg",
    italian: "media-webp/flags/Italy.svg",
    portuguese: "media-webp/flags/Brazil.svg",
    russian: "media-webp/flags/Russia.svg",
    japanese: "media-webp/flags/Japan.svg",
  };

  // UI language -> BCP-47 code for the <html lang> attribute (mirrors
  // language-detect.js). Keeps screen-reader pronunciation correct on switch.
  const BCP47 = {
    english: "en",
    spanish: "es",
    chinese: "zh-Hans",
    korean: "ko",
    french: "fr",
    german: "de",
    italian: "it",
    portuguese: "pt-BR",
    russian: "ru",
    japanese: "ja",
  };

  function init() {
    // The native <select> stays in the DOM (visually hidden) as the source of
    // truth so language-loader.js keeps working. This is purely the custom UI.
    const select = document.getElementById("language-select");
    const root = document.querySelector("[data-lang-switch]");
    if (!select || !root) return;

    const trigger = root.querySelector(".lang-switch__trigger");
    const flagEl = root.querySelector(".lang-switch__flag");
    const labelEl = root.querySelector(".lang-switch__label");
    const options = Array.from(root.querySelectorAll(".lang-switch__option"));

    const labelFor = (value) => {
      const opt = options.find((o) => o.dataset.value === value);
      return opt ? opt.querySelector("span").textContent : value;
    };

    function currentValue() {
      // Prefer the persisted choice — language-loader.js sets the <select>
      // value asynchronously, so localStorage is the reliable source on load.
      return localStorage.getItem("selectedLanguage") || select.value || "english";
    }

    function sync() {
      const value = currentValue();
      if (select.value !== value) select.value = value;
      document.documentElement.lang = BCP47[value] || "en";
      if (FLAGS[value]) flagEl.src = FLAGS[value];
      labelEl.textContent = labelFor(value);
      options.forEach((o) =>
        o.setAttribute("aria-selected", String(o.dataset.value === value))
      );
    }

    function open() {
      root.setAttribute("data-open", "");
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onKey);
    }

    function close() {
      root.removeAttribute("data-open");
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey);
    }

    function onOutside(e) {
      if (!root.contains(e.target)) close();
    }

    function onKey(e) {
      const focusable = options;
      const idx = focusable.indexOf(document.activeElement);
      if (e.key === "Escape") {
        close();
        trigger.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        focusable[Math.min(idx + 1, focusable.length - 1) || 0].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (idx <= 0 ? focusable[focusable.length - 1] : focusable[idx - 1]).focus();
      }
    }

    function choose(value) {
      if (value !== select.value) {
        select.value = value;
        // language-loader.js listens for "change": persists + reloads strings.
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      sync();
      close();
      trigger.focus();
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (root.hasAttribute("data-open")) {
        close();
      } else {
        open();
        const active = options.find((o) => o.getAttribute("aria-selected") === "true");
        (active || options[0]).focus();
      }
    });

    options.forEach((opt) => {
      opt.addEventListener("click", () => choose(opt.dataset.value));
      opt.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose(opt.dataset.value);
        }
      });
    });

    // language-loader.js fires this once strings are applied.
    window.addEventListener("languagechange", sync);
    sync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
