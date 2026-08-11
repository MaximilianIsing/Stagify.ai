/**
 * The re-stage pool: every pre-generated staging of the one empty room shown in the
 * home page's #restage section.
 *
 * WHY A LIST AND NOT A DIRECTORY READ: the browser cannot list a directory, and fetching
 * a manifest would put a network round-trip on the critical path for a section most
 * visitors never interact with. The list is therefore checked in — and
 * test/frontend/home-restage.test.js fails if it ever disagrees with the files actually
 * on disk, so adding or deleting a render without editing this file blocks the deploy.
 *
 * WHY THE NAMES CARRY NO STYLE: each render was produced from a promptMatrix style PLUS a
 * palette/layout/material directive, and generatePrompt appends that directive after
 * "Prioritize the following above everything else:", so the directive routinely overrides
 * the style. A render generated as 'luxury' can come back with no luxury cues at all.
 * Naming the file for its style would bake in a claim the image does not support.
 *
 * Provenance and the generator that produced these live in
 * to-build/media-png/Homepage/Restage/ — manifest.json records the recipe behind every
 * render, and tools/generate.mjs grows or repairs the pool (it rewrites the list below).
 */

/** Directory the pool and the empty source photo are served from. */
export const RESTAGE_DIR = 'media-webp/Homepage/Restage/';

/** The un-staged source photo every render in the pool was generated from. */
export const RESTAGE_EMPTY = 'empty.webp';

/**
 * Intrinsic size of every image in this set, source photo included. The section pins its
 * frame to this ratio rather than a rounded 3/2: the empty photo and each staged render
 * are the same photograph, so a couple of percent of ratio mismatch reads as the
 * furniture shifting when a card lands.
 *
 * NO RUNTIME CODE IMPORTS THIS, and that is not a sign it is dead. The ratio it describes
 * is spent in exactly one place — `aspect-ratio` on `.rs__stack` in home.css — which
 * cannot read a JS module. This constant is what
 * test/frontend/home-restage.test.js checks that declaration against, so the stylesheet
 * cannot drift from the real dimensions of the photographs. Deleting it removes the only
 * thing tying the two together.
 */
export const RESTAGE_SIZE = { width: 1216, height: 832 };

/** @type {readonly string[]} Every staged render, in no meaningful order — the section shuffles. */
export const RESTAGE_POOL = Object.freeze([
  'r01.webp',
  'r02.webp',
  'r03.webp',
  'r04.webp',
  'r05.webp',
  'r06.webp',
  'r07.webp',
  'r08.webp',
  'r09.webp',
  'r10.webp',
  'r11.webp',
  'r12.webp',
  'r13.webp',
  'r14.webp',
  'r15.webp',
  'r16.webp',
  'r17.webp',
  'r18.webp',
  'r19.webp',
  'r20.webp',
  'r21.webp',
  'r22.webp',
  'r23.webp',
  'r24.webp',
  'r25.webp',
  'r26.webp',
  'r27.webp',
  'r28.webp',
  'r29.webp',
  'r30.webp',
  'r31.webp',
  'r32.webp',
  'r33.webp',
  'r34.webp',
  'r35.webp',
  'r36.webp',
  'r37.webp',
  'r38.webp',
  'r39.webp',
  'r40.webp',
  'r41.webp',
  'r42.webp',
  'r43.webp',
  'r44.webp',
  'r45.webp',
  'r46.webp',
  'r47.webp',
  'r48.webp',
  'r49.webp',
  'r50.webp',
  'r51.webp',
  'r52.webp',
  'r53.webp',
  'r54.webp',
  'r55.webp',
  'r56.webp',
  'r57.webp',
  'r58.webp',
  'r59.webp',
  'r60.webp',
  'r61.webp',
  'r62.webp',
  'r63.webp',
  'r64.webp',
  'r65.webp',
  'r66.webp',
  'r67.webp',
  'r68.webp',
  'r69.webp',
  'r70.webp',
  'r71.webp',
  'r72.webp',
  'r73.webp',
  'r74.webp',
  'r75.webp',
  'r76.webp',
  'r77.webp',
  'r78.webp',
  'r79.webp',
  'r80.webp',
  'r81.webp',
  'r82.webp',
  'r83.webp',
  'r84.webp',
  'r85.webp',
  'r86.webp',
  'r87.webp',
  'r88.webp',
  'r89.webp',
  'r90.webp',
  'r91.webp',
  'r92.webp',
  'r93.webp',
  'r94.webp',
  'r95.webp',
  'r96.webp',
  'r97.webp',
  'r98.webp',
  'r99.webp',
  'r100.webp',
]);
