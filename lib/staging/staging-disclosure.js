// The virtual-staging disclosure — one sentence that decides whether this feature is
// usable by a licensed agent at all.
//
// WHY IT IS A MODULE AND NOT A STRING IN A TEMPLATE
// Publishing a staged photo of a real property without saying it is staged is not a
// style question. NAR's Code of Ethics (Article 12) requires a true picture in
// advertising, most MLSs carry an explicit virtual-staging disclosure rule, and several
// states treat an undisclosed altered listing photo as a misrepresentation the LISTING
// AGENT is on the hook for. An agent who forwards our output to a portal and gets cited
// does not blame themselves; they stop using the tool.
//
// So the disclosure ships WITH the pixels rather than living in the owner's UI where the
// buyer never sees it: routes/share-public.js puts it in the manifest and the share page
// renders it under the image. One definition, so there is nothing to drift.
//
// Adapted from lib/staging/staging-disclosure.js on origin/experimental/listing-studio.
// That version also exported an archive variant (`STAGING_DISCLOSURE_ARCHIVE`,
// `DISCLOSURE_ENTRY_NAME`, `UTF8_BOM`, `buildDisclosureFile`) for a bulk-download zip
// that does not exist here. Those are deliberately NOT carried over — an exported
// constant with no caller reads as a supported surface and invites somebody to build
// against it. Restore them from the branch if an archive ever ships.
//
// NOT LEGAL ADVICE, and the wording is deliberately conservative rather than clever: it
// names the alteration, scopes it to furnishings, and says what was NOT changed, because
// the failure mode agents actually fear is a buyer claiming the ROOM was misrepresented.
//
// TWO STRINGS, TWO JOBS — do not merge them.
//   STAGING_DISCLOSURE       = the SUBSTANCE. Long-form, for the share page footer and for
//                              pasting into an MLS remarks field. ~200 chars.
//   STAGING_DISCLOSURE_BADGE = the IDENTIFICATION. A two-word tag burned into the
//                              bottom-right of the pixels when the user ticks "Label as
//                              virtually staged". It is physically impossible to render
//                              the long form as a corner stamp, and a stamp nobody can
//                              read discloses nothing.
// The badge is localized (the share-page disclosure is not) because it is burned into the
// image a non-English user hands to a non-English buyer, so English there would be the one
// place the disclosure fails to disclose.
//
// The badge lives HERE and NOT in public/languages/*.json on purpose: the browser never
// renders this string — it is baked into pixels server-side — and a legally-consequential
// wording belongs in one reviewable server file rather than in the eleven files that get
// bulk-edited whenever a translation pass runs.
//
// CHANGING ANY BADGE STRING REQUIRES REGENERATING THE PNG MASTERS:
//   node scripts/build-disclosure-badges.js
// test/image/badge-manifest.test.js hashes these strings against the committed masters and
// fails the build if you skip it — otherwise the pixels would keep saying the old thing.

/**
 * The substance of the disclosure — what is a rendering, what is not for sale, and what
 * was NOT altered.
 */
const DISCLOSURE_BODY = 'Furniture, rugs, art and décor shown are digital renderings for illustration only '
  + 'and are not included in the sale; the structure, dimensions, windows, flooring and fixtures of each room are unaltered.';

/**
 * The disclosure as the client share page states it. Plain English, no branding — an
 * agent must be able to paste it into an MLS remarks field that counts characters.
 */
export const STAGING_DISCLOSURE = `Photos on this page have been virtually staged. ${DISCLOSURE_BODY}`;

/**
 * The short disclosure burned into the image itself, per UI language. Keys are the `lang`
 * names from lib/i18n/locales.js (which are also the public/languages/<lang>.json
 * basenames), so the browser can send its stored `selectedLanguage` straight through.
 *
 * A TAG, NOT A SENTENCE. Each of these is the elliptical caption form — "Virtually staged",
 * not "This image has been virtually staged" — because the stamp sits ON the thing it is
 * describing, so naming the subject only makes the pill wider. And width is the whole
 * problem: the badge has to stay legible at ~2% of the image's long edge without turning
 * into a caption bar across the bottom of a listing photo. The two-word form is also what
 * MLS guidance and portal captions actually use, so it reads as a professional disclosure
 * rather than as our own watermark.
 *
 * The Romance participles are feminine because the elided subject is the image (la imagen,
 * l'image, l'immagine, a imagem — feminine in all four); Russian is neuter for изображение.
 * @type {Record<string, string>}
 */
export const STAGING_DISCLOSURE_BADGE = {
  english: 'Virtually staged',
  spanish: 'Amueblada virtualmente',
  french: 'Meublée virtuellement',
  german: 'Virtuell möbliert',
  dutch: 'Virtueel ingericht',
  italian: 'Arredata virtualmente',
  portuguese: 'Mobiliada virtualmente',
  russian: 'Виртуально меблировано',
  chinese: '虚拟布置',
  japanese: 'バーチャルステージング',
  korean: '가상 스테이징',
};

/**
 * The badge sentence for a language, falling back to English for anything unrecognized.
 *
 * Falls back rather than throwing because the language arrives from the browser: an
 * unknown value is a stale localStorage entry or a hand-rolled API call, and neither is a
 * reason to fail a paid render. An English stamp still discloses; no stamp would not.
 * @param {string} [lang] - A `lang` name from lib/i18n/locales.js, e.g. 'german'.
 * @returns {string} The localized badge sentence, or the English one.
 */
export function disclosureBadgeText(lang) {
  return STAGING_DISCLOSURE_BADGE[String(lang || '').toLowerCase()] || STAGING_DISCLOSURE_BADGE.english;
}
