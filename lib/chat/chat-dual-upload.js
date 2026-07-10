// "Room + furniture" dual-upload resolution: detect when the current turn's two
// (or more) images are a room plus one-or-more furniture references and split
// them into a room buffer + furniture buffers. Split out of chat-history.js;
// pure except for DEBUG_MODE-gated logging.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { classifyUploadImageRole } from './chat-image-classification.js';

/**
 * Split classified upload entries into a single room + one-or-more furniture references,
 * applying fallbacks (e.g. the common "furniture first, room second" two-image order).
 * @param {Array<{ role: string, buffer?: Buffer, filename?: string }>} entries - Classified upload entries.
 * @returns {{ room: any, furniture: any[] } | null} The room + furniture partition, or null when it cannot be split confidently.
 */
export function partitionDualUploadEntries(entries) {
  const rooms = entries.filter((e) => e.role === 'room');
  const furniture = entries.filter((e) => e.role === 'furniture');
  const unknown = entries.filter((e) => e.role === 'unknown');

  if (rooms.length >= 1 && furniture.length >= 1) {
    return { room: rooms[0], furniture: [...furniture, ...unknown] };
  }
  if (rooms.length === 1 && unknown.length >= 1 && furniture.length === 0) {
    return { room: rooms[0], furniture: unknown };
  }
  if (furniture.length === 1 && unknown.length >= 1 && rooms.length === 0) {
    return { room: unknown[0], furniture };
  }
  if (entries.length === 2 && rooms.length === 0 && furniture.length === 0) {
    // Common upload order: furniture first, room second
    return { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  return null;
}

/**
 * Detect a "room + furniture" dual upload among the current multipart files and split it into
 * a room buffer plus furniture buffers. Returns null when it is not a confident dual upload.
 * @param {any[]} files - The current multipart upload files (multer's array or fields shape).
 * @param {any[]} annotatedUserContent - The annotated user-content items (used to recover per-file annotations).
 * @param {string} message - The user's message text (used for "stage my room" fallbacks).
 * @returns {import('../types/chat.js').DualUploadResolution | null} The room + furniture split, or null.
 */
export function resolveDualUploadStaging(files, annotatedUserContent, message) {
  const imageFiles = (files || []).filter((f) => f.mimetype && f.mimetype.startsWith('image/'));
  if (imageFiles.length < 2) return null;

  const entries = imageFiles
    .map((file) => {
      const contentItem = (annotatedUserContent || []).find(
        (item) =>
          item.type === 'image_url' &&
          (item._filename === file.originalname || item.filename === file.originalname)
      );
      const meta = {
        filename: file.originalname,
        annotation: contentItem?._annotation || contentItem?.annotation || null,
      };
      return {
        buffer: file.buffer,
        role: classifyUploadImageRole(meta),
        filename: file.originalname,
      };
    })
    .filter((e) => e.buffer);

  if (entries.length < 2) return null;

  let partition = partitionDualUploadEntries(entries);
  const m = (message || '').toLowerCase();
  if (!partition && /\bstage\s+(my|the|this)\s+room\b/.test(m) && entries.length === 2) {
    partition = { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  if (!partition) return null;

  const furnitureBuffers = partition.furniture.map((e) => e.buffer).filter(Boolean);
  if (!partition.room?.buffer || furnitureBuffers.length === 0) return null;

  if (DEBUG_MODE) {
    logger.debug(
      `[Staging] Dual upload split: room="${partition.room.filename}", furniture=[${partition.furniture.map((f) => f.filename).join(', ')}]`
    );
  }

  return {
    roomBuffer: partition.room.buffer,
    furnitureBuffers,
    source: 'current upload (room + furniture)',
  };
}

/**
 * Same as {@link resolveDualUploadStaging} but sourcing the images from a message's content
 * array (data URLs) instead of multipart files. Returns null when it is not a dual upload.
 * @param {any[]} userMessageContent - A user message's content items (image_url data URLs).
 * @param {string} message - The user's message text (used for "stage my room" fallbacks).
 * @returns {import('../types/chat.js').DualUploadResolution | null} The room + furniture split, or null.
 */
export function resolveDualUploadFromMessageContent(userMessageContent, message) {
  if (!Array.isArray(userMessageContent)) return null;
  const imageItems = userMessageContent.filter(
    (item) => item.type === 'image_url' && item.image_url && item.image_url.url
  );
  if (imageItems.length < 2) return null;

  const entries = imageItems
    .map((item) => {
      const meta = {
        filename: item.filename || item.originalname,
        annotation: item._annotation || item.annotation || null,
      };
      const b64 = item.image_url.url.split(',')[1];
      if (!b64) return null;
      return {
        buffer: Buffer.from(b64, 'base64'),
        role: classifyUploadImageRole(meta),
        filename: meta.filename || 'upload',
      };
    })
    .filter(Boolean);

  if (entries.length < 2) return null;

  let partition = partitionDualUploadEntries(entries);
  const m = (message || '').toLowerCase();
  if (!partition && /\bstage\s+(my|the|this)\s+room\b/.test(m) && entries.length === 2) {
    partition = { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  if (!partition) return null;

  const furnitureBuffers = partition.furniture.map((e) => e.buffer).filter(Boolean);
  if (!partition.room?.buffer || furnitureBuffers.length === 0) return null;

  return {
    roomBuffer: partition.room.buffer,
    furnitureBuffers,
    source: 'message upload (room + furniture)',
  };
}
