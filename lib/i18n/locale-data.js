// Generates public/scripts/locale-data.js — the browser's copy of the language set.
//
// The browser cannot import lib/i18n/locales.js (it is outside public/, and only
// public/ is served), so the language set has to exist twice. It used to exist SIX
// times: two maps in i18n-routing.js, a BCP-47 map plus a hand-written switch in
// language-detect.js, a flag map plus another BCP-47 map in language-switcher.js,
// and a three-of-eleven class list in language-loader.js that had already drifted.
// CLAUDE.md declared locales.js the single source of truth while five frontend
// files quietly disagreed with it, and no test compared them.
//
// So: still two copies, but one of them is GENERATED from the other and a drift
// test (test/i18n/locale-data.test.js) fails the build if the committed file does
// not match this output. Run `node scripts/build-i18n-seo.js` after touching the
// locale or page set — the same command the hreflang/sitemap build already needed.
import { ALL_LOCALES, LOCALES, LOCALIZED_PAGES } from './locales.js';

/** Emit an object literal as `  key: 'value',` lines, sorted by nothing (source order). */
function entries(pairs, indent = '  ') {
  return pairs.map(([k, v]) => `${indent}${/^[a-z][a-z0-9]*$/i.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
}

/**
 * Build the contents of public/scripts/locale-data.js from lib/i18n/locales.js.
 * @returns {string} The full module source, newline-terminated.
 */
export function buildLocaleDataModule() {
  // A browser language tag maps to a UI language by its PRIMARY subtag, so
  // 'zh-TW' and 'zh-Hans' both land on chinese. Derived from bcp47 rather than
  // listed by hand — that hand-written switch was one of the five drift sites.
  const byPrimarySubtag = ALL_LOCALES.map((l) => [l.bcp47.split('-')[0], l.lang]);

  return `// GENERATED FILE — do not edit by hand.
//
// Source of truth: lib/i18n/locales.js. Regenerate with:
//   node scripts/build-i18n-seo.js
// test/i18n/locale-data.test.js fails the build if this file drifts from the source.

/**
 * Every language in switcher order: English first, then the localized set.
 * \`flag\` is a path relative to a page in public/.
 * @type {{ lang: string, label: string, prefix: string, bcp47: string, flag: string }[]}
 */
export const LANGUAGES = [
${ALL_LOCALES.map((l) => `  { lang: ${JSON.stringify(l.lang)}, label: ${JSON.stringify(l.label)}, prefix: ${JSON.stringify(l.prefix)}, bcp47: ${JSON.stringify(l.bcp47)}, flag: ${JSON.stringify('media-webp/flags/' + l.flag)} },`).join('\n')}
];

/** URL prefix → language value (the languages/<lang>.json basename). English has no prefix, so it is absent. */
export const PREFIX_TO_LANG = {
${entries(LOCALES.map((l) => [l.prefix, l.lang]))}
};

/** Language value → URL prefix ('' for English). */
export const LANG_TO_PREFIX = {
${entries(ALL_LOCALES.map((l) => [l.lang, l.prefix]))}
};

/** Language value → BCP-47 tag for the <html lang> attribute. */
export const LANG_BCP47 = {
${entries(ALL_LOCALES.map((l) => [l.lang, l.bcp47]))}
};

/** Language value → flag asset, relative to a page in public/. */
export const LANG_FLAG = {
${entries(ALL_LOCALES.map((l) => [l.lang, 'media-webp/flags/' + l.flag]))}
};

/** Browser tag primary subtag ('pt' of 'pt-PT') → language value. */
export const PRIMARY_SUBTAG_TO_LANG = {
${entries(byPrimarySubtag)}
};

/** Root-relative paths that have a localized variant. */
export const LOCALIZED_PATHS = new Set([
${LOCALIZED_PAGES.map((p) => `  ${JSON.stringify(p.path)},`).join('\n')}
]);
`;
}
