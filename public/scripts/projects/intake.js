// Everything the Listing Studio does to a picked batch BEFORE it becomes an upload: the
// per-file limits, the HEIC pass, and the sentence explaining what was skipped and why.
//
// Pure functions over `File`-shaped objects plus two reads of `window.StagifyHeic`. Split
// from ./upload.js (which owns the DOM tray) because the intake rules are the half a
// reviewer argues with and ./upload.js was at the 650-line cap.
//
// THE LIMITS HERE ARE A MIRROR OF THE SERVER'S, NOT AN OPINION. `MAX_FILE_BYTES` must equal
// `MAX_PHOTO_BYTES` in routes/projects.js and `MAX_PHOTOS` must equal
// `MAX_PHOTOS_PER_BATCH`; the dropzone copy is generated from them (`dropzoneHint`) so the
// page cannot advertise a limit the server does not honour, which is precisely what it did.

/**
 * @typedef {object} PjRejection
 * @property {string} name - The file's name, for the message.
 * @property {'type'|'size'|'limit'|'empty'|'heic'} reason
 */

/** Server-side batch ceiling, mirrored here so the operator hears about it instantly. */
export const MAX_PHOTOS = 40;

/**
 * Per-file ceiling. MUST equal `MAX_PHOTO_BYTES` in routes/projects.js.
 *
 * The dropzone copy is generated from this constant (see `sizeLimitText`) rather than typed
 * into the markup, because the two disagreeing is exactly the bug that shipped: the
 * dropzone advertised 25MB while multer was configured at 15, so a 20MB frame was accepted
 * by the page and rejected by the server with a 413 the operator could not explain.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** MAX_FILE_BYTES as the whole number of megabytes the copy quotes. */
export const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

/** Types the batch endpoint takes. HEIC is converted to JPEG first — see convertHeic. */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

/**
 * How many HEIC frames are converted in the page before the rest are refused.
 *
 * HEIC decoding is a ~1.3MB lazily-loaded WASM library running on the main thread, at
 * roughly a second per full-resolution photo. One or two is invisible; a whole 40-frame
 * shoot is a 40-second freeze, which is why the original code refused HEIC outright. The
 * cap keeps the common case (an agent who forgot to switch their iPhone to JPEG for a
 * handful of frames) working, and tells the truth about the rest instead of hanging.
 */
export const MAX_HEIC_CONVERSIONS = 10;

/**
 * Re-exported so the room-type control and the drift guard read one list. The list itself
 * lives in ./vocab.js, which is the single source that must agree with the server's
 * `promptMatrix` keys — every option value here is looked up case-sensitively and exactly,
 * and a key that does not match silently degrades the whole listing's prompt.
 */
export { ROOM_TYPES } from './vocab.js';

/**
 * Split a picked batch into what will be sent and what will not, with a reason.
 *
 * Rejections are reported rather than silently dropped: an operator who drops 45 files
 * and gets 40 photos with no explanation assumes the other five are still coming.
 * @param {File[]|FileList} files
 * @param {{ max?: number, maxBytes?: number, accepted?: string[] }} [opts]
 * @returns {{ accepted: File[], rejected: PjRejection[] }}
 */
