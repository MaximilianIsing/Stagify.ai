// Exterior Studio multipart handler — the curb-appeal tool's request path.
//
// Runs after `stagingProcessUpload` has filled req.files/req.body, and after the router
// has already established a Stagify+ account via requireProAccount.
//
// HOW THIS DIFFERS FROM virtual-staging-handler.js, AND WHY IT IS A SEPARATE FILE
// That handler's body is almost entirely branches this feature does not have: the
// free-tier daily cap (this is Pro-only, so there is no free tier to cap), the
// variation fan-out, the pro-gated furniture references, and the two-stage furniture
// erase. Threading an `exterior` flag through all four would leave one function where
// most of the code is unreachable on either path. What the two DO share — the metering
// rules and the gallery's two-phase persistence — is copied deliberately and marked, so
// the next change to either can find both sites.
//
// deps: { genAI, DEBUG_MODE, authStore, toPublicAuthUser, enterpriseDomainForUser,
//         reportEnterpriseUsage, recordStagingActivity, validateExteriorImage,
//         processStaging, renderPersistence }
//   - processStaging comes from the createStagingGeneration factory, so this factory
//     must be instantiated AFTER it.
import { logger } from '../logger.js';
import { sendError } from '../http/http-helpers.js';
import { readStampRequest } from '../image/stamp-disclosure.js';
import { getGeminiImageModel, resolveChatModel, PLUS_MODEL } from '../config/model-config.js';
import { incPromptCount } from '../data/counters.js';
import {
  buildExteriorPrompt, describeExteriorRequest, describeExteriorQualifier,
} from './exterior-prompts.js';

// Ceiling on the free-text box. Matches the `keepFurniture` clamp on the interior path
// rather than the 1000 mask-edit allows: this field is captioned "anything else?" and
// takes a phrase, and every character of it lands in a prompt that the preservation
// block then has to outrank.
const MAX_EXTERIOR_PROMPT_LENGTH = 500;

// The roomType recorded for an exterior render. Not a promptMatrix key and never looked
// up as one — promptOverride means generatePrompt is never called here. It exists purely
// as the label in prompt_logs.csv and the gallery row, so exterior renders are
// distinguishable from the eight real room types without a schema change.
const EXTERIOR_ROOM_LABEL = 'Exterior';

/** Multipart carries booleans as strings; a checkbox posts 'on'. */
const truthy = (v) => v === true || v === 'true' || v === 'on';

/**
 * Build the Exterior Studio multipart handler. Runs after `stagingProcessUpload` has
 * filled req.files/req.body and after the router has established a Stagify+ account:
 * pre-checks the upload is an exterior, enhances it, meters usage, saves to the gallery,
 * and shapes the JSON response.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, DEBUG_MODE?: boolean, authStore: any, toPublicAuthUser: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['toPublicAuthUser'], enterpriseDomainForUser: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['enterpriseDomainForUser'], reportEnterpriseUsage: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['reportEnterpriseUsage'], recordStagingActivity?: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['recordStagingActivity'], validateExteriorImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, code: string | null, reason: string }>, processStaging: ReturnType<typeof import('./staging-generation.js').createStagingGeneration>['processStaging'], renderPersistence?: ReturnType<typeof import('./render-persistence.js').createRenderPersistence> | null }} deps - Injected Gemini client, debug flag, auth store + user shaper, enterprise-usage metering, the trial-activation signal, the exterior upload gate, processStaging (from the createStagingGeneration factory — instantiate this AFTER it), and the optional gallery persistence.
 * @returns {{ handleExteriorMultipart: (req: import('express').Request, res: import('express').Response, user: any) => Promise<import('express').Response | void> }} The Exterior Studio handler API.
 */
