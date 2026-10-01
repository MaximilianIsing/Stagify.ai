// The blog's language selector — the one way a reader moves between languages of an
// article.
//
// WHY THIS IS NOT THE SITE'S LANGUAGE SWITCHER
// The marketing pages carry a <select id="language-select"> driven by language-switcher.js
// + language-loader.js + the .lang-switch CSS. Blog pages load none of that (blog.css and
// footer-year.js, nothing else), and wiring the client i18n stack onto a page whose
// translation is ALREADY server-rendered would be pure regression risk on the site's
// most-crawled surface. The switcher also assumes every language exists for every page,
// which is false here by design: an article exists in the languages its packs exist for.
//
// So this is a <details> disclosure holding plain <a hreflang> links — a real dropdown with
// no JavaScript at all, since <details>/<summary> is native. It is rendered from the same
// manifest the hreflang cluster and the routes come from, so it cannot advertise a URL that
// 404s, and because it sits in the topbar of every blog page it is also the crawl path into
// the ten localized trees.
//
// It is baked into the ENGLISH files by scripts/build-i18n-seo.js rather than injected at
// render time, so that the static English pages carry it too, and so the label translates
// through the ordinary data-lang path like every other string on the page. Rendering a
// locale then only has to move `aria-current` and swap the name on the button — see
// markCurrentLang.

import { ENGLISH } from './locales.js';

/** The generated region, removed whole on a refresh so injection stays idempotent. */
const EXISTING_PICKER = /[ \t]*<details class="blog-langs"[\s\S]*?<\/details>[ \t]*\r?\n(?:[ \t]*\r?\n)*/i;

/**
 * The first shape this shipped in: a flat link list above the footer. Stripped on every
 * build so a file that still has one loses it rather than carrying both.
 */
const LEGACY_FOOTER_NAV = /[ \t]*<nav class="post-langs"[\s\S]*?<\/nav>[ \t]*\r?\n(?:[ \t]*\r?\n)*/i;

/** Where the picker goes: immediately before the topbar's call to action. */
const TOPBAR_CTA = /([ \t]*)<a class="blog-cta-btn"/i;

/**
 * @param {import('./locales.js').Locale} locale @param {string} path
 * @returns {string}
 */
function localizedHref(locale, path) {
  return locale.prefix ? `/${locale.prefix}${path}` : path;
}

/**
 * One locale's flag, from the same `LOCALES[].flag` the site switcher uses.
 *
 * `alt=""` on purpose: the flag sits beside the language's own name, so a described flag
 * would have a screen reader announce every entry twice ("Spain flag, Español"). Absolute
 * path, not the relative one in locale-data.js — a blog article lives at /blog/<slug>, so a
 * relative src would resolve under /blog/ on the static English pages, which get no <base>.
 *
 * @param {import('./locales.js').Locale} locale
 * @param {boolean} [eager]  true for the button's flag, which is in the topbar and visible
 *   immediately — lazy-loading an above-the-fold image only makes it pop in late. The ten
 *   in the closed menu are exactly what lazy is for.
 */
function flagImg(locale, eager = false) {
  return `<img class="blog-langs__flag" src="/media-webp/flags/${locale.flag}" alt="" `
    + `width="22" height="15"${eager ? '' : ' loading="lazy"'} decoding="async">`;
}

/**
 * Build the picker markup for one blog path.
 *
 * `hreflang` on each link is load-bearing twice over: it tells a crawler what it will get,
 * and render-page.js's rewriteAnchors skips any <a hreflang> precisely so these hrefs — the
 * only ones on the site that name a locale explicitly — survive the prefix rewrite that
 * would otherwise point all eleven at the current language.
 *
 * @param {string} path      the English path ('/blog/home-staging-cost', '/blog/')
 * @param {import('./locales.js').Locale[]} locales  the variants that EXIST, English first
 * @param {string} [indent]
 * @returns {string} '' when there is nothing to offer
 */
