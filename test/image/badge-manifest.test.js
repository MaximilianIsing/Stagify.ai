// Drift guard for the committed badge masters (lib/image/badges/).
//
// The badge sentences live in code (STAGING_DISCLOSURE_BADGE) but reach the user as PIXELS
// rendered offline by scripts/build-disclosure-badges.js. Nothing at runtime reads the
// string — so editing the wording without re-running the generator would leave the code
// saying one thing while every stamped photo keeps saying the old thing, indefinitely and
// invisibly. That is the exact failure mode this feature exists to prevent, so it is worth
// a hard gate rather than a comment.
//
// If this test fails: run `node scripts/build-disclosure-badges.js` and commit the result.
// See to-build/disclosure-badges/README.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { STAGING_DISCLOSURE_BADGE, STAGING_DISCLOSURE, disclosureBadgeText } from '../../lib/staging/staging-disclosure.js';
import { ALL_LOCALES } from '../../lib/i18n/locales.js';

const BADGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'image', 'badges');
const manifest = JSON.parse(fs.readFileSync(path.join(BADGE_DIR, 'manifest.json'), 'utf8'));

const REBUILD = 'run `node scripts/build-disclosure-badges.js` and commit the result';

test('badge masters match the strings they are supposed to depict', async () => {
  for (const [lang, text] of Object.entries(STAGING_DISCLOSURE_BADGE)) {
    const entry = manifest.entries[lang];
    assert.ok(entry, `${lang}: no master in manifest.json — ${REBUILD}`);
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    assert.equal(
      entry.sha256,
      sha,
      `${lang}: the badge string changed but the PNG was not regenerated — the pixels still say `
        + `"${entry.text}" while the code says "${text}". ${REBUILD}`,
    );
    assert.equal(entry.text, text, `${lang}: manifest text is out of date — ${REBUILD}`);
  }
});

test('every language the app can be used in has a master, and there are no orphans', async () => {
  // Adding a locale to lib/i18n/locales.js without a badge string would silently stamp
  // English onto that locale's renders, which is the one place the disclosure fails to
  // disclose. Catch it here rather than in production.
  for (const locale of ALL_LOCALES) {
    assert.ok(
      STAGING_DISCLOSURE_BADGE[locale.lang],
      `locale "${locale.lang}" has no entry in STAGING_DISCLOSURE_BADGE — add the sentence, then ${REBUILD}`,
    );
  }
  const onDisk = fs.readdirSync(BADGE_DIR).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')).sort();
  assert.deepEqual(
    onDisk,
    Object.keys(STAGING_DISCLOSURE_BADGE).sort(),
    `the PNGs on disk do not match the string set — ${REBUILD}`,
  );
});

test('each master PNG decodes and matches its recorded dimensions', async () => {
  for (const [lang, entry] of Object.entries(manifest.entries)) {
    const meta = await sharp(path.join(BADGE_DIR, entry.file)).metadata();
    assert.equal(meta.width, entry.width, `${lang}: width drift — ${REBUILD}`);
    assert.equal(meta.height, entry.height, `${lang}: height drift — ${REBUILD}`);
    assert.ok(meta.hasAlpha, `${lang}: master must carry alpha or it would composite as a white box`);
  }
});

test('all masters share one height, so type size does not depend on the translation', async () => {
  // Cropping each master to its own ink would make the height depend on whether that
  // language's tag happens to contain a descender: "Virtuell möbliert" has none while
  // "Virtually staged" has y and g, so at the same nominal size German would render
  // visibly larger. The stamp scales by height, so one height for all of them is what
  // keeps the optical size equal. Centring INSIDE that height is the next test.
  const heights = new Set(Object.values(manifest.entries).map((e) => e.height));
  assert.equal(heights.size, 1, `masters must all share one height, saw ${[...heights].join(', ')} — ${REBUILD}`);
  assert.equal([...heights][0], manifest.bandHeight, 'the shared height is the manifest band height');
});

test('each master is vertically centred in that shared height', async () => {
  // The visual half of the rule above. A fixed height can be filled two ways: paste every
  // language at one shared band offset, or centre each one on its own ink. Both keep the
  // masters the same height, so the test above passes either way — but the first leaves a
  // language with no descender ("Virtuell möbliert", "虚拟布置") sitting high with dead
  // space beneath it, which on the photo reads as a badge whose text has slipped upwards.
  // Nothing else would catch that: it is not an error, just a lopsided pill in some
  // languages and not others.
  for (const [lang, entry] of Object.entries(manifest.entries)) {
    const { data, info } = await sharp(path.join(BADGE_DIR, entry.file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let inkTop = -1;
    let inkBottom = -1;
    for (let y = 0; y < info.height; y++) {
      let row = false;
      for (let x = 0; x < info.width && !row; x++) row = data[(y * info.width + x) * 4 + 3] > 0;
      if (!row) continue;
      if (inkTop < 0) inkTop = y;
      inkBottom = y;
    }
    assert.ok(inkTop >= 0, `${lang}: master is entirely transparent — ${REBUILD}`);

    const above = inkTop;
    const below = info.height - 1 - inkBottom;
    // 1px of slack for the odd/even rounding when the ink height and the band height do
    // not share a parity; anything beyond that is a real offset.
    assert.ok(
      Math.abs(above - below) <= 1,
      `${lang}: ink sits ${above}px from the top and ${below}px from the bottom — the master is `
        + `not centred, so the pill's text will look off-centre. ${REBUILD}`,
    );
    assert.ok(above >= 1, `${lang}: ink touches the master's top edge, so antialiasing is clipped — ${REBUILD}`);
  }
});

test('the badge is a short tag, not the long-form share-page disclosure', async () => {
  // The two strings have different jobs (see the header of lib/staging/staging-disclosure.js).
  // Pasting the ~200-char paragraph in here would produce a stamp nobody can read, which
  // discloses nothing.
  //
  // The 32-char cap is tighter than "must fit": at 2% of the long edge, a full sentence
  // still technically fits — the badge started life as one — it just turns the corner of
  // every listing photo into a caption bar, and drives the fit guard in stamp-disclosure.js
  // to shrink the type on portrait renders until the disclosure is the least readable thing
  // in the frame. The elliptical tag form ("Virtually staged") is the decision; this pins it.
  for (const [lang, text] of Object.entries(STAGING_DISCLOSURE_BADGE)) {
    assert.notEqual(text, STAGING_DISCLOSURE, `${lang}: the badge must not be the long-form disclosure`);
    assert.ok(text.length <= 32, `${lang}: badge is ${text.length} chars; it is a corner tag, not a sentence`);
    assert.ok(!/\r|\n/.test(text), `${lang}: badge must be a single line`);
  }
});

test('disclosureBadgeText resolves languages and falls back to English', async () => {
  assert.equal(disclosureBadgeText('german'), STAGING_DISCLOSURE_BADGE.german);
  assert.equal(disclosureBadgeText('GERMAN'), STAGING_DISCLOSURE_BADGE.german, 'case-insensitive');
  assert.equal(disclosureBadgeText('klingon'), STAGING_DISCLOSURE_BADGE.english, 'unknown → English');
  assert.equal(disclosureBadgeText(undefined), STAGING_DISCLOSURE_BADGE.english, 'missing → English');
  assert.equal(disclosureBadgeText(''), STAGING_DISCLOSURE_BADGE.english, 'empty → English');
});
