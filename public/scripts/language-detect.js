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
      : [navigator.language || navigator.userLanguage];
    for (const tag of tags) {
      const lang = toSupported(tag);
      if (lang) return lang;
    }
    return "english";
  }

  let lang;
  try {
    lang = localStorage.getItem("selectedLanguage");
  } catch (e) {
    lang = null;
  }

  // No saved choice (or a stale/unknown one): infer from the browser and persist
  // it, so language-loader.js picks it up on this very load. An explicit choice
  // the visitor made earlier is always respected.
  if (!lang || !(lang in BCP47)) {
    lang = detect();
    try { localStorage.setItem("selectedLanguage", lang); } catch (e) {}
  }

  // Set <html lang> before first paint so assistive tech uses the right
  // pronunciation rules from the start. The switcher keeps it in sync on change.
  document.documentElement.lang = BCP47[lang] || "en";
})();
