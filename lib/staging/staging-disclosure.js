// The virtual-staging disclosure — one sentence that decides whether this feature is
// usable by a licensed agent at all.
//
// WHY IT IS A MODULE AND NOT A STRING IN A TEMPLATE
// Publishing a staged photo of a real property without saying it is staged is not a
// style question. NAR's Code of Ethics (Article 12) requires a true picture in
// advertising, most MLSs carry an explicit virtual-staging disclosure rule, and several
// states treat an undisclosed altered listing photo as a misrepresentation the LISTING
// AGENT is on the hook for. A broker who forwards our output to a portal and gets cited
// does not blame themselves; they stop using the tool.
//
// So the disclosure ships WITH the pixels, from one definition, on every path bytes can
// leave the app:
//   * the client share page renders it under the gallery (routes/share-public.js);
//   * the bulk archive carries DISCLOSURE.txt as its first entry, so the folder a broker
//     hands to their photographer or uploads to the MLS is self-describing
//     (routes/projects-download.js).
// Two copies of this sentence would drift, and the drifted copy would be the one in the
// zip nobody re-reads — which is why `test/staging/staging-disclosure.test.js` asserts
// both surfaces resolve to THIS constant rather than to a string that merely looks like it.
//
// NOT LEGAL ADVICE, and the wording is deliberately conservative rather than clever: it
// names the alteration, scopes it to furnishings, and says what was NOT changed, because
// the failure mode agents actually fear is a buyer claiming the ROOM was misrepresented.

/**
 * The substance of the disclosure — what is a rendering, what is not for sale, and what
 * was NOT altered. The two exported variants below differ ONLY in the sentence that
 * points at the images, and they are built from this constant rather than each spelling
 * it out, so the two copies cannot drift apart no matter who edits which one. That is the
 * whole reason this is a separate binding.
 */
const DISCLOSURE_BODY = 'Furniture, rugs, art and décor shown are digital renderings for illustration only '
  + 'and are not included in the sale; the structure, dimensions, windows, flooring and fixtures of each room are unaltered.';

/**
 * The disclosure as the client share page states it. Plain English, no branding — a
 * broker must be able to paste it into an MLS remarks field that counts characters.
 */
export const STAGING_DISCLOSURE = `Photos on this page have been virtually staged. ${DISCLOSURE_BODY}`;

/**
 * The archive variant. "Photos on this page" is wrong once the images are files on
 * someone's desktop, so the lead-in changes and nothing else does.
 */
export const STAGING_DISCLOSURE_ARCHIVE = `The photos in this folder have been virtually staged. ${DISCLOSURE_BODY}`;

/** The entry name the disclosure takes inside the render archive. */
export const DISCLOSURE_ENTRY_NAME = 'DISCLOSURE.txt';

/**
 * Byte-order mark, prepended to the archive's text file.
 *
 * The sentence contains "décor" and an em dash. The file IS UTF-8, but a `.txt` with no BOM
 * is AMBIGUOUS on Windows: a tool that falls back to the ANSI codepage renders those as
 * "décor" and "â€”". That is mojibake in the one document whose entire job is to be read by
 * a human and pasted into an MLS remarks field — the document that protects the listing
 * agent. Found by downloading a real archive and opening it, not by a test.
 *
 * A BOM is the standard remedy and is what Notepad itself writes; Notepad, Excel and the
 * Windows shell all detect it. It sits before the HEADING, several lines above the
 * paste-worthy sentence, so it cannot end up inside anything an agent copies out of the
 * middle of the file. The PAGE's copy is deliberately untouched — HTML declares its encoding
 * and needs no help, and a stray U+FEFF in a paragraph would be a zero-width character
 * sitting in the disclosure itself.
 */
export const UTF8_BOM = '\uFEFF';

/**
 * Build the DISCLOSURE.txt that rides along in a listing's archive.
 *
 * The listing's own title/address are echoed back so the file is still meaningful after
 * it has been copied out of the folder it shipped in — a disclosure that does not name
 * what it discloses about is a disclosure nobody can act on. Both are caller-supplied
 * strings that end up in a text file (never a path or a header), so they are trimmed and
 * bounded rather than slugified; a newline inside one would only make the file untidy.
 *
 * @param {{ title?: string, address?: string, generatedAt?: number }} [listing] - What the archive is of.
 * @returns {string} The file's contents, CRLF-terminated so it opens correctly in Notepad.
 */
export function buildDisclosureFile(listing = {}) {
  const title = String(listing.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const address = String(listing.address ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const when = new Date(typeof listing.generatedAt === 'number' && Number.isFinite(listing.generatedAt)
    ? listing.generatedAt
    : Date.now());
  const lines = [
    'VIRTUAL STAGING DISCLOSURE',
    '',
    STAGING_DISCLOSURE_ARCHIVE,
    '',
  ];
  if (title) lines.push(`Listing: ${title}`);
  if (address) lines.push(`Address: ${address}`);
  // ISO date only, no time: the useful fact is which day the renders are from, and a
  // timestamp with a timezone invites the question of whose timezone it is.
  lines.push(`Staged: ${when.toISOString().slice(0, 10)}`);
  lines.push('Produced with Stagify.ai');
  lines.push('');
  lines.push('Keep this file with the images. Most MLSs require the disclosure to appear');
  lines.push('in the listing remarks or on each altered photo — check your local rules.');
  lines.push('');
  return `${UTF8_BOM}${lines.join('\r\n')}`;
}
