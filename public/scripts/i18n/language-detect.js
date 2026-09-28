import { urlLanguage } from "./i18n-routing.js";
// Both tables are GENERATED from lib/i18n/locales.js. They used to be a hand-kept
// BCP-47 map plus a hand-written switch, either of which could silently fall a
// language behind the server's list.
import { LANG_BCP47 as BCP47, PRIMARY_SUBTAG_TO_LANG } from "./locale-data.js";

(() => {
  "use strict";

  // Map a browser language tag (e.g. "fr-FR", "zh-TW") to a supported UI language,
  // or null if we don't translate that language yet. Only the primary subtag is
  // consulted, so "zh-TW" and "zh-Hans" both resolve to chinese.
  function toSupported(tag) {
    const primary = String(tag || "").toLowerCase().split("-")[0];
    return Object.prototype.hasOwnProperty.call(PRIMARY_SUBTAG_TO_LANG, primary)
      ? PRIMARY_SUBTAG_TO_LANG[primary]
      : null;
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
