#!/usr/bin/env node
// One-off import of posts that were made by hand, before this tool existed.
//
//   1. Drop every existing post image into instagram/history/backfill/
//   2. node instagram/bin/seed-history.js --scan     writes a manifest with blanks to fill
//   3. An agent looks at each image and fills the blanks (this is the vision pass)
//   4. node instagram/bin/seed-history.js --commit   writes the records and the thumbs
//
// The split is deliberate. Node can enumerate files and compute hashes; only something with
// eyes can say what a post displays. Steps 2 and 4 are mechanical, step 3 is not.
//
// Why it matters: with an empty ledger the tool cheerfully rebuilds a post from two months
// ago and is pleased with itself. The backfill is what makes the uniqueness rule mean
// anything on day one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readPosts, appendPost, refreshLedger, loadConfig } from '../lib/history/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKFILL_DIR = path.join(REPO_ROOT, 'instagram', 'history', 'backfill');
const MANIFEST = path.join(BACKFILL_DIR, 'manifest.json');
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

const { values } = parseArgs({
  options: {
    scan: { type: 'boolean', default: false },
    commit: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    year: { type: 'string' },
  },
});

/**
 * Pull a date out of a filename.
 *
 * A full YYYY-MM-DD is taken as written. A bare MM-DD (which is how these were named) has
 * no year, so infer the most recent one that is not in the future: 08-11 seen on 2026-08-13
 * is this year, but 12-20 seen in January belongs to last year. --year overrides.
 */
function dateFromFilename(file, today, forcedYear) {
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(file);
  if (full) return full[0];

  const short = /(?:^|\D)(\d{2})-(\d{2})(?!\d)/.exec(file);
  if (!short) return null;

  const [, month, day] = short;
  const year = forcedYear
    ? Number(forcedYear)
    : (`${today.getFullYear()}-${month}-${day}` > today.toISOString().slice(0, 10)
        ? today.getFullYear() - 1
        : today.getFullYear());
  return `${year}-${month}-${day}`;
}

const config = loadConfig(REPO_ROOT);

function slugify(text, fallback, max = 48) {
  const full = String(text ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (full.length <= max) return full || fallback;
  // Cut at the last word boundary inside the limit so an id never ends mid-word.
  const cut = full.slice(0, max);
  const slug = cut.slice(0, cut.lastIndexOf('-') > 12 ? cut.lastIndexOf('-') : max);
  return slug || fallback;
}

if (values.scan) {
  if (!fs.existsSync(BACKFILL_DIR)) {
    fs.mkdirSync(BACKFILL_DIR, { recursive: true });
  }

  const files = fs.readdirSync(BACKFILL_DIR).filter((f) => IMAGE_RE.test(f)).sort();
  if (!files.length) {
    console.log(`No images in ${path.relative(REPO_ROOT, BACKFILL_DIR)}.`);
    console.log('Drop your existing post images there, then rerun with --scan.');
    console.log('Name them so the order is recoverable, for example 01-2026-07-25.png.');
    process.exit(0);
  }

  const existing = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : [];
  const byFile = new Map(existing.map((e) => [e.file, e]));

  const entries = await Promise.all(files.map(async (file) => {
    if (byFile.has(file)) return byFile.get(file); // never clobber work already done

    const buffer = fs.readFileSync(path.join(BACKFILL_DIR, file));
    const meta = await sharp(buffer).metadata();

    return {
      file,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      width: meta.width,
      height: meta.height,
      date: dateFromFilename(file, new Date(), values.year),

      // Everything below is for the vision pass to fill in. Leave a value as null and
      // --commit will tell you exactly which field on which file is still blank.
      topic: null,
      headline: null,
      visualSummary: null,
      dominantColors: [],
      template: null,
      featureShown: null,
      hookArchetype: null,
      audience: null,
      roomType: null,
      style: null,
      palette: null,
      ctaStyle: null,
    };
  }));

  fs.writeFileSync(MANIFEST, `${JSON.stringify(entries, null, 2)}\n`);

  const blank = entries.filter((e) => !e.visualSummary).length;
  console.log(`Manifest: ${path.relative(REPO_ROOT, MANIFEST)}`);
  console.log(`  ${entries.length} image(s), ${blank} still need the vision pass.`);
  console.log('\nNow: read each image and fill in every null field. Allowed values are in');
  console.log('instagram/config.json. Use template ids from instagram/templates/, or');
  console.log('"legacy-<something>" for a layout this tool does not have yet.');
  process.exit(0);
}

if (!values.commit) {
  console.error('Pass --scan to build the manifest, or --commit to import it.');
  process.exit(1);
}

if (!fs.existsSync(MANIFEST)) {
  console.error(`No manifest. Run --scan first.`);
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const required = ['topic', 'visualSummary', 'template', 'featureShown', 'hookArchetype',
  'audience', 'roomType', 'style', 'palette', 'ctaStyle'];

const incomplete = entries
  .map((e) => ({ file: e.file, missing: required.filter((k) => e[k] == null || e[k] === '') }))
  .filter((e) => e.missing.length);

if (incomplete.length && !values.force) {
  console.error('The vision pass is not finished:\n');
  for (const { file, missing } of incomplete) console.error(`  ${file}: ${missing.join(', ')}`);
  console.error('\nFill those in, or pass --force to import the rest and come back to these.');
  process.exit(1);
}

const already = new Set(readPosts(REPO_ROOT).map((p) => p.id));
let imported = 0;

for (const [index, entry] of entries.entries()) {
  if (incomplete.some((i) => i.file === entry.file)) continue;

  const seq = String(index + 1).padStart(2, '0');
  const id = `legacy-${seq}-${slugify(entry.topic, entry.file.replace(IMAGE_RE, ''))}`;
  if (already.has(id)) continue;

  const dir = path.join(REPO_ROOT, 'instagram', 'posts', id);
  fs.mkdirSync(dir, { recursive: true });
  await sharp(path.join(BACKFILL_DIR, entry.file))
    .resize({ width: config.render.thumbWidth })
    .jpeg({ quality: 82 })
    .toFile(path.join(dir, 'thumb.jpg'));

  appendPost(REPO_ROOT, {
    id,
    date: entry.date,
    publishedAt: entry.date ? `${entry.date}T12:00:00.000Z` : null,
    origin: 'backfill',
    backfilled: true,
    formats: ['single'],
    template: entry.template,
    featureShown: entry.featureShown,
    hookArchetype: entry.hookArchetype,
    audience: entry.audience,
    roomType: entry.roomType,
    style: entry.style,
    palette: entry.palette,
    ctaStyle: entry.ctaStyle,
    topic: entry.topic,
    visualSummary: entry.visualSummary,
    dominantColors: entry.dominantColors ?? [],
    hashtagSet: [],
    // Not recoverable from an image. The uniqueness check does not need it: topic and
    // visualSummary carry the signal. Paste one in later if you have it.
    copy: { headline: entry.headline ?? null, caption: null },
    images: [{
      role: 'composite', source: 'hand-made', sha256: entry.sha256,
      width: entry.width, height: entry.height,
      license: { type: 'owned', licenseName: 'Stagify original', attributionRequired: false },
    }],
    review: { verdict: 'not-reviewed', note: 'Predates this tool.' },
  });

  imported += 1;
  console.log(`  imported ${id}`);
}

refreshLedger(REPO_ROOT);
console.log(`\nImported ${imported} post(s). History now has ${readPosts(REPO_ROOT).length}.`);
console.log('Check what this blocked with: node instagram/bin/check.js --available');
