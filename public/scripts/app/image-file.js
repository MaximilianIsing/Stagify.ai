// Shared room-photo intake for the two places a visitor hands us an image file:
// the staging dropzone (scripts/app.js) and the standalone Basic Mask uploader
// (scripts/app/stage-mask-editor.js).
//
// Both need the same three gates before anything can be drawn to a canvas —
// iPhone HEIC/HEIF converted to something browsers can decode, a type we can
// actually decode, and a size ceiling — so they share one copy rather than the
// Basic Mask uploader growing a second, drifting one.
//
// The gate itself is a pure function (fileRejection) so it can be tested without
// a DOM, a FileReader or a File; readImageFile() is the thin async wrapper that
// does the conversion and the read.

/** Types the browsers we support can decode onto a canvas. */
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

/** 100 MB. Matches the server's upload ceiling. */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

/**
 * Decide whether a chosen file is usable, as a translation key suffix.
 *
 * Returns the `errors.*` key to show, or null when the file is fine. Kept pure
 * (no DOM, no toast) so the rule is testable on its own.
 *
 * @param {string} type - the file's MIME type
 * @param {number} size - the file's size in bytes
 * @returns {'fileType' | 'fileTooLarge' | null}
 */
export function fileRejection(type, size) {
  if (!ALLOWED_TYPES.includes(String(type || '').toLowerCase())) return 'fileType';
  if (Number(size) > MAX_IMAGE_BYTES) return 'fileTooLarge';
  return null;
}

/** English fallbacks, used when the language pack hasn't loaded. */
const FALLBACK = {
  heicConvert: "We couldn't read that HEIC photo. Please try a JPG or PNG.",
  fileType: 'Please upload a PNG, JPG, JPEG, WebP, or GIF image file.',
  fileTooLarge: 'File is too large. Please upload an image smaller than 100MB.',
};

/**
 * @param {'heicConvert' | 'fileType' | 'fileTooLarge'} key
 * @returns {string}
 */
function message(key) {
  return window.LanguageSystem?.getText('errors.' + key) || FALLBACK[key];
}

/**
 * Convert (if needed), validate and read a chosen image file.
 *
 * Resolves null after reporting the reason through `showError`, so callers can
 * simply bail on a falsy result. Never throws for a bad file — only a genuinely
 * unreadable one rejects.
 *
 * @param {File} file
 * @param {{ showError: (msg: string) => void }} deps
 * @returns {Promise<{ file: File, dataUrl: string } | null>}
 */
export async function readImageFile(file, { showError }) {
  // iPhone HEIC/HEIF photos aren't decodable by most browsers; convert to JPEG
  // first so the preview and on-canvas editing work everywhere.
  let usable = file;
  if (window.StagifyHeic && window.StagifyHeic.isHeic(usable)) {
    try {
      usable = await window.StagifyHeic.toDisplayableFile(usable);
    } catch (e) {
      showError(message('heicConvert'));
      return null;
    }
  }

  const rejection = fileRejection(usable.type, usable.size);
  if (rejection) {
    showError(message(rejection));
    return null;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(usable);
  });

  return { file: usable, dataUrl };
}
