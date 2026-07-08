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
