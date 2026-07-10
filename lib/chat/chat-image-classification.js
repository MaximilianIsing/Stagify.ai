// Furniture/room classification heuristics: infer whether an upload is a
// furniture reference (product shot) or a room, and whether the user's text is
// asking to add furniture into an existing room. Split out of chat-history.js;
// pure over their inputs (filename/annotation strings, message text).

/**
 * Heuristic: does the user's message ask to add/place a piece of furniture into a room
 * (vs. a fresh full-room staging)?
 * @param {string} messageText - The user's message text.
 * @returns {boolean} true when the phrasing indicates adding furniture to an existing room.
 */
export function userWantsToAddFurnitureToRoom(messageText) {
  if (!messageText || typeof messageText !== 'string') return false;
  const m = messageText.toLowerCase();
  if (/\b(this|that|the)\s+(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair)\b/.test(m)) {
    return true;
  }
  if (/\badd (this|the|that|my|a)\b/.test(m) && /\b(chair|sofa|couch|table|desk|lamp|bed|furniture|piece|it)\b/.test(m)) {
    return true;
  }
  return (
    /\b(add|include|put|place|incorporate|insert|use)\b/.test(m) &&
    /\b(chair|sofa|couch|table|desk|lamp|bed|furniture|piece|item|this|it|these|that)\b/.test(m)
  );
}

/**
 * Heuristic: is this image a standalone furniture reference (a product shot) rather than a
 * room? Based on filename/annotation terms; staged/generated images are never furniture refs.
 * @param {{ isStaged?: boolean, isGenerated?: boolean, filename?: string | null, annotation?: string | null }} img - An image descriptor (HistoryImage or a lightweight { filename, annotation } meta).
 * @returns {boolean} true when the image looks like a furniture reference.
 */
export function isLikelyFurnitureReferenceImage(img) {
  if (!img || img.isStaged || img.isGenerated) return false;
  const hay = `${img.filename || ''} ${img.annotation || ''}`.toLowerCase();
  const furnitureTerms = /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture|stool|bench|nightstand|credenza|sideboard|recliner)\b/;
  const roomTerms = /\b(room|living|bedroom|kitchen|bathroom|dining|office|interior|staging|staged|floor plan|blueprint|empty)\b/;
  return furnitureTerms.test(hay) && !roomTerms.test(hay);
}

/**
 * Whether an image can serve as the ROOM to place furniture into (staged/generated images
 * always qualify; otherwise anything not classified as a furniture reference).
 * @param {{ isStaged?: boolean, isGenerated?: boolean, filename?: string | null, annotation?: string | null }} img - An image descriptor.
 * @returns {boolean} true when the image is a valid room target.
 */
export function isRoomImageForFurniturePlacement(img) {
  if (!img) return false;
  if (img.isStaged || img.isGenerated) return true;
  return !isLikelyFurnitureReferenceImage(img);
}

/**
 * Classify an uploaded image's role from its filename/annotation (and staged/generated flags).
 * @param {{ isStaged?: boolean, isGenerated?: boolean, filename?: string | null, annotation?: string | null }} img - An image descriptor.
 * @returns {'room' | 'furniture' | 'unknown'} The inferred role.
 */
export function classifyUploadImageRole(img) {
  if (!img) return 'unknown';
  if (img.isStaged || img.isGenerated) return 'room';
  const hay = `${img.filename || ''} ${img.annotation || ''}`.toLowerCase();
  const furnitureTerms =
    /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture piece|product shot|isolated|white background|dining chair|sectional|nightstand|stool|bench|credenza|sideboard|recliner)\b/;
  const roomTerms =
    /\b(room|living room|bedroom|kitchen|bathroom|dining room|office|interior|empty room|unfurnished|listing photo|real estate|walls|windows|floor|space)\b/;
  const furnitureHit = furnitureTerms.test(hay);
  const roomHit = roomTerms.test(hay);
  if (furnitureHit && !roomHit) return 'furniture';
  if (roomHit && !furnitureHit) return 'room';
  if (isLikelyFurnitureReferenceImage(img)) return 'furniture';
  if (roomHit) return 'room';
  return 'unknown';
}
