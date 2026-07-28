// Flag assets and <html lang> codes, GENERATED from lib/i18n/locales.js. These were
// a second hand-maintained copy of the maps in language-detect.js; a language added
// to one and not the other rendered with the wrong flag or the wrong lang attribute.
import { LANG_FLAG as FLAGS, LANG_BCP47 as BCP47 } from "./locale-data.js";

(() => {
  "use strict";

  function init() {
    // The native <select> stays in the DOM (visually hidden) as the source of
    // truth so language-loader.js keeps working. This is purely the custom UI.
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById("language-select"));
    const root = document.querySelector("[data-lang-switch]");
    if (!select || !root) return;

    const trigger = /** @type {HTMLElement | null} */ (root.querySelector(".lang-switch__trigger"));
    const flagEl = /** @type {HTMLImageElement | null} */ (root.querySelector(".lang-switch__flag"));
    const labelEl = root.querySelector(".lang-switch__label");
    const options = /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(".lang-switch__option")));

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
      const idx = focusable.indexOf(/** @type {HTMLElement} */ (document.activeElement));
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

// The import above already makes this an ES module (it is loaded as
// <script type="module">), so `eslint .` covers it via the auto-discovery in
// eslint.config.js without the marker export this file used to carry.