export function createExteriorHandler(deps) {
  const {
    genAI,
    DEBUG_MODE = false,
    authStore,
    toPublicAuthUser,
    enterpriseDomainForUser,
    reportEnterpriseUsage,
    validateExteriorImage,
    processStaging,
    recordStagingActivity = () => false,
    // Optional for the same reason as on the interior path: without it renders stay
    // ephemeral, which is also what happens in production when R2 is not configured.
    renderPersistence = null,
  } = deps;

  /**
   * Enhance one exterior photo after `stagingProcessUpload` has filled `req.files`.
   * @param {import('express').Request} req - Express request (multipart already parsed into req.files/req.body).
   * @param {import('express').Response} res - Express response.
   * @param {any} user - The Stagify+ account, already established by requireProAccount.
   * @returns {Promise<import('express').Response | void>} Resolves after sending the JSON.
   */
  async function handleExteriorMultipart(req, res, user) {
    const mainFile = /** @type {Record<string, Express.Multer.File[]>} */ (req.files)?.image?.[0];
    if (!mainFile) {
      return sendError(res, 400, 'No image file provided');
    }
    if (!genAI) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    const {
      timeOfDay = 'keep',
      sky = 'keep',
      removeVehicles,
      removeClutter,
      removePeople,
      removeSnow,
      removeWetWeather,
      removeLeaves,
      additionalPrompt = '',
      labelVirtuallyStaged,
      stampLang = '',
      stampStyle = '',
      stampScale = '',
      userRole = 'unknown',
      userReferralSource = 'unknown',
      userEmail = 'unknown',
      model: gptModelRaw,
    } = req.body;

    req.body.userRole = userRole;
    req.body.userReferralSource = userReferralSource;
    req.body.userEmail = userEmail;
    req.body.authenticatedEmail = user ? user.email : 'unknown';

    const options = {
      timeOfDay,
      sky,
      removeVehicles: truthy(removeVehicles),
      removeClutter: truthy(removeClutter),
      removePeople: truthy(removePeople),
      removeSnow: truthy(removeSnow),
      removeWetWeather: truthy(removeWetWeather),
      removeLeaves: truthy(removeLeaves),
      additionalPrompt: typeof additionalPrompt === 'string'
        ? additionalPrompt.trim().slice(0, MAX_EXTERIOR_PROMPT_LENGTH)
        : '',
    };

    // Pre-check BEFORE generating, not concurrently from the browser as the interior
    // studios do. That dance exists because /api/process-image is the slow path and the
    // client can abort it mid-flight; here one flash-lite vision call is a rounding error
    // against a Gemini image generation with up to three quality-gate retries, and doing
    // it server-side means there is no window in which a rejected upload is already
    // costing money. Fails open, like every other reviewer.
    const check = await validateExteriorImage(mainFile.buffer);
    if (!check.valid) {
      return sendError(res, 422, check.reason, { code: check.code || 'UNSTAGEABLE' });
    }

    // Stagify+ only, so isPro is a given — but the model still resolves through the
    // security clamp rather than reading req.body.model, which must never reach a
    // provider directly.
    //
    // The DEFAULT is the plus model, unlike every other staging surface. resolveChatModel
    // falls back to FAST_MODEL when a request names nothing, which is right where free
    // accounts share the endpoint and the client picks explicitly. Here nobody free can
    // reach the route and there is no model picker in the UI, so inheriting that default
    // would quietly render every paying customer's photo on the cheap model. A tampered
    // value still degrades to fast rather than erroring.
    const geminiModel = getGeminiImageModel(resolveChatModel(gptModelRaw || PLUS_MODEL, { isPro: true }));
    const summary = describeExteriorRequest(options);

    // "Label as virtually staged" — the same control, the same wire fields and the same
    // validator as the interior path, because it is the same question. Multipart delivers
    // every field as a string ('true', not true), which readStampRequest already expects.
    //
    // It is NOT one of the `options` above and must never become one. Those describe what
    // to CHANGE about the property, and every one of them reaches buildExteriorPrompt; the
    // badge is a property of the delivered FILE and never goes near the model. Folding it in
    // would put "label as virtually staged" into a prompt whose preservation block exists to
    // stop the model editing anything it was not asked to.
    //
    // NAR Article 12 applies to a relit facade exactly as it does to a staged room — an
    // enhanced exterior is still an altered photograph of the property — so this is read with
    // no plan check of its own. The route is already Stagify+ only; that is the paywall, and
    // the disclosure must not have a second one behind it.
    const stamp = readStampRequest({ labelVirtuallyStaged, stampLang, stampStyle, stampScale });

    /** @type {{ buffer: Buffer } | null} */
    let native = null;

    const image = await processStaging(
      mainFile.buffer,
      {
        // The whole prompt, built here — there is no room type and no furniture style to
        // look up, so generatePrompt() is bypassed entirely.
        promptOverride: buildExteriorPrompt(options),
        // No `reviewBasePrompt` here, deliberately. It used to pass an exterior QA rubric on
        // the theory that it was "what a retry would judge against if the gate is ever
        // switched back on" — but `skipQualityReview` below short-circuits in
        // staging-generation.js before the rubric is read, so it never reached a model and
        // could never have been wrong in a way anyone would notice. Switching the gate back on
        // means writing a rubric then, against what this edit actually produces.
        //
        // One generation, no vision review, no reshoot. Interior staging invents a room
        // and can invent it badly, so scoring three attempts buys something real. This
        // path edits a photograph the user supplied: a second roll gives them a different
        // sky, not a better one, while tripling both the bill and the wait on the request
        // they are sitting and watching.
        skipQualityReview: true,
        roomType: EXTERIOR_ROOM_LABEL,
        furnitureStyle: '',
        // Read by processStaging for the reviewer's "the user's request was …" clause and
        // for the CSV row. It does NOT reach the prompt: promptOverride already won.
        additionalPrompt: summary,
        removeFurniture: false,
        // Burned in by processStaging after the (skipped) quality gate and before BOTH the
        // onNative hook and the delivery upscale — so one flag labels the photo the user
        // downloads AND the gallery master, and the two cannot disagree. See the comment at
        // that call site; the position is load-bearing.
        labelVirtuallyStaged: stamp.enabled,
        stampLang: stamp.lang,
        stampStyle: stamp.style,
        stampScale: stamp.scale,
        onNative: renderPersistence?.enabled()
          ? (buffer) => { native = { buffer }; }
          : null,
      },
      req,
      null,
      geminiModel,
    );
    incPromptCount();

    // Metering, mirroring lib/staging/virtual-staging-handler.js — the free branch is
    // absent because this route is Pro-only, but the other two must agree with it.
    // Quantity is req._stagingGenerations (initial attempt + quality-gate retries), which
    // processStaging accumulates, because a retry is a real generation that really cost
    // money.
    const entDomain = enterpriseDomainForUser(user);
    if (entDomain) {
      reportEnterpriseUsage(entDomain, req._stagingGenerations || 1);
    } else {
      recordStagingActivity(user);
    }

    // Gallery — the same two-phase call as the interior path: rows synchronously so the
    // cap is unraceable, bytes afterwards without being awaited. Wrapped whole because a
    // paid render must never fail over a history feature; the client has its image either
    // way.
    let gallery = null;
    try {
      if (renderPersistence?.enabled() && user && native) {
        const pending = renderPersistence.recordPending({
          user,
          isPro: true,
          natives: [native],
          params: {
            roomType: EXTERIOR_ROOM_LABEL,
            furnitureStyle: '',
            additionalPrompt: summary,
            removeFurniture: false,
          },
          // What this render is CALLED. Without a qualifier every exterior entry in the
          // gallery derived the same single word, "Exterior", because the row carries no
          // furniture style and a fixed room label — see public/scripts/render-name.js.
          extra: {
            source: 'exterior',
            qualifier: describeExteriorQualifier(options),
            sourceName: mainFile.originalname,
          },
          model: geminiModel,
        });
        if (pending) {
          gallery = { ids: pending.entries.map((e) => e.id), evicted: pending.evicted, tier: 'pro' };
          void renderPersistence.uploadInBackground({
            entries: pending.entries,
            sourceBuffer: mainFile.buffer,
            refUploads: [],
            user,
          }).catch(() => {});
        }
      }
    } catch (error) {
      logger.error('[gallery] could not start persistence; the render is unaffected:', error);
    }

    if (DEBUG_MODE) {
      logger.debug(`[Exterior] enhanced one photo with ${geminiModel}: ${summary}`);
    }

    const updatedUser = user ? authStore.findUserByEmail(user.email) : null;
    return res.json({
      success: true,
      image,
      user: updatedUser ? toPublicAuthUser(updatedUser) : (user ? toPublicAuthUser(user) : null),
      gallery: gallery || undefined,
    });
  }

  return { handleExteriorMultipart };
}
