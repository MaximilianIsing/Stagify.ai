// The image behind the staging modal's "Preview" hover: the badge the user has configured,
// stamped onto a sample photo.
//
// WHY THE SERVER DRAWS THIS AND NOT THE BROWSER
// The obvious build is CSS — a div styled to look like the badge, over a thumbnail. It was
// rejected because the preview's only job is to be TRUE. A CSS mock would use Inter (the
// masters are Noto), its own padding numbers, its own idea of how the size slider maps to
// pixels, and its own capsule radius; every one of those is a place where the preview and
// the delivered photo drift apart silently, and the first person to notice would be an
// agent who published a listing photo that did not look like what they approved.
// Rendering here runs the REAL stampVirtuallyStaged over a real photo, so "the preview is
// wrong" can only mean "the output is wrong" — the same bug, in one place.
//
// It also keeps the badge strings server-side. They deliberately do not live in
// public/languages/*.json (see lib/staging/staging-disclosure.js); a browser-drawn preview
// would have needed them shipped to the client, which is the decision this avoids.
//
// WHY THIS IS SAFE TO EXPOSE UNAUTHENTICATED
// The parameter space is closed and small — 11 languages × 3 styles × the slider's 10 stops
// — so the work an anonymous caller can ask for is bounded by a cache that holds more
// entries than there are distinct answers, not by their patience. The route adds a limiter
// on top so that filling that cache from cold cannot be used as a CPU tarpit.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ALL_LOCALES } from '../i18n/locales.js';
import {
  stampVirtuallyStaged,
  clampStampScale,
  STAMP_STYLE_NAMES,
  DEFAULT_STAMP_STYLE,
  STAMP_SCALE_DEFAULT,
} from './stamp-disclosure.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_PHOTO = path.join(ROOT, 'public', 'media-webp', 'example', 'Modern.webp');

// COMPOSE at a realistic delivery size and DELIVER a thumbnail of it. Stamping a 600px
// image directly would be a lie in exactly the place the preview exists to be honest
// about: badge type is 2% of the long edge but never below FONT_MIN, so at 600px every
// slider position from 0.7 to 1.0 bottoms out on that floor and the slider looks broken.
// At 1200px the badge is in its proportional regime, and shrinking the finished frame
// afterwards scales badge and room together — which is what the user is judging.
const COMPOSE_W = 1200;
const COMPOSE_H = 800;
// Twice the popup's CSS width, so the badge inside it is still crisp on a 2× display —
// the badge is the one thing in this image anybody is looking at.
const OUTPUT_W = 680;
const WEBP_QUALITY = 72;

// Comfortably larger than the 330 answers the parameter space can produce, so a caller
// cycling through every combination warms the cache instead of thrashing it. Entries are
// ~40 KB, so this is a few MB at worst.
const CACHE_MAX = 400;

/** @type {Map<string, Buffer>} */
const cache = new Map();
/** @type {Promise<Buffer> | null} */
let samplePromise = null;

/** MIME type of every buffer this module returns. */
export const PREVIEW_CONTENT_TYPE = 'image/webp';

/**
 * The sample photo, decoded and cropped once per process.
 *
 * Cropped from the bottom because that is where the badge lands: a `cover` crop centred by
 * default would push the corner the user is meant to be looking at out of frame.
 * @returns {Promise<Buffer>} PNG bytes at COMPOSE_W × COMPOSE_H.
 */
function loadSample() {
  if (!samplePromise) {
    samplePromise = sharp(SAMPLE_PHOTO)
      .resize(COMPOSE_W, COMPOSE_H, { fit: 'cover', position: 'bottom' })
      .png()
      .toBuffer()
      .catch((error) => {
        // Clear the memo so a transient read failure does not poison every later request.
        samplePromise = null;
        throw error;
      });
  }
  return samplePromise;
}

/**
 * Coerce query parameters into the closed set this module renders.
 *
 * Exported because the route echoes the normalized values back in the response headers and
 * the cache key is built from them: an unrecognized language must collapse to 'english'
 * BEFORE it becomes a cache key, or a caller could mint unlimited entries by varying a
 * value that does not change the output.
 * @param {{ lang?: unknown, style?: unknown, scale?: unknown }} [params] - Raw query values.
 * @returns {{ lang: string, style: string, scale: number }} Values known to be renderable.
 */
export function normalizePreviewParams(params = {}) {
  const lang = String(params.lang || '').toLowerCase();
  const style = String(params.style || '').toLowerCase();
  return {
    lang: ALL_LOCALES.some((l) => l.lang === lang) ? lang : 'english',
    style: STAMP_STYLE_NAMES.includes(style) ? style : DEFAULT_STAMP_STYLE,
    scale: clampStampScale(params.scale ?? STAMP_SCALE_DEFAULT),
  };
}

/**
 * Render (or serve from cache) the preview for one badge configuration.
 * @param {{ lang: string, style: string, scale: number }} params - Already normalized.
 * @returns {Promise<Buffer>} WebP bytes, OUTPUT_W wide.
 */
export async function renderDisclosurePreview(params) {
  const key = `${params.lang}|${params.style}|${params.scale}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const sample = await loadSample();
  const stamped = await stampVirtuallyStaged(`data:image/png;base64,${sample.toString('base64')}`, params);
  const out = await sharp(Buffer.from(stamped.split(',')[1], 'base64'))
    .resize({ width: OUTPUT_W })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  // Map iterates in insertion order, so the first key is the oldest — evict that. Plain FIFO
  // rather than LRU on purpose: with a cache bigger than the answer space, eviction only
  // ever runs if that space grows, and a recency heap would be machinery for a case that
  // does not arise.
  if (cache.size >= CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
  cache.set(key, out);
  return out;
}

/**
 * Drop every cached preview. Test-only seam — nothing in the app invalidates this cache,
 * because the only thing that can change the bytes for a given key is a deploy.
 * @returns {void}
 */
export function resetDisclosurePreviewCache() {
  cache.clear();
  samplePromise = null;
}
