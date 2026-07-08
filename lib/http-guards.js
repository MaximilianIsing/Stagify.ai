// Endpoint access guards + health check. The factory injects the access key, the
// constant-time comparator, and the Gemini client (health only reports whether it
// is configured). Note protectLogs and stagingEndpointKeyGuard differ on purpose:
// protectLogs is header-only + constant-time; the staging guard also accepts
// ?key= and uses a plain compare. Extracted verbatim from server.js.
import { setSensitiveHeaders } from './http-helpers.js';

export function createHttpGuards({ genAI, LOGS_ACCESS_KEY, endpointKeyMatches }) {
  const healthHandler = (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      aiConfigured: !!genAI,
    });
  };

  // Middleware to protect logs endpoints with password
  function protectLogs(req, res, next) {
    setSensitiveHeaders(res);
    if (!LOGS_ACCESS_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Logs access key not configured'
      });
    }

    // Read the key from a header only — never the query string. A key in the URL
    // leaks via access logs, reverse-proxy logs, browser history, and Referer.
    const accessKey = req.get('X-Stagify-Endpoint-Key');
    if (accessKey && endpointKeyMatches(accessKey, LOGS_ACCESS_KEY)) {
      return next();
    }
    return res.status(403).json({
      error: 'Access denied',
      message: 'Valid access key required in the X-Stagify-Endpoint-Key header'
    });
  }

  /** Same `LOGS_ACCESS_KEY` as `/promptlogs`, `/api/send-email`, etc. */
  function stagingEndpointKeyGuard(req, res, next) {
    if (!LOGS_ACCESS_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Endpoint access key not configured',
      });
    }
    const q = req.query && req.query.key;
    const h = req.headers['x-stagify-endpoint-key'];
    const k = (typeof q === 'string' && q) || (typeof h === 'string' && h.trim());
    if (k && k === LOGS_ACCESS_KEY) {
      return next();
    }
    return res.status(403).json({
      error: 'Access denied',
      message: 'Valid endpoint key required (?key= on URL or X-Stagify-Endpoint-Key header)',
    });
  }

  return { healthHandler, protectLogs, stagingEndpointKeyGuard };
}
