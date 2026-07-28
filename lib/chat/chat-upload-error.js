// Unsupported-file error body for the /api/chat-upload catch block, extracted
// from routes/chat.js. Pure and stateless (see test/*): given the request's
// uploaded files, it filters for the formats the pipeline can't handle (AVIF
// and any non-whitelisted image/*) and builds the user-facing "I'm unable to
// handle these file types" JSON body. Returns null when nothing unsupported is
// present, so the caller falls through to its generic 500.
//
// resolveUploadErrorBody() wraps it with the rest of the catch block's decision:
// the "does this error smell like a file-type problem?" sniff, the req.files
// shape coercion, and the swallow-and-log guard around the whole attempt.
import path from 'path';
import { logger } from '../logger.js';

/**
 * Build the user-facing "unable to handle these file types" JSON body for the
 * /api/chat-upload catch block. Pure: only reads each file's originalname/mimetype
 * and filters for AVIF plus any non-whitelisted image/* type.
 * @param {import('../types/chat.js').UploadedFile[]} files - The request's uploaded files (each { originalname, mimetype }).
 * @returns {{ response: string, files: Array<{ name: string, type: string }>, memories: { stores: [], forgets: [] } } | null} The error body, or null when nothing is unsupported (caller falls through to a generic 500).
 */
export function buildUnsupportedFileErrorBody(files) {
  // Find unsupported files by checking extensions and MIME types
  const unsupportedFiles = files.filter(file => {
    const ext = path.extname(file.originalname).toLowerCase();
    const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    return ext === '.avif' ||
           file.mimetype === 'image/avif' ||
           (file.mimetype.startsWith('image/') && !supportedImageTypes.includes(file.mimetype));
  });

  if (unsupportedFiles.length === 0) return null;

  const fileTypes = unsupportedFiles.map(file => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.avif' || file.mimetype === 'image/avif') {
      return 'AVIF';
    }
    return ext.toUpperCase().substring(1) || file.mimetype;
  });

  const uniqueFileTypes = [...new Set(fileTypes)];
  const fileTypeList = uniqueFileTypes.length === 1
    ? uniqueFileTypes[0]
    : uniqueFileTypes.join(', ');

  const aiResponse = `I'm unable to handle ${uniqueFileTypes.length > 1 ? 'these file types' : 'this file type'}: ${fileTypeList}. ` +
                   `Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ` +
                   `Please convert ${unsupportedFiles.length > 1 ? 'these files' : 'this file'} to a supported format and try again.`;

  return {
    response: aiResponse,
    files: unsupportedFiles.map(f => ({ name: f.originalname, type: f.mimetype })),
    memories: { stores: [], forgets: [] }
  };
}

/**
 * Decide whether the /api/chat-upload catch block can answer with a friendly
 * "unsupported file type" 200 body instead of its generic 500.
 *
 * Verbatim from the handler: an error is treated as file-type-related when its
 * message mentions image/format/avif/unsupported (case-insensitively), and the
 * friendly body is attempted whenever that sniff hits OR the request carried any
 * file at all — but only while an OpenAI client is configured, which is the gate
 * the original `&& openai` expressed. Any failure while building the body is
 * logged and swallowed so the caller still reaches its generic 500.
 * @param {{ error: any, reqFiles: any, openai: any }} args - The caught error, the raw `req.files` (array from `.array()`, or the map-shaped `.fields()` fallback), and the injected OpenAI client (truthiness only).
 * @returns {{ response: string, files: Array<{ name: string, type: string }>, memories: { stores: [], forgets: [] } } | null} The friendly body to send, or null when the caller should fall through.
 */
export function resolveUploadErrorBody({ error, reqFiles, openai }) {
  try {
    const errorMessage = error.message || '';
    const isFileTypeError = errorMessage.toLowerCase().includes('image') ||
                           errorMessage.toLowerCase().includes('format') ||
                           errorMessage.toLowerCase().includes('avif') ||
                           errorMessage.toLowerCase().includes('unsupported');

    // Check if we have files in the request
    // `.array()` uploads give an array; the map-shaped `.fields()` fallback is any-cast
    // so the common File[] branch keeps its `.originalname`/`.mimetype` type checking.
    /** @type {Express.Multer.File[]} */
    const files = reqFiles ? (Array.isArray(reqFiles) ? reqFiles : /** @type {any} */ ([reqFiles])) : [];

    if ((isFileTypeError || files.length > 0) && openai) {
      return buildUnsupportedFileErrorBody(files);
    }
  } catch (aiError) {
    logger.error('Error generating AI error response:', aiError);
  }
  return null;
}
