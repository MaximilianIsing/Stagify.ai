// The machine-readable vocabulary behind POST /api/v1/renders.
//
// WHY THIS EXISTS. A browser user picks `roomType` and `furnitureStyle` from a dropdown,
// so the UI *is* the documentation and a wrong value is unreachable. An API caller has no
// dropdown. Worse, every one of these fields FAILS SOFT: an unrecognised `furnitureStyle`
// silently resolves to 'standard' and an unrecognised `roomType` is interpolated into the
// prompt as free text, so a typo costs a credit and returns a plausible-but-wrong image
// with a 200. The developer needs the list, and needs it to be right.
//
// EVERY LIST HERE IS DERIVED, NEVER TYPED OUT. The docs page used to say
// "e.g. Living Room, Bedroom, Kitchen" and its copy-pasteable curl sent
// `roomType=Living Room` — with a capital R, which is NOT the promptMatrix key
// ('Living room'), so the one example we shipped silently took the generic fallback
// prompt. That is exactly what a hand-maintained list does. Read from the source or do
// not publish it at all; test/staging/api-options.test.js fails the build on drift.
//
// The `unknown` field on each entry is the part with no other home. It says what happens
// to a value that is not in `values`, which is the difference between a typo you find in
// testing and one you find in a customer's staged photo.

import { promptMatrix } from './promptMatrix.js';
import {
  STAMP_STYLE_NAMES,
  DEFAULT_STAMP_STYLE,
  STAMP_SCALE_MIN,
  STAMP_SCALE_MAX,
  STAMP_SCALE_DEFAULT,
} from '../image/stamp-disclosure.js';
import { ALL_LOCALES } from '../i18n/locales.js';
import { MAX_UPLOAD_BYTES, STAGING_IMAGE_MIME_TYPES } from '../http/uploads.js';

/**
 * The handler's own destructuring defaults (lib/staging/virtual-staging-handler.js).
 * Named here so the endpoint can publish them; the drift test reads the handler source
 * and fails if either moves.
 */
export const DEFAULT_ROOM_TYPE = 'Living room';
export const DEFAULT_FURNITURE_STYLE = 'standard';

/** The only variation count v1 accepts, and the only one one credit pays for. */
export const MAX_VARIATIONS = 1;

/** Furniture reference photos accepted per render (multer's maxCount for the field). */
export const MAX_FURNITURE_IMAGES = 5;

/**
 * Room types, in promptMatrix order. Case- and space-sensitive: 'Living Room' is not
 * 'Living room' and takes the generic fallback prompt instead of the tuned one.
 * @returns {string[]} The accepted roomType values.
 */
export function roomTypes() {
  return Object.keys(promptMatrix);
}

/**
 * Furniture styles, read off one room rather than listed again. Every room in the matrix
 * carries the same style keys, which the drift test asserts — deriving from one room and
 * checking the rest beats maintaining a twelfth copy of the list.
 * @returns {string[]} The accepted furnitureStyle values.
 */
export function furnitureStyles() {
  const first = Object.keys(promptMatrix)[0];
  return Object.keys(promptMatrix[first]);
}

/**
 * Disclosure-badge languages. Sourced from the site locale set, which is what
 * normalizeStampOptions actually validates against.
 * @returns {string[]} The accepted stampLang values.
 */
export function stampLanguages() {
  return ALL_LOCALES.map((l) => l.lang);
}

/**
 * The whole published vocabulary, shaped like the other /api/v1 bodies (an `object`
 * discriminator and snake_case keys).
 * @returns {object} The GET /api/v1/options response body.
 */
export function buildApiOptions() {
  return {
    object: 'options',
    // `passthrough` is not a synonym for `default`: an unrecognised roomType is not
    // replaced, it is written into the prompt verbatim. That is the one field where a
    // typo changes the image rather than being ignored.
    room_type: {
      values: roomTypes(),
      default: DEFAULT_ROOM_TYPE,
      unknown: 'passthrough',
      case_sensitive: true,
    },
    furniture_style: {
      values: furnitureStyles(),
      default: DEFAULT_FURNITURE_STYLE,
      unknown: 'default',
      case_sensitive: true,
    },
    stamp_style: {
      values: STAMP_STYLE_NAMES,
      default: DEFAULT_STAMP_STYLE,
      unknown: 'default',
      case_sensitive: false,
    },
    stamp_lang: {
      values: stampLanguages(),
      default: 'english',
      unknown: 'default',
      case_sensitive: false,
    },
    stamp_scale: {
      min: STAMP_SCALE_MIN,
      max: STAMP_SCALE_MAX,
      default: STAMP_SCALE_DEFAULT,
      unknown: 'clamp',
    },
    variations: {
      values: [MAX_VARIATIONS],
      default: MAX_VARIATIONS,
      unknown: 'reject',
    },
    image: {
      mime_types: STAGING_IMAGE_MIME_TYPES,
      max_bytes: MAX_UPLOAD_BYTES,
      max_count: 1,
      required: true,
    },
    furniture_image: {
      mime_types: STAGING_IMAGE_MIME_TYPES,
      max_bytes: MAX_UPLOAD_BYTES,
      max_count: MAX_FURNITURE_IMAGES,
      required: false,
    },
  };
}
