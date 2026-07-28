// Per-upload image-annotation map for POST /api/chat-upload, extracted verbatim
// from routes/chat.js.
//
// buildUploadMessages annotates each uploaded image and parks the result on the
// private `_annotation` / `_filename` side-channel of the cleaned content items —
// private because those keys are stripped before the array is sent to OpenAI. The
// response body carries them back to the browser keyed by filename, so the UI can
// show what the model was told about each upload.
//
// Pure; no deps bundle.

/**
 * Collect `{ filename: annotation }` for every cleaned content item that produced an
 * annotation. The filename comes from the item's own `_filename`, falling back to the
 * matching (index-aligned) pre-clean item's `filename`/`originalname`. Items with no
 * resolvable filename are skipped.
 * @param {{ cleanedUserContent: any[], filteredUserContent: any[] }} args - The cleaned content items (carrying `_annotation`) and the index-aligned pre-clean items used for the filename fallback.
 * @returns {Record<string, string>} Annotation keyed by upload filename.
 */
export function extractUploadImageAnnotations({ cleanedUserContent, filteredUserContent }) {
  /** @type {Record<string, string>} */
  const imageAnnotations = {};
  cleanedUserContent.forEach((item, idx) => {
    if (item.type === 'image_url' && item._annotation) {
      const filename = item._filename || (filteredUserContent[idx] && (filteredUserContent[idx].filename || filteredUserContent[idx].originalname));
      if (filename) {
        imageAnnotations[filename] = item._annotation;
      }
    }
  });
  return imageAnnotations;
}
