// Barrel for the conversation-history and image-resolution helpers of the AI
// Designer chat flow. The implementations were split out of this file (once a
// 928-line grab-bag) into four cohesive modules; this barrel re-exports them so
// existing import sites keep working unchanged. Import from the specific module
// when adding new call sites:
//   - chat-history-sanitize.js     — content filtering + dedup
//   - chat-image-collection.js     — the image index-space primitive + retrieval
//   - chat-image-classification.js — furniture/room heuristics
//   - chat-dual-upload.js          — room + furniture dual-upload splitting
//   - chat-base-image-staging.js   — base-image selection + staging-param resolution
export {
  filterUnsupportedFiles,
  filterConversationHistory,
  deduplicateMessages,
  stripImagesFromHistory,
} from './chat-history-sanitize.js';

export {
  collectImagesFromHistory,
  getPriorHistoryForImageContext,
  findMostRecentStagedImageIndex,
  getImageFromHistory,
  buildImageContext,
  getOriginalImageIndex,
} from './chat-image-collection.js';

export {
  userWantsToAddFurnitureToRoom,
  isLikelyFurnitureReferenceImage,
  isRoomImageForFurniturePlacement,
  classifyUploadImageRole,
} from './chat-image-classification.js';

export {
  partitionDualUploadEntries,
  resolveDualUploadStaging,
  resolveDualUploadFromMessageContent,
} from './chat-dual-upload.js';

export {
  parseBaseImageIndex,
  getBaseImageSelectionContext,
  applyBaseImageIndexToStagingParams,
  resolveCadImageIndex,
  resolveTargetRoomImageIndex,
  applyAddFurnitureStagingFallback,
} from './chat-base-image-staging.js';
