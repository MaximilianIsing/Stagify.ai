// Tier: unit (pure) — lib/staging/staging-disclosure.js.
//
// WHY A DEDICATED FILE FOR ONE SENTENCE
// The disclosure is the difference between output a licensed agent can put on an MLS and
// output they cannot. It has to reach the customer on BOTH paths bytes leave the app (the
// client share page and the render archive) and it has to be the SAME sentence on both,
// because the one that drifts will be the copy in the zip nobody re-reads.
//
// So the tests here are deliberately about DRIFT and SUBSTANCE rather than wording:
//   * the two surfaces resolve to these exported constants, not to a lookalike string;
//   * the sentence still says the three things that make it a disclosure at all (that the
//     images are altered, that the furniture is not included, and that the room itself is
//     not) — asserted by claim, so a rewrite for tone stays legal but a rewrite that drops
//     "not included in the sale" fails;
//   * the archive file survives the inputs that actually turn up: an empty listing, a
//     listing whose title is 400 characters of a paste, and a nonsense timestamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGING_DISCLOSURE,
  STAGING_DISCLOSURE_ARCHIVE,
  DISCLOSURE_ENTRY_NAME,
  buildDisclosureFile,
} from '../../lib/staging/staging-disclosure.js';

const T0 = Date.UTC(2026, 6, 30, 15, 30);

test('both disclosures make the three claims that make them disclosures', () => {
  for (const [label, text] of [['page', STAGING_DISCLOSURE], ['archive', STAGING_DISCLOSURE_ARCHIVE]]) {
    assert.match(text, /virtually staged/i, `${label}: must say the images are staged`);
    assert.match(text, /not included in the sale/i,
      `${label}: the furniture-is-not-included claim is the one a buyer disputes`);
    assert.match(text, /unaltered/i,
      `${label}: saying what was NOT changed is what protects the agent from a misrepresentation claim`);
    // Named specifics, not just "the images were edited" — an agent has to be able to
    // point at which elements are renderings.
    assert.match(text, /furniture/i, `${label}: name the furnishings`);
    assert.ok(text.trim().endsWith('.'), `${label}: it is prose an agent pastes into remarks`);
  }
});

test('the page and archive wordings differ only in how they refer to the images', () => {
  // They are two constants precisely so "Photos on this page" does not end up in a file on
  // someone's desktop — but they must not diverge in SUBSTANCE.
  assert.notEqual(STAGING_DISCLOSURE, STAGING_DISCLOSURE_ARCHIVE);
  assert.match(STAGING_DISCLOSURE, /on this page/i);
  assert.match(STAGING_DISCLOSURE_ARCHIVE, /in this folder/i);
  const substance = (/** @type {string} */ s) => s.slice(s.indexOf('. ') + 2);
  assert.equal(substance(STAGING_DISCLOSURE), substance(STAGING_DISCLOSURE_ARCHIVE),
    'everything after the lead-in must be identical, or the two copies have drifted');
});

test('the disclosure is short enough to paste into an MLS remarks field', () => {
  // Remarks fields are commonly capped around 1 000 characters and the agent needs room
  // for their own copy. A disclosure nobody can fit is a disclosure nobody uses.
  assert.ok(STAGING_DISCLOSURE.length < 400, `too long at ${STAGING_DISCLOSURE.length} characters`);
});

test('the archive file names its listing and carries the canonical sentence', () => {
  const text = buildDisclosureFile({ title: '12 Oak Avenue', address: '12 Oak Ave, Denver CO', generatedAt: T0 });
  assert.ok(text.includes(STAGING_DISCLOSURE_ARCHIVE), 'the sentence must not be re-typed here');
  assert.ok(text.includes('Listing: 12 Oak Avenue'));
  assert.ok(text.includes('Address: 12 Oak Ave, Denver CO'));
  assert.ok(text.includes('Staged: 2026-07-30'), 'date only — a timestamp invites "whose timezone?"');
  assert.ok(text.includes('Stagify.ai'));
  assert.ok(text.slice(1).startsWith('VIRTUAL STAGING DISCLOSURE'),
    'the heading is the first thing in the file, after the BOM');
  assert.ok(text.includes('\r\n'), 'CRLF so it opens correctly in Notepad');
});

