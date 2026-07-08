// Conversation-history image bookkeeping for the AI Designer thumbnail strip.
//
// Pure data logic — no DOM, no window, no app state. The functions that used to
// read the module-global `conversationHistory` / `selectedImageIndex` now take
// them as parameters, so the whole module is unit-testable under `node --test`
// (see test/ai-designer-image-history.test.js). The browser entry keeps thin
// same-named wrappers that pass its live globals, so its call sites are
// unchanged.
//
// This mirrors the already-tested backend lib/chat-history.js
// (collectImagesFromHistory / getOriginalImageIndex) but operates on the
// browser's `conversationHistory` shape rather than the API message format.

import { getFileStem, truncateThumbnailStem } from './format.js';

// Root/base label for an image object, falling back through rootBaseName ->
// filename stem -> "Upload".
export function getRootBaseNameForImage(img) {
  if (!img) return 'Upload';
  if (img.rootBaseName) return img.rootBaseName;
  const stem = getFileStem(img.filename);
  return stem || 'Upload';
}

// Walk the conversation oldest-first, collecting every user upload and every
// staged/generated/masked assistant image into a flat chronological list.
export function extractRawImagesChronological(conversationHistory) {
  const images = [];
  for (let i = 0; i < conversationHistory.length; i++) {
    const msg = conversationHistory[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageItems = msg.content.filter(
        (item) => item.type === 'image_url' && item.image_url && item.image_url.url
      );
      imageItems.forEach((imageItem) => {
        images.push({
          url: imageItem.image_url.url,
          isStaged: false,
          isGenerated: false,
          isMasked: Boolean(imageItem.isMasked),
          filename: imageItem.filename || null,
          rootBaseName: imageItem.rootBaseName || null,
          stagedNumber: imageItem.stagedNumber != null ? imageItem.stagedNumber : null,
          maskNumber: imageItem.maskNumber != null ? imageItem.maskNumber : null,
        });
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const imageItems = msg.content.filter(
        (item) =>
          item.type === 'image_url' &&
          item.image_url &&
          item.image_url.url &&
          (item.isStaged || item.isGenerated || item.isMasked)
      );
      imageItems.forEach((imageItem) => {
        images.push({
          url: imageItem.image_url.url,
          isStaged: Boolean(imageItem.isStaged),
          isGenerated: Boolean(imageItem.isGenerated),
          isMasked: Boolean(imageItem.isMasked),
          filename: imageItem.filename || null,
          rootBaseName: imageItem.rootBaseName || null,
          stagedNumber: imageItem.stagedNumber != null ? imageItem.stagedNumber : null,
          maskNumber: imageItem.maskNumber != null ? imageItem.maskNumber : null,
        });
      });
    }
  }
  return images;
}

// Assign display labels + staged/mask counts in place (mutates each entry),
// carrying the most recent upload's root name forward to derived images.
export function applyThumbnailLabels(chronologicalImages) {
  const stagedCounts = {};
  const maskCounts = {};
  let lastUploadRoot = 'Upload';

  chronologicalImages.forEach((img) => {
    if (!img.isStaged && !img.isGenerated && !img.isMasked) {
      const stem = getFileStem(img.filename);
      img.rootBaseName = img.rootBaseName || stem || lastUploadRoot;
      lastUploadRoot = img.rootBaseName;
      img.displayLabel = truncateThumbnailStem(img.rootBaseName);
      return;
    }

    const root = img.rootBaseName || lastUploadRoot;
    img.rootBaseName = root;

    if (img.isMasked) {
      if (img.maskNumber == null) {
        maskCounts[root] = (maskCounts[root] || 0) + 1;
        img.maskNumber = maskCounts[root];
      } else {
        maskCounts[root] = Math.max(maskCounts[root] || 0, img.maskNumber);
      }
      img.displayLabel = img.maskNumber <= 1
        ? `${truncateThumbnailStem(root)} (Masked)`
        : `${truncateThumbnailStem(root)} (Masked ${img.maskNumber})`;
      return;
    }

    if (img.isStaged) {
      if (img.stagedNumber == null) {
        stagedCounts[root] = (stagedCounts[root] || 0) + 1;
        img.stagedNumber = stagedCounts[root];
      } else {
        stagedCounts[root] = Math.max(stagedCounts[root] || 0, img.stagedNumber);
      }
      img.displayLabel = `${truncateThumbnailStem(root)} (Staged #${img.stagedNumber})`;
      return;
    }

    if (img.isGenerated) {
      const genStem = getFileStem(img.filename);
      img.displayLabel = genStem
        ? `${truncateThumbnailStem(genStem)} (Generated)`
        : `${truncateThumbnailStem(root)} (Generated)`;
    }
  });

  return chronologicalImages;
}

// Newest-first labeled image list for the thumbnail strip.
export function collectImagesFromConversationHistory(conversationHistory) {
  const chronological = extractRawImagesChronological(conversationHistory);
  applyThumbnailLabels(chronological);
  return chronological.reverse();
}

// Display label for a single image, deriving one when none was assigned.
export function getThumbnailLabel(img) {
  return img.displayLabel || truncateThumbnailStem(getRootBaseNameForImage(img));
}

// When multiple uploads are present, pick which one is the "room" to stage into
// (vs a furniture reference) by keyword-classifying filename + label.
export function pickPreferredRoomImageIndex(images) {
  if (!images || images.length < 2) return 0;
  function roleFor(img) {
    const hay = `${img.filename || ''} ${img.displayLabel || ''}`.toLowerCase();
    const furniture = /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture|stool|bench|nightstand)\b/;
    const room = /\b(room|living|bedroom|kitchen|bathroom|dining|office|interior|empty)\b/;
    if (furniture.test(hay) && !room.test(hay)) return 'furniture';
    if (room.test(hay)) return 'room';
    return 'unknown';
  }
  const roles = images.map((img, index) => ({ index, role: roleFor(img) }));
  const roomHit = roles.find((r) => r.role === 'room');
  if (roomHit) return roomHit.index;
  const furnitureHit = roles.find((r) => r.role === 'furniture');
  if (furnitureHit) {
    const unknown = roles.find((r) => r.role === 'unknown');
    if (unknown) return unknown.index;
  }
  // Default: second file in upload order = index 1 (chronological); reversed list index 1
  return Math.min(1, images.length - 1);
}

// Index (into the newest-first list) of the image the next request should use
// as its base, honoring the user's thumbnail selection.
export function getBaseImageIndexForRequest(conversationHistory, selectedImageIndex) {
  const images = collectImagesFromConversationHistory(conversationHistory);
  if (images.length === 0 || selectedImageIndex === null) return undefined;
  if (selectedImageIndex >= images.length) return 0;
  return selectedImageIndex;
}

// Root/base label used to name a staging request's outputs: the selected base
// image, else the first uploaded image in this request, else the newest image.
export function resolveStagingRootBaseName(filesToSend, conversationHistory, selectedImageIndex) {
  const images = collectImagesFromConversationHistory(conversationHistory);
  const baseIdx = getBaseImageIndexForRequest(conversationHistory, selectedImageIndex);
  if (baseIdx !== undefined && images[baseIdx]) {
    return getRootBaseNameForImage(images[baseIdx]);
  }
  const upload = filesToSend && filesToSend.find((f) => f.type.startsWith('image/'));
  if (upload) return getFileStem(upload.name) || 'Upload';
  if (images[0]) return getRootBaseNameForImage(images[0]);
  return 'Upload';
}
