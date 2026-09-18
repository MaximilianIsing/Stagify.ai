// Point a localized blog page at its localized cover image.
//
// Six of the fifteen covers carry words burned into the picture. scripts/build-blog-covers.js
// renders those per language as `cover-N.<lang>.webp` alongside the English `cover-N.webp`,
// and this rewrites the three URLs an article spends them on — the <figure>, the og:image
// and the twitter:image — plus the thumbnail on the hub's card.
//
// It matters most for the one nobody previews: og:image. That is the picture a reader sees
// in a Slack unfurl or a search result BEFORE they see the page, so an English headline
// baked into it is the first thing a Spanish reader meets, ahead of any of the prose that
// was carefully translated.
//
// Covers with no text (seven of them) are never localized because there is nothing to
// localize. Two more have text that cannot be swapped — cover-11's "FOR SALE BY OWNER"
// sign is part of the photographed scene, and cover-14 is a chart whose labels sit on the
// plotted fill — so they stay English. Both cases are the same to this module: the variant
// is absent from the manifest, so the URL is left alone and the English cover is served.
// A localized page showing the English cover is a cosmetic shortfall; a page pointing at
// a cover that was never rendered is a broken image, so absence always means "leave it".

import { BLOG_COVER_LOCALES } from './blog-covers-manifest.js';

/** `cover-12.webp`, `cover-12-og.jpg`, `cover-12-thumb.webp` — the three forms in use. */
const COVER_URL = /cover-(\d+)(\.webp|-og\.jpg|-thumb\.webp)/g;

/**
 * Which languages a cover has a rendered variant for.
 * @param {string} coverId  e.g. 'cover-12'
 * @returns {string[]} language pack names ('spanish', …)
 */
export function coverLanguages(coverId) {
  return BLOG_COVER_LOCALES[coverId] || [];
}

/**
 * Rewrite every cover URL in `html` to this language's variant, where one exists.
 *
 * @param {string} html
 * @param {string} lang  languages/<lang>.json basename; '' or 'english' is a no-op
 * @returns {string}
 */
export function localizeCoverUrls(html, lang) {
  if (!lang || lang === 'english') return html;
  return String(html).replace(COVER_URL, (whole, n, suffix) => {
    const coverId = `cover-${n}`;
    if (!coverLanguages(coverId).includes(lang)) return whole;
    // `cover-12.spanish.webp`, `cover-12.spanish-og.jpg` — the language goes before the
    // size suffix so every variant of one cover sorts together in the directory.
    return `${coverId}.${lang}${suffix}`;
  });
}
