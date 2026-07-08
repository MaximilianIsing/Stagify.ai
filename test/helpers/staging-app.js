// Mounts the real staging router (routes/staging.js) on a bare Express app with
// fully faked dependencies, then listens on an ephemeral port. This exercises the
// actual route handlers — auth, parsing, response shaping, error mapping — with the
// AI swapped for deterministic fakes. No full server boot, no real API calls.

import express from 'express';
import createStagingRouter from '../../routes/staging.js';

const pass = (req, res, next) => next();

// Defaults every dep the router destructures so construction succeeds. Middleware
// deps (used at route-definition time) must be real functions; everything else is a
// harmless stub that individual tests override with a scripted fake.
export function baseDeps() {
  return {
    genAI: null,
    openai: null,
    genLimiter: pass,
    stagingProcessUpload: pass,
    pdfUpload: { single: () => pass },
    stagingEndpointKeyGuard: pass,
    PDF_PROCESSING_SERVER: '',
    DEBUG_MODE: false,
    MAX_MASK_PROMPT_LENGTH: 1000,
    MAX_SEGMENT_QUERY_LENGTH: 200,
    QUALITY_MAX_ATTEMPTS: 3,
    setSensitiveHeaders: () => {},
    getAuthUserFromRequest: () => null,
    enterpriseDomainForUser: () => null,
    getStagingClientIp: () => '203.0.113.1',
    isLikelyMobileStagingRequest: () => false,
    reportEnterpriseUsage: () => {},
    // Default: reject as unauthenticated (tests that need to get past it override this).
    requireProAccount: (req, res) => {
      res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
      return null;
    },
    logMaskEditToFile: () => {},
    getUserIdentifier: () => 'test',
    downscaleImage: async (b) => b,
    padBufferToAspectRatio: async (b) => b,
    buildMarkedRoomImage: async (b) => b,
    normalizeMaskOutputToRoom: async (b) => b,
    reviewMaskEdit: async () => ({ perfect: true, score: 1 }),
    compositeForReview: async (b) => b,
    generateWithQualityRetry: async () => { throw new Error('generateWithQualityRetry not stubbed for this test'); },
    maskReferencePromptSuffix: () => '', // handler calls this as a function (routes/staging.js)
    validateStageableImage: async () => ({ valid: true, reason: '' }),
    handleVirtualStagingMultipart: async (req, res) => res.json({ success: true, image: 'data:image/png;base64,AAAA' }),
  };
}

// Mount the router with `overrides` merged over the defaults; returns { baseUrl, close }.
export async function mountStaging(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(createStagingRouter({ ...baseDeps(), ...overrides }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