export function buildLangNav(path, locales, indent = '      ') {
  // One locale is English alone: a picker whose only option is the page you are on. Emit
  // nothing rather than a control that does nothing.
  if (!locales || locales.length < 2) return '';
  const items = locales.map((locale) => {
    const current = locale.prefix === ENGLISH.prefix ? ' aria-current="page"' : '';
    return `${indent}    <li><a href="${localizedHref(locale, path)}" hreflang="${locale.hreflang}" `
      + `lang="${locale.bcp47}"${current}>${flagImg(locale)}`
      + `<span class="blog-langs__name">${locale.label}</span></a></li>`;
  });
  return [
    `${indent}<details class="blog-langs">`,
    `${indent}  <summary class="blog-langs__button">`,
    // The flag of the language you are currently reading — same asset set as the marketing
    // pages' switcher, so the two controls agree about what each language looks like.
    `${indent}    ${flagImg(ENGLISH, true)}`,
    // The accessible name. Visually hidden because the button already shows the current
    // language, and a topbar has no room for the sentence.
    `${indent}    <span class="blog-langs__hint" data-lang="navigation.readInLanguage">Read this in another language</span>`,
    `${indent}    <span class="blog-langs__current">${ENGLISH.label}</span>`,
    `${indent}    <svg class="blog-langs__caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">`,
    `${indent}      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    `${indent}    </svg>`,
    `${indent}  </summary>`,
    `${indent}  <ul class="blog-langs__menu">`,
    ...items,
    `${indent}  </ul>`,
    `${indent}</details>`,
  ].join('\n');
}

/**
 * Inject (or refresh) the language picker in one English blog page, in the topbar just
 * before the CTA. Idempotent, and preserves the file's line ending. Returns the HTML
 * unchanged when there is no translation to link to, after removing any picker a previous
 * run left behind — so deleting the last pack for an article removes its picker rather
 * than stranding it.
 *
 * @param {string} html
 * @param {string} path
 * @param {import('./locales.js').Locale[]} locales
 * @returns {string}
 */
export function injectLangNav(html, path, locales) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const out = html.replace(EXISTING_PICKER, '').replace(LEGACY_FOOTER_NAV, '');
  const nav = buildLangNav(path, locales);
  if (!nav) return out;
  return out.replace(TOPBAR_CTA, (_m, indent) => `${nav.split('\n').join(eol)}${eol}${indent}<a class="blog-cta-btn"`);
}

/**
 * Point the picker at `locale`, at render time: move `aria-current` onto that language's
 * link, and put its name on the button.
 *
 * The baked markup names English, because that is what the static file serves. Every
 * localized render is the same picker with the marker one entry further down, which is a
 * cheaper and less error-prone operation than rebuilding it per locale — the hrefs, the
 * order and the labels are identical in all eleven.
 *
 * The button's name and flag are copied out of the matching link rather than passed in, so
 * each has exactly one source: change LOCALES and the menu and the button move together.
 *
 * @param {string} html
 * @param {string} hreflang  the current locale's hreflang ('es', 'zh-Hans', …)
 * @returns {string}
 */
export function markCurrentLang(html, hreflang) {
  const picker = EXISTING_PICKER.exec(html);
  if (!picker) return html;
  // hreflang values come from LOCALES and are BCP-47 tags — letters and hyphens only — so
  // they go into the pattern as-is rather than through an escaper that would never fire.
  const link = new RegExp(
    `(<a\\b[^>]*\\shreflang="${hreflang}"[^>]*)>([\\s\\S]*?)</a>`, 'i',
  ).exec(picker[0]);
  if (!link) return html;
  const flag = (/src="([^"]+)"/i.exec(link[2]) || [])[1];
  const name = (/<span class="blog-langs__name">([\s\S]*?)<\/span>/i.exec(link[2]) || [])[1];

  let marked = picker[0]
    .replace(/\s+aria-current="page"/gi, '')
    .replace(link[1], `${link[1]} aria-current="page"`);
  if (name) {
    marked = marked.replace(
      /(<span class="blog-langs__current">)[\s\S]*?(<\/span>)/i,
      (_m, open, close) => `${open}${name}${close}`,
    );
  }
  if (flag) {
    // Only the FIRST flag — the one on the button. The menu's flags are already right, and
    // a global replace would put this locale's flag on all eleven entries.
    marked = marked.replace(/(<img class="blog-langs__flag" src=")[^"]*/i, (_m, open) => `${open}${flag}`);
  }
  return html.slice(0, picker.index) + marked + html.slice(picker.index + picker[0].length);
}