export function validateFiles(files, opts = {}) {
  const max = opts.max ?? MAX_PHOTOS;
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const types = opts.accepted ?? ACCEPTED_TYPES;
  /** @type {File[]} */
  const accepted = [];
  /** @type {PjRejection[]} */
  const rejected = [];

  for (const file of files ? Array.from(files) : []) {
    const name = file.name || 'photo';
    if (!file.size) {
      rejected.push({ name, reason: 'empty' });
    } else if (looksHeic(file)) {
      // Its own reason, not 'type'. Reported as "not a JPEG, PNG or WebP" this was the
      // single most confusing message on the page: HEIC is the DEFAULT iPhone export, so
      // the message named three formats and omitted the one the operator actually had.
      rejected.push({ name, reason: 'heic' });
    } else if (!types.includes(String(file.type).toLowerCase())) {
      rejected.push({ name, reason: 'type' });
    } else if (file.size > maxBytes) {
      rejected.push({ name, reason: 'size' });
    } else if (accepted.length >= max) {
      rejected.push({ name, reason: 'limit' });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

/**
 * Up to `max` names, then "+N more". Bounded because a dropped Finder window can be
 * hundreds of files and a toast is not a log.
 * @param {string[]} names
 * @param {number} [max=3]
 * @returns {string}
 */
export function nameList(names, max = 3) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

/**
 * One sentence covering a batch's rejections, or '' when there were none.
 *
 * NAMES THE FILES. "Skipped 1 file(s): 1 over 25MB" told an operator that something in a
 * 40-photo drop was too big and left them to find it; the whole point of a per-file check
 * is that the page already knows which one.
 * @param {PjRejection[]} rejected
 * @param {number} [max]
 * @returns {string}
 */
export function rejectionMessage(rejected, max = MAX_PHOTOS) {
  if (!rejected || !rejected.length) return '';
  /** @type {Record<string, string[]>} */
  const byReason = { type: [], size: [], limit: [], empty: [], heic: [] };
  for (const item of rejected) (byReason[item.reason] || byReason.type).push(item.name);
  /** @type {string[]} */
  const parts = [];
  if (byReason.heic.length) {
    parts.push(
      `${nameList(byReason.heic)} ${byReason.heic.length === 1 ? 'is' : 'are'} HEIC — export as JPEG (iPhone: Settings › Camera › Formats › Most Compatible) and try again`
    );
  }
  if (byReason.type.length) {
    parts.push(`${nameList(byReason.type)} is not a JPEG, PNG or WebP`);
  }
  if (byReason.size.length) {
    parts.push(`${nameList(byReason.size)} is over ${MAX_FILE_MB}MB`);
  }
  if (byReason.empty.length) parts.push(`${nameList(byReason.empty)} is empty`);
  if (byReason.limit.length) {
    parts.push(`${byReason.limit.length} file(s) over the ${max}-photo limit`);
  }
  return `Skipped ${rejected.length} file(s): ${parts.join('; ')}.`;
}

/**
 * Does this file look like HEIC/HEIF?
 *
 * Delegates to the shared detector on `window.StagifyHeic` (scripts/heic-convert.js), which
 * checks the MIME type and falls back to the extension for the browsers that report an empty
 * type for .heic. A local extension test is the fallback for when that script has not loaded,
 * so the message still names HEIC instead of blaming the batch.
 * @param {{ name?: string, type?: string }} file
 * @returns {boolean}
 */
export function looksHeic(file) {
  const heic = typeof window === 'undefined' ? null : window.StagifyHeic;
  if (heic && typeof heic.isHeic === 'function') return !!heic.isHeic(file);
  const type = String((file && file.type) || '').toLowerCase();
  if (type.startsWith('image/heic') || type.startsWith('image/heif')) return true;
  return /\.(heic|heif)$/i.test(String((file && file.name) || ''));
}

/**
 * Convert the HEIC frames in a picked batch to JPEG, up to MAX_HEIC_CONVERSIONS.
 *
 * Reuses scripts/heic-convert.js exactly as the main stager does — same lazily-loaded
 * library, same "Converting photo…" toast — rather than a second decoder. Non-HEIC files
 * pass through untouched and cost nothing.
 *
 * A file whose conversion FAILS is returned as-is: validateFiles then rejects it as HEIC
 * with the export instructions, which is a better outcome than dropping it silently.
 * @param {File[]} files
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ files: File[], converted: number, skipped: number }>}
 */
export async function convertHeic(files, opts = {}) {
  const limit = opts.limit ?? MAX_HEIC_CONVERSIONS;
  const heic = typeof window === 'undefined' ? null : window.StagifyHeic;
  const list = Array.from(files || []);
  if (!heic || typeof heic.toDisplayableFile !== 'function') {
    return { files: list, converted: 0, skipped: list.filter(looksHeic).length };
  }
  /** @type {File[]} */
  const out = [];
  let converted = 0;
  let skipped = 0;
  for (const file of list) {
    if (!looksHeic(file)) {
      out.push(file);
      continue;
    }
    if (converted >= limit) {
      skipped += 1;
      out.push(file);
      continue;
    }
    try {
      // Sequential on purpose: the decoder is single-threaded and running ten in parallel
      // makes the tab unresponsive without finishing any sooner.
      out.push(await heic.toDisplayableFile(file));
      converted += 1;
    } catch (e) {
      out.push(file);
    }
  }
  return { files: out, converted, skipped };
}

/** The dropzone's format/limit line, generated so it cannot drift from the constants. */
export function dropzoneHint() {
  return `JPEG, PNG or WebP · up to ${MAX_FILE_MB}MB per photo · HEIC is converted for you (first ${MAX_HEIC_CONVERSIONS})`;
}
