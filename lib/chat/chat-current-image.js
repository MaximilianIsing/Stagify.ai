// Current-turn image extraction for POST /api/chat, extracted verbatim from
// routes/chat.js.
//
// The JSON endpoint receives its current-message image inline (a data: URL in the
// last user turn's content array) rather than as a multipart file the way
// /api/chat-upload does. Both the staging step and the CAD step need it, so the
// handler resolves it ONCE and passes the pair down — the two used to scan the
// same content array with identical predicates.
//
// Pure; no deps bundle.

/**
 * Find the current turn's inline image. Returns `hasImage: true` as soon as an
 * `image_url` item with a url is present, even when the payload has no base64
 * segment after the comma — in that case `buffer` stays null. That asymmetry is
 * original behaviour: downstream steps treat "the user attached something" and
 * "we have decodable bytes" as separate facts.
 * @param {import('../types/chat.js').ChatMessage | undefined} lastUserMessage - The last user turn, or undefined when there is none.
 * @returns {{ hasImage: boolean, buffer: Buffer | null }} Whether the current turn carries an image, and its decoded bytes when available.
 */
export function extractCurrentMessageImage(lastUserMessage) {
  let hasImage = false;
  /** @type {Buffer | null} */
  let buffer = null;

  if (lastUserMessage && Array.isArray(lastUserMessage.content)) {
    const currentImageItem = lastUserMessage.content.find(
      (item) => item.type === 'image_url' && item.image_url && item.image_url.url
    );
    if (currentImageItem) {
      hasImage = true;
      // The find predicate already required a truthy image_url.url, so the ?? ''
      // fallback is unreachable — it is only here to satisfy strictNullChecks
      // against the optional ContentItem.image_url field.
      const b64 = (currentImageItem.image_url?.url ?? '').split(',')[1];
      if (b64) buffer = Buffer.from(b64, 'base64');
    }
  }

  return { hasImage, buffer };
}
