import { urlLanguage } from "./i18n-routing.js";

(() => {
  "use strict";

  // Supported UI languages -> BCP-47 code used for the <html lang> attribute.
  // Keep this list in sync with the options in the language switcher.
  const BCP47 = {
    english: "en",
    spanish: "es",
    chinese: "zh-Hans",
    korean: "ko",
    french: "fr",
    german: "de",
    dutch: "nl",
    italian: "it",
    portuguese: "pt-BR",
    russian: "ru",
    japanese: "ja",
  };

  // Map a browser language tag (e.g. "fr-FR", "zh-TW") to a supported UI language,
  // or null if we don't translate that language yet.
  function toSupported(tag) {
    switch (String(tag || "").toLowerCase().split("-")[0]) {
      case "es": return "spanish";
      case "zh": return "chinese";
      case "ko": return "korean";
      case "fr": return "french";
      case "de": return "german";
      case "nl": return "dutch";
      case "it": return "italian";
      case "pt": return "portuguese";
      case "ru": return "russian";
      case "ja": return "japanese";
      case "en": return "english";
      default: return null;
    }
  }

  // Walk the visitor's ordered language preferences and pick the first we support.
  function detect() {
    const tags = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || /** @type {any} */ (navigator).userLanguage];
    for (const tag of tags) {
      const lang = toSupported(tag);
      if (lang) return lang;
    }
    return "english";
  }

  // On a localized URL (/es, /fr/…) the URL is authoritative — it wins over any
  // stored preference so the page the visitor opened matches what they see, and
  // shareable localized links always render in their language.
  const forced = urlLanguage();

  let lang;
  if (forced && forced in BCP47) {
    lang = forced;
  } else {
    try {
      lang = localStorage.getItem("selectedLanguage");
    } catch (e) {
      lang = null;
    }

    // No saved choice (or a stale/unknown one): infer from the browser. An explicit
    // choice the visitor made earlier is always respected.
    if (!lang || !(lang in BCP47)) lang = detect();
  }

  // Persist so language-loader.js picks it up on this very load and the switcher
  // shows the right current language.
  try { localStorage.setItem("selectedLanguage", lang); } catch (e) {}

  // Set <html lang> before first paint so assistive tech uses the right
  // pronunciation rules from the start. The switcher keeps it in sync on change.
  document.documentElement.lang = BCP47[lang] || "en";
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
