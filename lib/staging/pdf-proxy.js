// POST /api/process-pdf handler, extracted verbatim from routes/staging.js.
//
// Proxies an uploaded PDF to the external PDF_PROCESSING_SERVER over https:
// builds the /process?<params> query from req.query, wraps req.file into
// form-data, streams the response back, and relays error statuses. The handler
// stays async and returns the inner Promise so createAsyncRouter still forwards
// rejections. The genLimiter + pdfUpload.single('pdf') middleware stay in the
// route registration.
//
// deps: { requireProAccount, PDF_PROCESSING_SERVER, DEBUG_MODE }
import https from 'https';
import FormData from 'form-data';
import { sendError } from '../http/http-helpers.js';
import { logger } from '../logger.js';

/**
 * Build the `POST /api/process-pdf` proxy handler that streams an uploaded PDF to
 * the external processing server and relays its response/error statuses back.
 * @param {{ requireProAccount: (req: import('express').Request, res: import('express').Response) => (any | null), PDF_PROCESSING_SERVER: string, DEBUG_MODE: boolean }} deps - Injected pro gate, external PDF-processing server base URL, and debug flag.
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<any>} The POST /api/process-pdf proxy Express handler.
 */
export function createProcessPdfHandler(deps) {
  const { requireProAccount, PDF_PROCESSING_SERVER, DEBUG_MODE } = deps;

  return async (req, res) => {
    try {
      if (!requireProAccount(req, res)) return;

      if (!req.file) {
        return sendError(res, 400, 'No PDF file provided');
      }

      // Get query parameters from request
      // Coerce to string: req.query values are `string | string[] | ParsedQs`, but
      // these are always scalar query params forwarded to URLSearchParams (which needs strings).
      const skip = String(req.query.skip || '4');
      const concurrency = String(req.query.concurrency || '2');
      const dpi = String(req.query.dpi || '110');
      const continueOnError = String(req.query.continue || 'false');
      const merge = String(req.query.merge || 'false');
      const filename = String(req.query.filename || req.file.originalname);

      // Build query parameters for external server
      const params = new URLSearchParams();
      params.append('skip', skip);
      params.append('concurrency', concurrency);
      params.append('dpi', dpi);
      if (continueOnError !== 'false') params.append('continue', continueOnError);
      if (merge !== 'false') params.append('merge', merge);
      if (filename) params.append('filename', filename);

      const urlPath = `/process?${params.toString()}`;
      const targetUrl = new URL(PDF_PROCESSING_SERVER);

      // Create FormData for the external server using form-data package
      const formData = new FormData();
      formData.append('pdf', req.file.buffer, {
        filename: req.file.originalname,
        contentType: 'application/pdf'
      });

      // Forward the request to the external server using https module
      if (DEBUG_MODE) {
        logger.debug(`Forwarding PDF processing request to ${PDF_PROCESSING_SERVER}${urlPath}`);
      }

      return new Promise((resolve, reject) => {
        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 443,
          path: urlPath,
          method: 'POST',
          headers: formData.getHeaders()
        };

        const proxyReq = https.request(options, (proxyRes) => {
          // Handle errors from proxy response
          if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
            let errorData = '';
            proxyRes.on('data', (chunk) => {
              errorData += chunk.toString();
            });
            proxyRes.on('end', () => {
              try {
                const parsedError = JSON.parse(errorData);
                res.status(proxyRes.statusCode).json({
                  error: parsedError.message || parsedError.error || `Server error: ${proxyRes.statusCode}`,
                  ...parsedError
                });
              } catch {
                sendError(res, proxyRes.statusCode, errorData || `Server error: ${proxyRes.statusCode}`);
              }
              resolve(undefined);
            });
            return;
          }

          // Set status code for successful response
          res.status(proxyRes.statusCode || 200);

          // Copy headers from proxy response (skip problematic ones)
          Object.keys(proxyRes.headers).forEach(key => {
            const lowerKey = key.toLowerCase();
            // Skip headers that shouldn't be forwarded or will be set manually
            if (lowerKey !== 'content-encoding' &&
                lowerKey !== 'transfer-encoding' &&
                lowerKey !== 'connection' &&
                lowerKey !== 'content-length') {
              try {
                res.setHeader(key, proxyRes.headers[key]);
              } catch (err) {
                // Ignore header setting errors
                logger.warn(`Could not set header ${key}:`, err.message);
              }
            }
          });

          // Ensure Content-Type is set for PDF
          if (!res.getHeader('content-type')) {
            res.setHeader('Content-Type', 'application/pdf');
          }

          // Set Content-Disposition for download
          if (filename) {
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          }

          // Handle proxy response errors
          proxyRes.on('error', (err) => {
            logger.error('Proxy response error:', err);
            if (!res.headersSent) {
              sendError(res, 500, 'Error receiving response from PDF server', { details: err.message });
            }
            resolve(undefined);
          });

          // Stream the response from proxy to client
          proxyRes.pipe(res);

          proxyRes.on('end', () => {
            resolve(undefined);
          });
        });

        proxyReq.on('error', (error) => {
          logger.error('Proxy request error:', error);
          if (!res.headersSent) {
            sendError(res, 500, 'PDF processing failed', { details: error.message });
          }
          reject(error);
        });

        // Pipe form data to the proxy request
        formData.pipe(proxyReq);

        formData.on('error', (error) => {
          logger.error('FormData error:', error);
          proxyReq.destroy();
          if (!res.headersSent) {
            sendError(res, 500, 'PDF processing failed', { details: error.message });
          }
          reject(error);
        });
      });

    } catch (error) {
      logger.error('Error processing PDF:', error);
      if (!res.headersSent) {
        return sendError(res, 500, 'PDF processing failed', { details: error.message });
      }
    }
  };
}
