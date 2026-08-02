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
