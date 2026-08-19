// GENERATED FILE — do not edit by hand.
//
// Source of truth: lib/i18n/locales.js. Regenerate with:
//   node scripts/build-i18n-seo.js
// test/i18n/locale-data.test.js fails the build if this file drifts from the source.

/**
 * Every language in switcher order: English first, then the localized set.
 * `flag` is a path relative to a page in public/.
 * @type {{ lang: string, label: string, prefix: string, bcp47: string, flag: string }[]}
 */
export const LANGUAGES = [
  { lang: "english", label: "English", prefix: "", bcp47: "en", flag: "media-webp/flags/US.svg" },
  { lang: "spanish", label: "Español", prefix: "es", bcp47: "es", flag: "media-webp/flags/Spain.svg" },
  { lang: "french", label: "Français", prefix: "fr", bcp47: "fr", flag: "media-webp/flags/France.svg" },
  { lang: "german", label: "Deutsch", prefix: "de", bcp47: "de", flag: "media-webp/flags/Germany.svg" },
  { lang: "chinese", label: "中文", prefix: "zh", bcp47: "zh-Hans", flag: "media-webp/flags/China.svg" },
  { lang: "korean", label: "한국어", prefix: "ko", bcp47: "ko", flag: "media-webp/flags/Korea.svg" },
  { lang: "portuguese", label: "Português", prefix: "pt", bcp47: "pt-BR", flag: "media-webp/flags/Brazil.svg" },
  { lang: "russian", label: "Русский", prefix: "ru", bcp47: "ru", flag: "media-webp/flags/Russia.svg" },
  { lang: "italian", label: "Italiano", prefix: "it", bcp47: "it", flag: "media-webp/flags/Italy.svg" },
  { lang: "japanese", label: "日本語", prefix: "ja", bcp47: "ja", flag: "media-webp/flags/Japan.svg" },
  { lang: "dutch", label: "Nederlands", prefix: "nl", bcp47: "nl", flag: "media-webp/flags/Netherlands.svg" },
];

/** URL prefix → language value (the languages/<lang>.json basename). English has no prefix, so it is absent. */
export const PREFIX_TO_LANG = {
  es: "spanish",
  fr: "french",
  de: "german",
  zh: "chinese",
  ko: "korean",
  pt: "portuguese",
  ru: "russian",
  it: "italian",
  ja: "japanese",
  nl: "dutch",
};

/** Language value → URL prefix ('' for English). */
export const LANG_TO_PREFIX = {
  english: "",
  spanish: "es",
  french: "fr",
  german: "de",
  chinese: "zh",
  korean: "ko",
  portuguese: "pt",
  russian: "ru",
  italian: "it",
  japanese: "ja",
  dutch: "nl",
};

/** Language value → BCP-47 tag for the <html lang> attribute. */
export const LANG_BCP47 = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  chinese: "zh-Hans",
  korean: "ko",
  portuguese: "pt-BR",
  russian: "ru",
  italian: "it",
  japanese: "ja",
  dutch: "nl",
};

/** Language value → flag asset, relative to a page in public/. */
export const LANG_FLAG = {
  english: "media-webp/flags/US.svg",
  spanish: "media-webp/flags/Spain.svg",
  french: "media-webp/flags/France.svg",
  german: "media-webp/flags/Germany.svg",
  chinese: "media-webp/flags/China.svg",
  korean: "media-webp/flags/Korea.svg",
  portuguese: "media-webp/flags/Brazil.svg",
  russian: "media-webp/flags/Russia.svg",
  italian: "media-webp/flags/Italy.svg",
  japanese: "media-webp/flags/Japan.svg",
  dutch: "media-webp/flags/Netherlands.svg",
};

/** Browser tag primary subtag ('pt' of 'pt-PT') → language value. */
export const PRIMARY_SUBTAG_TO_LANG = {
  en: "english",
  es: "spanish",
  fr: "french",
  de: "german",
  zh: "chinese",
  ko: "korean",
  pt: "portuguese",
  ru: "russian",
  it: "italian",
  ja: "japanese",
  nl: "dutch",
};

/** Root-relative paths that have a localized variant. */
export const LOCALIZED_PATHS = new Set([
  "/",
  "/ai-designer.html",
  "/masking-studio.html",
  "/basic-mask.html",
  "/exterior-studio.html",
  "/stagify-plus.html",
  "/enterprise.html",
  "/guides.html",
  "/contact.html",
  "/developers.html",
  "/status",
]);
