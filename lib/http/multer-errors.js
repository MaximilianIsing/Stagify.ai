// The multer upload-error → HTTP mapping, extracted from server.js so the shipped
// mapping is the one under test.
//
// It has to be mounted AFTER the routers that use multer (Express only reaches error
// middleware registered after the throwing route) and BEFORE the Sentry handler, so an
// over-cap upload returns a clean 413 instead of being reported as a server error.
// server.js is still the only place that decides that ordering; this module only owns
// the mapping itself.
//
// Lives here rather than inline because the upload limits it reports on
// (lib/http/uploads.js) can only be exercised end to end through it: without the
// mapping a LIMIT_FILE_SIZE reaches Express's default handler as a 500, so a test that
// mounts a router with real multer would have to restate the mapping to assert on it,
// and a restated mapping is a second definition that drifts.
import multer from 'multer';
import { sendError } from './http-helpers.js';

/**
 * Express error middleware: turn a MulterError into the response the clients expect.
 *
 * Anything that is not a MulterError is passed straight on.
 * @type {import('express').ErrorRequestHandler}
 */
export const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'File too large', {
        code: 'FILE_TOO_LARGE',
        details: 'That file is too large. Please upload a smaller file.',
      });
    }
    // Fold the multer message into `error` itself — the staging client surfaces this
    // field to the user (app.js falls back to `error` when there's no `code` it
    // recognises), so the specific reason must stay in the primary string.
    return sendError(res, 400, err.message || 'Upload error', { code: err.code });
  }
  return next(err);
};
