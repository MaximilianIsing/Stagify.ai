// Drift guard: ONE upload ceiling, stated the same everywhere.
//
// WHY THIS EXISTS
// There were three different numbers for "how big a photo may be", and the one the
// user was shown was never the one that applied:
//
//   lib/http/uploads.js        25 MB  ← multer, the only thing that actually refuses
//   public/scripts/…/image-file.js  100 MB  ← with a comment claiming it matched
//   guides.html                10 MB
//
// So a 30 MB photo passed the browser check, uploaded in full over a phone
// connection, was refused by the server, and the user was told to "upload an image
// smaller than 100MB" — about a file the page had just accepted. The client cannot
// import from lib/, so the value is mirrored; this is what stops the mirror rotting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_UPLOAD_BYTES } from '../../lib/http/uploads.js';
import { MAX_IMAGE_BYTES, MAX_IMAGE_MB, fileRejection } from '../../public/scripts/app/image-file.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the browser refuses at exactly the size the server refuses at', () => {
  assert.equal(
    MAX_IMAGE_BYTES,
    MAX_UPLOAD_BYTES,
    'public/scripts/app/image-file.js mirrors lib/http/uploads.js — update both',
  );
});

test('the multer config uses the exported constant, not its own literal', () => {
  // Exporting the number is pointless if the limit that enforces it is a separate
  // literal that can drift from it.
  const src = read('lib/http/uploads.js');
  assert.match(
    src,
    /stagingProcessUpload[\s\S]*?fileSize:\s*MAX_UPLOAD_BYTES/,
    'the staging upload limit must read MAX_UPLOAD_BYTES',
  );
});

test('MAX_IMAGE_MB is the megabyte form of the same number', () => {
  assert.equal(MAX_IMAGE_MB * 1024 * 1024, MAX_IMAGE_BYTES);
});

test('the gate accepts a file at the limit and refuses one past it', () => {
  assert.equal(fileRejection('image/jpeg', MAX_IMAGE_BYTES), null, 'exactly at the cap is fine');
  assert.equal(fileRejection('image/jpeg', MAX_IMAGE_BYTES + 1), 'fileTooLarge');
});

/**
 * Every translated string that states the ceiling out loud.
 *
 * One entry per copy site, because each one is a fresh place for the number to
 * rot — the whole reason this file exists. `modal.staging.uploadFormats` is the
 * staging dropzone's sub-line, which tells people the limit BEFORE they pick a
 * file rather than after a rejected upload.
 */
const CEILING_COPY_KEYS = ['errors.fileTooLarge', 'modal.staging.uploadFormats'];

/** @param {any} obj @param {string} dotted */
const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

test('every language pack quotes the real ceiling wherever it states one', () => {
  const dir = path.join(ROOT, 'public', 'languages');
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(packs.length >= 11, `expected 11 language packs, found ${packs.length}`);

  for (const name of packs) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const key of CEILING_COPY_KEYS) {
      const msg = dig(json, key);
      assert.equal(typeof msg, 'string', `${name} is missing ${key}`);
      assert.ok(
        msg.includes(String(MAX_IMAGE_MB)),
        `${name} ${key} says "${msg}" but the real ceiling is ${MAX_IMAGE_MB} MB`,
      );
    }
  }
});

/**
 * Drop comments before scanning.
 *
 * Without this the guard reads the very comments that EXPLAIN the old limits — this
 * file's own history notes name "100 MB" — and fails on a correct tree. The rule is
 * general: a source-scan guard must look at shipped code, never at prose about it.
 * @param {string} src - File contents.
 * @param {boolean} isHtml - Strip `<!-- -->` as well as JS comments.
 */
function stripComments(src, isHtml) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  if (isHtml) out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  return out;
}

test('no shipped file still quotes one of the old, wrong ceilings', () => {
  // The literal 100MB/10MB figures were spread across three files and eleven packs;
  // a partial revert is the realistic regression, so sweep for the old numbers
  // wherever a user could read them.
  const surfaces = [
    'public/scripts/app/image-file.js',
    'public/scripts/app/staging-pipeline.js',
    'public/scripts/masking-studio/upload.js',
    'public/guides.html',
  ];
  for (const rel of surfaces) {
    const src = stripComments(read(rel), rel.endsWith('.html'));
    assert.doesNotMatch(src, /\b100\s?MB\b/i, `${rel} still quotes the old 100 MB ceiling`);
    assert.doesNotMatch(src, /under 10 MB/i, `${rel} still quotes the old 10 MB ceiling`);
  }
});
