// Virtual-staging multipart handler, lifted out of the composition root
// (server.js). Runs after `stagingProcessUpload` has filled req.files/req.body:
// enforces the free-tier daily cap, resolves model/variation/furniture inputs,
// optionally erases furniture once up front, stages every variation, meters
// enterprise usage, and shapes the JSON response.
//
// deps: { genAI, DEBUG_MODE, authStore, toPublicAuthUser, enterpriseDomainForUser,
//         reportEnterpriseUsage, recordStagingActivity, logRejectionToFile,
//         roomIsAlreadyEmpty, eraseFurniture, processStaging }
//   - processStaging comes from the createStagingGeneration factory, so this
//     factory must be instantiated AFTER it.
import { logger } from '../logger.js';
import { sendError } from '../http/http-helpers.js';
import { getGeminiImageModel, resolveChatModel } from '../config/model-config.js';
import { incPromptCount } from '../data/counters.js';

/**
 * Build the virtual-staging multipart handler. Runs after `stagingProcessUpload` has filled
 * req.files/req.body: enforces the free-tier daily cap, resolves model/variation/furniture
 * inputs, optionally erases furniture up front, stages every variation, meters enterprise
 * usage, and shapes the JSON response.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, DEBUG_MODE: boolean, authStore: any, toPublicAuthUser: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['toPublicAuthUser'], enterpriseDomainForUser: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['enterpriseDomainForUser'], reportEnterpriseUsage: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['reportEnterpriseUsage'], recordStagingActivity?: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['recordStagingActivity'], logRejectionToFile?: ReturnType<typeof import('../services/logging.js').createLogging>['logRejectionToFile'], roomIsAlreadyEmpty: (imageBuffer: Buffer) => Promise<boolean>, eraseFurniture: ReturnType<typeof import('../image/erase.js').createErase>['eraseFurniture'], processStaging: ReturnType<typeof import('./staging-generation.js').createStagingGeneration>['processStaging'], renderPersistence?: ReturnType<typeof import('./render-persistence.js').createRenderPersistence> | null }} deps - Injected Gemini client, debug flag, auth store + user shaper, enterprise-usage metering, the trial-activation signal, the empty-room check, the eraser, processStaging (from the createStagingGeneration factory — instantiate this AFTER it), and the optional gallery persistence (omit it and renders stay ephemeral, exactly as before).
 * @returns {{ handleVirtualStagingMultipart: (req: import('express').Request, res: import('express').Response, meta: import('../types/staging.js').VirtualStagingMeta) => Promise<import('express').Response | void> }} The virtual-staging handler API.
 */
