// Endpoint access guards + health check. The factory injects the access key, the
// constant-time comparator, and the Gemini client (health only reports whether it
// is configured). protectLogs and stagingEndpointKeyGuard are deliberately aligned:
// both are header-only (never ?key= — a key in the URL leaks via access logs,
// reverse-proxy logs, browser history, and Referer) and compare the secret with the
// constant-time endpointKeyMatches. Originally extracted from server.js.
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
    setSensitiveHeaders(res);
    if (!LOGS_ACCESS_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Endpoint access key not configured',
      });
    }
    // Header-only + constant-time, mirroring protectLogs. A key supplied in ?key=
    // is refused — it would leak via access logs, reverse-proxy logs, browser
    // history, and Referer. (The header is trimmed for tolerance of padded values;
    // the hash-then-timingSafeEqual compare keeps that safe.)
    const accessKey = (req.get('X-Stagify-Endpoint-Key') || '').trim();
    if (accessKey && endpointKeyMatches(accessKey, LOGS_ACCESS_KEY)) {
      return next();
    }
    return res.status(403).json({
      error: 'Access denied',
      message: 'Valid access key required in the X-Stagify-Endpoint-Key header',
    });
  }

  return { healthHandler, protectLogs, stagingEndpointKeyGuard };
}