test('an untitled listing still produces a usable disclosure', () => {
  const text = buildDisclosureFile({ generatedAt: T0 });
  assert.ok(text.includes(STAGING_DISCLOSURE_ARCHIVE));
  assert.equal(text.includes('Listing:'), false, 'an empty label is worse than no label');
  assert.equal(text.includes('Address:'), false);
  assert.ok(text.includes('Staged: 2026-07-30'));
});

test('operator strings are flattened and bounded rather than trusted', () => {
  const text = buildDisclosureFile({
    title: `Flat 3\r\n${'x'.repeat(400)}`,
    address: `Line one\nLine two${'y'.repeat(400)}`,
    generatedAt: T0,
  });
  const listing = text.split('\r\n').find((l) => l.startsWith('Listing: ')) || '';
  const address = text.split('\r\n').find((l) => l.startsWith('Address: ')) || '';
  assert.ok(listing.length <= 'Listing: '.length + 200, 'the title is bounded');
  assert.ok(address.length <= 'Address: '.length + 300);
  assert.ok(listing.startsWith('Listing: Flat 3 x'), 'embedded newlines collapse to spaces, keeping one line one line');
  assert.equal(address.includes('\n'), false);
});

test('a nonsense generatedAt degrades to now rather than to Invalid Date', () => {
  for (const bad of [undefined, null, NaN, Infinity, 'yesterday', {}]) {
    const text = buildDisclosureFile({ title: 'x', generatedAt: /** @type {any} */ (bad) });
    assert.match(text, /Staged: \d{4}-\d{2}-\d{2}/, `generatedAt=${String(bad)} produced a broken date`);
    assert.equal(text.includes('Invalid'), false);
  }
});

test('the archive entry name is a plain, sortable-to-the-top filename', () => {
  // It is interpolated into a zip entry name, so it must not need slugifying — and it is
  // upper-case so it sits above the images in an alphabetical file listing.
  assert.equal(DISCLOSURE_ENTRY_NAME, 'DISCLOSURE.txt');
  assert.match(DISCLOSURE_ENTRY_NAME, /^[A-Za-z0-9_.-]+$/, 'no slashes, no dots-dots, no spaces');
});

test('the archive file leads with a UTF-8 BOM, or Windows renders the legal sentence as mojibake', () => {
  // Found by DOWNLOADING a real archive and opening it, not by a test. The sentence carries
  // "décor" and an em dash; a .txt with no BOM is ambiguous, so a tool falling back to the
  // ANSI codepage shows "décor" and "â€”" — in the one document whose whole job is to be
  // read by a human and pasted into an MLS remarks field.
  const text = buildDisclosureFile({ title: 'x', generatedAt: T0 });
  assert.equal(text.charCodeAt(0), 0xfeff, 'the BOM must be the very first character');
  assert.equal(text.slice(1).startsWith('VIRTUAL STAGING DISCLOSURE'), true);

  // The bytes a consumer actually receives: valid UTF-8, BOM first.
  const bytes = Buffer.from(text, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(bytes.includes(Buffer.from('décor', 'utf8')), 'and the accented word survives');
});

test('the BOM is on the FILE only — the page\'s copy is untouched', () => {
  // HTML declares its encoding, so the share page needs no help; a stray U+FEFF rendered
  // into a paragraph would be a zero-width character in the middle of the disclosure.
  assert.equal(STAGING_DISCLOSURE.charCodeAt(0), 'P'.charCodeAt(0));
  assert.equal(STAGING_DISCLOSURE.includes('\uFEFF'), false);
  assert.equal(STAGING_DISCLOSURE_ARCHIVE.includes('\uFEFF'), false);
});
