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
  // language's sentence happens to contain a descender: German ("Dieses Bild wurde virtuell
  // möbliert") has none and measured 103px against English's 133, which rendered German ~29%
  // larger at the same nominal size. The generator crops to a shared vertical band instead.
  const heights = new Set(Object.values(manifest.entries).map((e) => e.height));
  assert.equal(heights.size, 1, `masters must all share one height, saw ${[...heights].join(', ')} — ${REBUILD}`);
  assert.equal([...heights][0], manifest.bandHeight, 'the shared height is the manifest band height');
});

test('the badge is short, and is not the long-form share-page disclosure', async () => {
  // The two strings have different jobs (see the header of lib/staging/staging-disclosure.js).
  // Pasting the ~200-char paragraph in here would produce a stamp nobody can read, which
  // discloses nothing.
  for (const [lang, text] of Object.entries(STAGING_DISCLOSURE_BADGE)) {
    assert.notEqual(text, STAGING_DISCLOSURE, `${lang}: the badge must not be the long-form disclosure`);
    assert.ok(text.length <= 60, `${lang}: badge is ${text.length} chars; keep it to one short line`);
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