export function createVirtualStagingHandler(deps) {
  const {
    genAI,
    DEBUG_MODE,
    authStore,
    toPublicAuthUser,
    enterpriseDomainForUser,
    reportEnterpriseUsage,
    roomIsAlreadyEmpty,
    eraseFurniture,
    processStaging,
    recordStagingActivity = () => false,
    logRejectionToFile = () => {},
    // The gallery. Optional so every existing caller and test is unaffected: without it
    // renders stay ephemeral exactly as before, which is also what happens in production
    // when R2 is not configured.
    renderPersistence = null,
  } = deps;

  /**
   * Virtual staging after `stagingProcessUpload` has filled `req.files` / `req.body`.
   * @param {import('express').Request} req - Express request (multipart already parsed into req.files/req.body).
   * @param {import('express').Response} res - Express response.
   * @param {import('../types/staging.js').VirtualStagingMeta} meta - Auth/usage context (user, recordUsage, treatAsPro).
   * @returns {Promise<import('express').Response | void>} Resolves after sending the staging JSON (void when it already responded with an error).
   */
  async function handleVirtualStagingMultipart(req, res, meta) {
    const mainFile = /** @type {Record<string, Express.Multer.File[]>} */ (req.files)?.image?.[0];
    if (!mainFile) {
      return sendError(res, 400, 'No image file provided');
    }

    if (!genAI) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    const user = meta.user;

    // Enforce the free-tier daily generation cap before doing any paid work. Pro
    // accounts are uncapped; enterprise-domain users are metered and billed
    // separately (reportEnterpriseUsage), so they are not subject to this cap.
    if (meta.recordUsage && user && user.plan === 'free' && !enterpriseDomainForUser(user)) {
      const status = authStore.freeGenerationStatus(user.id);
      if (!status.allowed) {
        // A free account hitting its ceiling is the clearest upgrade signal the
        // product has, and it used to write no row anywhere — the request never
        // reaches processStaging, so nothing logged it.
        logRejectionToFile('daily_limit', 'DAILY_LIMIT_REACHED', `${status.used}/${status.limit}`, {
          email: user.email, userId: user.id, req,
        });
        return res.status(429).json({
          error: `Daily free limit reached (${status.limit} generations/day). Resets at 00:00 UTC — or upgrade to Stagify+ for unlimited staging.`,
          code: 'DAILY_LIMIT_REACHED',
          dailyGenerationsUsed: status.used,
          dailyGenerationLimit: status.limit,
          user: toPublicAuthUser(user),
        });
      }
    }

    const {
      roomType = 'Living room',
      furnitureStyle = 'standard',
      additionalPrompt = '',
      removeFurniture = false,
      keepFurniture = '',
      userRole = 'unknown',
      userReferralSource = 'unknown',
      userEmail = 'unknown',
      model: gptModelRaw,
      variationCount: variationRaw,
    } = req.body;

    req.body.userRole = userRole;
    req.body.userReferralSource = userReferralSource;
    req.body.userEmail = userEmail;
    req.body.authenticatedEmail = user ? user.email : 'endpoint-key';

    const isPro = !!(meta.treatAsPro || (user && user.plan === 'pro'));
    // Free accounts are pinned to the fast model; pro accounts pick from the allow-list.
    const selectedModel = resolveChatModel(gptModelRaw, { isPro });

    let variationCount = parseInt(String(variationRaw || '1'), 10);
    if (Number.isNaN(variationCount)) variationCount = 1;
    variationCount = Math.min(3, Math.max(1, variationCount));
    if (!isPro) {
      variationCount = 1;
    }

    const furnitureFiles = isPro ? /** @type {Record<string, Express.Multer.File[]>} */ (req.files)?.furnitureImage : null;
    const furnitureBuffers =
      Array.isArray(furnitureFiles) && furnitureFiles.length > 0
        ? furnitureFiles.slice(0, 5).map((f) => f.buffer).filter(Boolean)
        : null;

    // "Remove existing furniture" is a Stagify+ / Enterprise feature (isPro already
    // covers enterprise-domain users, who are treated as pro here).
    const removeBool = !!(
      isPro &&
      (removeFurniture === true ||
        removeFurniture === 'true' ||
        removeFurniture === 'on'));

    // Two-stage removal stages every variation from one shared empty room, so we
    // cap output at a single image when furniture removal is on (matches the UI,
    // which hides the variations slider and pins it to 1).
    if (removeBool) variationCount = 1;

    const stagingParamsBase = {
      roomType,
      furnitureStyle,
      additionalPrompt,
      removeFurniture: removeBool,
    };

    const geminiModel = getGeminiImageModel(selectedModel);
    const images = [];

    // Two-stage removal: erase the furniture ONCE up front (not per-variation, so
    // a 3-variation job doesn't pay for 3 erases), then stage every variation from
    // the same empty room. On failure we fall back to the original single-pass
    // removal prompt by keeping removeFurniture true.
    let stageBaseBuffer = mainFile.buffer;
    let stageBaseParams = stagingParamsBase;
    let emptyRoomDataUrl = null;
    if (removeBool) {
      // Cheap GPT-vision pass first: if the room is already basically empty there's
      // no furniture to remove, so skip the erase entirely (saves a Gemini call).
      const alreadyEmpty = await roomIsAlreadyEmpty(mainFile.buffer);
      if (alreadyEmpty) {
        // Nothing to remove — and since removal is handled by the dedicated erase
        // stage (not here), tell the staging AI to ideally NOT remove furniture so
        // it just stages cleanly instead of re-running a "remove all furniture"
        // instruction on an already-empty room.
        stageBaseParams = { ...stagingParamsBase, removeFurniture: false };
        if (DEBUG_MODE) {
          logger.debug('[Erase] room already basically empty — skipping furniture-removal pass.');
        }
      } else {
        const keepInstruction = typeof keepFurniture === 'string' ? keepFurniture.trim().slice(0, 500) : '';
        const erased = await eraseFurniture(mainFile.buffer, req, keepInstruction);
        if (erased) {
          stageBaseBuffer = erased.buffer;
          emptyRoomDataUrl = erased.dataUrl;
          // The room is already empty — stage it cleanly instead of re-issuing the
          // "remove all furniture" instruction on an already-empty room.
          stageBaseParams = { ...stagingParamsBase, removeFurniture: false };
          if (DEBUG_MODE) {
            logger.debug('[Erase] furniture removed in pre-stage pass; staging from empty room.');
          }
        } else if (DEBUG_MODE) {
          logger.debug('[Erase] pre-stage erase unavailable; staging with single-pass removal prompt.');
        }
      }
    }

    // Variations are independent of one another — each stages the same base image
    // with its own prompt — so they run CONCURRENTLY. Serially, the paid tier was the
    // slowest path in the product: 3 variations × up to QUALITY_MAX_ATTEMPTS quality
    // attempts, each attempt a Gemini generation plus a vision QA review, all inside
    // one blocking request. Wall clock is now the slowest single variation rather than
    // the sum of all three. Promise.all preserves input order, so `images` stays in
    // variation order; the all-or-nothing error contract is unchanged (a rejection
    // still fails the whole request, which the router maps to its 422/500).
    // Captured by the onNative hook below, one slot per variation. Indexed by `v` rather
    // than pushed, because the variations run CONCURRENTLY — appending would record them
    // in completion order and silently mismatch each image with another's metadata.
    /** @type {({ buffer: Buffer } | null)[]} */
    const natives = new Array(variationCount).fill(null);

    const staged = await Promise.all(
      Array.from({ length: variationCount }, (_, v) => {
        let extra = additionalPrompt || '';
        if (v > 0) {
          extra += `\n\n(Subtle variation ${v + 1} of ${variationCount}: keep architecture identical to the source—same walls, windows, doors, ceiling, floor, and room geometry. Preserve the exact aspect ratio and full frame — do not crop or zoom. Change only virtual staging: slightly different furniture arrangement, decor, accents, textiles, or art. Same overall furniture style and mood as the main request; do not redesign the room.)`;
        }
        const stagingParams = {
          ...stageBaseParams,
          additionalPrompt: extra.trim(),
          // Grab the model's native output before processStaging upscales it away. Only
          // wired when the gallery is on, so nothing is decoded for nothing.
          onNative: renderPersistence?.enabled()
            ? (buffer) => { natives[v] = { buffer }; }
            : null,
        };
        return processStaging(
          stageBaseBuffer,
          stagingParams,
          req,
          furnitureBuffers && furnitureBuffers.length ? furnitureBuffers : null,
          geminiModel
        );
      })
    );
    for (const stagedImage of staged) {
      images.push(stagedImage);
      incPromptCount();
    }

    if (meta.recordUsage && user) {
      const entDomain = enterpriseDomainForUser(user);
      if (entDomain) {
        // Bill per staging generation attempt (initial + quality-gate retries),
        // which req._stagingGenerations accumulates across all variations. The
        // furniture-erase pass and its retries are deliberately excluded.
        reportEnterpriseUsage(entDomain, req._stagingGenerations || images.length || 1);
      } else if (user.plan === 'free') {
        authStore.recordFreeGeneration(user.id);
      } else {
        // Trial/paid activity signal for the trial-email sweep + the "you staged N
        // rooms" recap. The plan check lives inside the helper so every paid surface
        // (here, mask-edit, chat staging) agrees on what counts as activation.
        recordStagingActivity(user);
      }
    }

    // Save to the gallery. Rows synchronously (the free-tier cap has to be exact and
    // unraceable, so it runs inside the insert transaction); bytes afterwards, without
    // being awaited. The whole block is wrapped because a paid render must never fail
    // over a history feature — the client already has its image either way.
    let gallery = null;
    try {
      if (renderPersistence?.enabled() && user && natives.some(Boolean)) {
        const pending = renderPersistence.recordPending({
          user,
          isPro,
          natives: /** @type {{ buffer: Buffer }[]} */ (natives.filter(Boolean)),
          params: stagingParamsBase,
          model: geminiModel,
        });
        if (pending) {
          gallery = { ids: pending.entries.map((e) => e.id), evicted: pending.evicted };
          // Fire and forget. `uploadInBackground` cannot reject (see its header), and the
          // extra .catch is belt and braces because an unhandled rejection in Node 22
          // exits the process.
          void renderPersistence.uploadInBackground({
            entries: pending.entries,
            // The ORIGINAL upload, not the erased intermediate: the before/after slider
            // is only meaningful against the room the user actually photographed.
            sourceBuffer: mainFile.buffer,
            refUploads: furnitureBuffers?.map((buffer) => ({ buffer })) ?? [],
            user,
          }).catch(() => {});
        }
      }
    } catch (error) {
      logger.error('[gallery] could not start persistence; the render is unaffected:', error);
    }

    const updatedUser = user ? authStore.findUserByEmail(user.email) : null;
    const responseUser = updatedUser
      ? toPublicAuthUser(updatedUser)
      : user
        ? toPublicAuthUser(user)
        : null;

    if (images.length === 1) {
      return res.json({
        success: true,
        image: images[0],
        emptyRoom: emptyRoomDataUrl || undefined,
        user: responseUser,
        gallery: gallery || undefined,
      });
    }
    return res.json({
      success: true,
      images,
      image: images[0],
      emptyRoom: emptyRoomDataUrl || undefined,
      user: responseUser,
      gallery: gallery || undefined,
    });
  }

  return { handleVirtualStagingMultipart };
}
