// Pure helpers extracted from the main Stagify tool (scripts/app.js).
//
// No DOM, no app state — deterministic transforms on their arguments, so they
// run under node --test with no shim (see test/app-helpers.test.js). atob /
// Uint8Array / File are Web-platform globals available in both the browser and
// modern Node (>=20).

// Clamp a display filename to `maxLen` chars, adding an ellipsis when clipped.
export function abbreviateFileName(name, maxLen) {
  var s = String(name || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

// Decode a `data:<mime>;base64,<data>` URL into a File (for re-uploading a
// committed canvas result). Falls back to image/png + "photo.png".
export function dataURLToFile(dataUrl, filename) {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8 = new Uint8Array(n);
  while (n--) u8[n] = bstr.charCodeAt(n);
  return new File([u8], filename || 'photo.png', { type: mime });
}

// Replace every `{token}` in `tpl` with its value from `replacements`
// (null/undefined → ""). Tokens with no matching key are left untouched. Keys
// are code-controlled, so they are interpolated into the pattern unescaped —
// exactly as the two call sites in scripts/app.js did before this was hoisted.
/**
 * @param {string | null | undefined} tpl
 * @param {Record<string, unknown>} [replacements]
 * @returns {string}
 */
export function fillTemplate(tpl, replacements = {}) {
  let text = String(tpl == null ? '' : tpl);
  for (const [k, v] of Object.entries(replacements)) {
    text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v == null ? '' : String(v));
  }
  return text;
}

// Build the "daily free limit reached" message shown in the staging viewer.
// Pure: the caller resolves the i18n `template` (account vs anonymous variant)
// and passes it in; this fills the limit/used counts — defaulting to 3 / limit
// when the server omits them — and falls back to the server `error` string (or
// a hard-coded English default) when there is no usable template.
/**
 * @param {{ dailyGenerationLimit?: number|null, dailyGenerationsUsed?: number|null, error?: string } | null | undefined} errorData
 * @param {{ template?: string | null }} [opts]
 * @returns {string}
 */
export function dailyLimitMessage(errorData, { template } = {}) {
  const data = errorData || {};
  const lim = data.dailyGenerationLimit != null ? data.dailyGenerationLimit : 3;
  const used = data.dailyGenerationsUsed != null ? data.dailyGenerationsUsed : lim;
  if (template && template !== 'Loading...') {
    return fillTemplate(template, { limit: lim, used });
  }
  return data.error || `Daily free limit reached (${lim} per day).`;
}

// Slugify a room-type label for a download filename: lowercased, whitespace
// runs → single dashes, falling back to "room" when empty
// (e.g. "Living Room" → "living-room").
/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function roomDownloadSlug(value) {
  return (value || 'room').toLowerCase().replace(/\s+/g, '-');
}
