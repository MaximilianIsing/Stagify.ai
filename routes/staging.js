// staging routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import https from 'https';
import sharp from 'sharp';
import FormData from 'form-data';
import { logger } from '../lib/logger.js';

export default function createStagingRouter(deps) {
  const { genAI, openai, genLimiter, stagingProcessUpload, pdfUpload, PDF_PROCESSING_SERVER, DEBUG_MODE, MAX_MASK_PROMPT_LENGTH, MAX_SEGMENT_QUERY_LENGTH, QUALITY_MAX_ATTEMPTS, setSensitiveHeaders, getAuthUserFromRequest, enterpriseDomainForUser, reportEnterpriseUsage, requireProAccount, logMaskEditToFile, getUserIdentifier, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview, generateWithQualityRetry, maskReferencePromptSuffix, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard } = deps;
  const router = createAsyncRouter();

router.post('/api/process-image', genLimiter, stagingProcessUpload, async (req, res) => {
  try {
    const sessionUser = getAuthUserFromRequest(req);

    if (!sessionUser) {
      return sendError(res, 401, 'Please sign in to stage images', { code: 'AUTH_REQUIRED' });
    }

    await handleVirtualStagingMultipart(req, res, {
      user: sessionUser,
      recordUsage: true,
      treatAsPro: false,
    });
  } catch (error) {
    logger.error('Error processing image:', error);
    if (error.code === 'NO_IMAGE_GENERATED') {
      return sendError(res, 422, 'This image couldn\'t be staged. Please try a different photo of an interior room.', {
        code: 'NO_IMAGE_GENERATED',
      });
    }
    return sendError(res, 500, 'Image processing failed', { details: error.message });
  }
});

router.post('/api/validate-image', genLimiter, async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string' || !image.includes(',')) {
      return sendError(res, 400, 'Image is required');
    }
    // No reviewer configured → nothing to validate against, let it through.
    if (!openai) {
      return res.json({ valid: true, reason: '' });
    }
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      if (!imageBuffer || imageBuffer.length === 0) throw new Error('empty buffer');
    } catch {
      return sendError(res, 400, 'Invalid image data');
    }
    const { valid, reason } = await validateStageableImage(imageBuffer);
    setSensitiveHeaders(res);
    return res.json({ valid, reason: valid ? '' : reason });
  } catch (error) {
    logger.error('Error validating image:', error);
    // Fail open — never block a real upload because our check errored.
    return res.json({ valid: true, reason: '' });
  }
});

router.post('/api/process-pdf', genLimiter, pdfUpload.single('pdf'), async (req, res) => {
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
});

router.post('/api/stage-by-endpoint-key', stagingEndpointKeyGuard, stagingProcessUpload, async (req, res) => {
  try {
    await handleVirtualStagingMultipart(req, res, {
      user: null,
      recordUsage: false,
      treatAsPro: true,
    });
  } catch (error) {
    logger.error('Error in stage-by-endpoint-key:', error);
    if (!res.headersSent) {
      return sendError(res, 500, 'Image processing failed', { details: error.message });
    }
  }
});

router.post('/api/mask-edit', genLimiter, async (req, res) => {
  try {
    const proUser = requireProAccount(req, res);
    if (!proUser) return;

    if (!genAI) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    const { image, mask, prompt, model, referenceImage, seed, batch } = req.body;

    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!image || !mask || !trimmedPrompt) {
      return sendError(res, 400, 'Image, mask, and prompt are required');
    }
    if (trimmedPrompt.length > MAX_MASK_PROMPT_LENGTH) {
      return sendError(res, 400, `Prompt is too long (max ${MAX_MASK_PROMPT_LENGTH} characters)`);
    }

    // Optional reproducibility seed — passed through to Gemini best-effort (the
    // image models make no determinism promise, but the request accepts it).
    // `batch` is the multi-area client's hint of how many sibling requests this
    // click fanned out into; big batches get a trimmed quality-retry budget so
    // one click can't cascade into batch × 3 Gemini generations.
    // Wrap into int32 range — Gemini rejects seeds outside [0, 2^31-1], and the
    // per-attempt +1 shift below must not overflow either.
    const seedBase = Number.isInteger(seed)
      ? ((seed % 0x7fffffff) + 0x7fffffff) % 0x7fffffff
      : null;
    const batchSize = Number.isInteger(batch) ? Math.max(1, Math.min(6, batch)) : 1;
    const maxQualityAttempts = batchSize >= 3 ? 2 : QUALITY_MAX_ATTEMPTS;

    // Get model from request or default to fast model
    const selectedModel = model || 'gpt-4o-mini';
    // Masking always uses the 2.5-flash image model regardless of selected tier
    const geminiModel = 'gemini-2.5-flash-image';

    // Convert base64 data URLs to buffers
    const imageDataUrl = image.split(',');
    const maskDataUrl = mask.split(',');
    
    let imageBuffer = Buffer.from(imageDataUrl[1], 'base64');
    let maskBuffer = Buffer.from(maskDataUrl[1], 'base64');

    // Downscale image if needed (Gemini has size limits)
    imageBuffer = await downscaleImage(imageBuffer);
    const imageBase64 = imageBuffer.toString('base64');
    
    // Process mask to match image size
    const imageMetadata = await sharp(imageBuffer).metadata();
    const maskMetadata = await sharp(maskBuffer).metadata();
    
    // Resize mask to match image dimensions exactly
    const resizedMaskBuffer = await sharp(maskBuffer)
      .resize(imageMetadata.width, imageMetadata.height, {
        fit: 'fill'
      })
      .png()
      .toBuffer();
    
    const maskBase64 = resizedMaskBuffer.toString('base64');

    if (DEBUG_MODE) {
      logger.debug('[Mask Edit] Processing masked image edit with Gemini');
      logger.debug('[Mask Edit] Prompt:', trimmedPrompt);
      logger.debug('[Mask Edit] Image size:', imageMetadata.width, 'x', imageMetadata.height);
      logger.debug('[Mask Edit] Mask size:', maskMetadata.width, 'x', maskMetadata.height, '(resized to match image)');
    }

    // LOCATION CUE: instead of a separate B/W mask (which Gemini aligns to the room
    // poorly), hand it the SAME room with the target area highlighted in translucent
    // magenta. Gemini generates from the clean room (image 1) and uses the highlighted
    // copy (image 2) only to see WHERE to apply the edit — much stronger spatial
    // grounding. Falls back to the plain B/W mask if the overlay can't be built.
    let locatorBase64 = maskBase64;
    let locatorMarked = false;
    try {
      const markedRoom = await buildMarkedRoomImage(imageBuffer, resizedMaskBuffer, imageMetadata.width, imageMetadata.height);
      locatorBase64 = markedRoom.toString('base64');
      locatorMarked = true;
    } catch (markErr) {
      logger.warn('[Mask Edit] Could not build highlighted room; falling back to B/W mask:', markErr.message);
    }
    const loc = locatorMarked
      ? { second: 'the SAME room with the target area OUTLINED by a bright magenta line', region: 'the area inside the magenta outline', boundary: 'the magenta outline', guide: ' The magenta outline ONLY marks the boundary of where to edit — it is NOT part of the room. Do NOT draw the magenta line, and NEVER fill any area with magenta or paint a magenta patch, anywhere in your output.' }
      : { second: 'a white mask marking the area to change', region: 'the white masked region', boundary: 'the white boundary', guide: '' };

    // Enhance the prompt to ensure only the masked area is edited
    let enhancedPrompt = `${trimmedPrompt}. CRITICAL INSTRUCTIONS: The FIRST image is the room to edit — produce your result as an edited version of that exact photo. The SECOND image is ${loc.second}, showing you EXACTLY where to apply the change.${loc.guide} Make the requested change ONLY inside ${loc.region}, and do NOT change anything outside it. Preserve the exact room layout, all furniture positions, wall colors, windows, doors, flooring, lighting, and every other detail exactly as they appear in the first image. Within ${loc.region}, make ONLY the change described — do NOT erase, delete, or strip out existing furniture, fixtures, windows, decor, or architectural features unless the instruction explicitly asks you to remove them, and never leave a blank wall, empty floor, or featureless void where content existed. The edit must blend seamlessly with the unchanged surroundings. Do NOT change the image aspect ratio, canvas size, orientation, or framing — the output must match the first image's dimensions exactly. WHEN THE INSTRUCTION ADDS OR PLACES A NEW OBJECT (furniture, decor, a fixture, a plant, lighting, etc.): the ENTIRE object — including its legs, arms, back, any overhang, and its contact shadow — MUST fit COMPLETELY INSIDE ${loc.region}, leaving a small margin between the object and ${loc.boundary}. SCALE THE OBJECT DOWN as much as needed so it sits fully within ${loc.region} — a smaller, fully-contained object is REQUIRED. NEVER let any part of the object reach, touch, or cross ${loc.boundary}: anything outside that area is discarded, so an object that extends past it will look cut off, sliced, or faded. Center and size the object so none of it is clipped and it reads as a complete, naturally placed item placed in the exact spot you were shown.`;

    let referenceInline = null;
    if (referenceImage && typeof referenceImage === 'string' && referenceImage.includes(',')) {
      logger.info('[Mask Edit] Reference photo received from client');
      try {
        const refB64 = referenceImage.slice(referenceImage.indexOf(',') + 1);
        // Typed as the general `Buffer` (ArrayBufferLike) so sharp's `.toBuffer()` result,
        // which is `Buffer<ArrayBufferLike>`, can be reassigned without a generic mismatch.
        /** @type {Buffer} */
        let refBuffer = Buffer.from(refB64, 'base64');
        if (!refBuffer || refBuffer.length === 0) throw new Error('empty reference buffer');
        refBuffer = await downscaleImage(refBuffer);
        // Normalize to PNG so the bytes ALWAYS match the declared MIME (downscaleImage
        // may have re-encoded to JPEG) and the format is one Gemini reliably accepts.
        // PNG preserves any transparency — a cut-out furniture reference is the cleanest
        // possible subject. This sharp pass also validates the payload is a real,
        // decodable image — if it isn't, it throws and we continue without a reference.
        refBuffer = await sharp(refBuffer).png().toBuffer();
        let refMeta = await sharp(refBuffer).metadata();
        // Letterbox the reference to the ROOM's aspect ratio with transparent
        // padding, so EVERY image sent to Gemini (room, highlighted room, reference) shares one
        // aspect ratio. Mixed input aspect ratios make the model emit its output at
        // a different aspect ratio; that output can't be composited back onto the
        // original, so the inserted furniture ends up mis-scaled and "doesn't fit".
        try {
          const roomAR = imageMetadata.width / imageMetadata.height;
          const padded = await padBufferToAspectRatio(refBuffer, roomAR);
          if (padded.padded) {
            refBuffer = padded.buffer;
            refMeta = await sharp(refBuffer).metadata();
          }
        } catch (padErr) {
          logger.warn('[Mask Edit] Reference aspect-ratio match failed; sending reference as-is:', padErr.message);
        }
        referenceInline = { mimeType: 'image/png', data: refBuffer.toString('base64') };
        enhancedPrompt += maskReferencePromptSuffix();
        logger.info(
          `[Mask Edit] Reference photo attached for Gemini — ${refMeta.width || '?'}×${refMeta.height || '?'} png, matched to room AR ${imageMetadata.width}×${imageMetadata.height} (${Math.round(refBuffer.length / 1024)} KB)`
        );
      } catch (refErr) {
        referenceInline = null;
        logger.warn('[Mask Edit] Reference photo received but failed to process; continuing without it:', refErr.message);
      }
    } else if (referenceImage) {
      logger.warn('[Mask Edit] referenceImage field present but invalid (expected data URL string)');
    }

    // Build the prompt with image and mask
    const geminiPrompt = [
      { 
        text: enhancedPrompt 
      },
      {
        inlineData: {
          mimeType: "image/png",
          data: imageBase64,
        },
      },
      {
        inlineData: {
          mimeType: "image/png",
          data: locatorBase64,
        },
      },
    ];
    if (referenceInline) {
      geminiPrompt.push({ inlineData: referenceInline });
    }

    if (DEBUG_MODE) {
      logger.debug('[Mask Edit] Using Gemini model:', geminiModel, '(selected model:', selectedModel, ')');
      logger.debug('[Mask Edit] Gemini input parts:', geminiPrompt.length, '(text + room + ' + (locatorMarked ? 'highlighted-room' : 'mask') + (referenceInline ? ' + reference)' : ')'));
    }

    // Generate with the same GPT-vision quality gate the main staging uses, but
    // with a mask-aware reviewer that also rejects edits which removed too much.
    // Review each result, regenerate on obvious mistakes, up to 3 attempts total,
    // returning the first perfect result or the best-scoring one.
    const originalForReview = `data:image/png;base64,${imageBase64}`;
    let maskGenerations = 0;
    const editedImageDataUrl = await generateWithQualityRetry(async (attempt) => {
      // Seed shifts per attempt: if a quality retry fires, an identical seed
      // would just re-court the same rejected output.
      const modelInstance = genAI.getGenerativeModel({
        model: geminiModel,
        ...(seedBase !== null ? { generationConfig: { seed: (seedBase + attempt - 1) % 0x7fffffff } } : {}),
      });
      const result = await modelInstance.generateContent(geminiPrompt);
      const response = await result.response;

      if (!response || !response.candidates || response.candidates.length === 0) {
        throw new Error('Gemini processing failed - no results generated');
      }

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          // Lock the output to the room's aspect ratio before it reaches the client
          // composite (which stretches it onto the original canvas) — otherwise a
          // drifted AR warps the edit out of alignment with the surroundings.
          return await normalizeMaskOutputToRoom(part.inlineData.data, imageMetadata.width, imageMetadata.height);
        }
      }

      throw new Error('No image data in Gemini response');
    }, 'mask-edit', () => {
      // Meter every attempt (initial + quality-gate retries) for enterprise usage.
      maskGenerations += 1;
    }, async (editedUrl) => {
      // Review the COMBINED result (original + edit composited through the mask),
      // i.e. what the user actually gets — so outside-mask drift never causes a
      // false reject and the "removed too much" check reflects the real outcome.
      const combined = await compositeForReview(
        imageBuffer, resizedMaskBuffer, editedUrl, imageMetadata.width, imageMetadata.height
      );
      return reviewMaskEdit(originalForReview, combined, {
        instruction: trimmedPrompt,
        locatorDataUrl: `data:image/png;base64,${locatorBase64}`,
        locatorMarked,
        referenceDataUrl: referenceInline ? `data:${referenceInline.mimeType};base64,${referenceInline.data}` : null,
      });
    }, maxQualityAttempts);

    if (DEBUG_MODE) {
      logger.debug('[Mask Edit] Successfully generated edited image with Gemini');
      try {
        const outMeta = await sharp(Buffer.from(editedImageDataUrl.split(',')[1], 'base64')).metadata();
        logger.debug(`[Mask Edit] Model output ${outMeta.width}×${outMeta.height} vs room ${imageMetadata.width}×${imageMetadata.height}${referenceInline ? ' (reference used)' : ''}`);
      } catch { /* debug-only metadata; ignore logging failures */ }
    }

    // Log the mask edit request
    const userId = getUserIdentifier(req);
    logMaskEditToFile(trimmedPrompt, selectedModel, geminiModel, imageMetadata.width, imageMetadata.height, userId, req);

    const entDomain = enterpriseDomainForUser(proUser);
    if (entDomain) {
      reportEnterpriseUsage(entDomain, maskGenerations || 1);
    }

    return res.json({
      success: true,
      editedImage: editedImageDataUrl,
      referenceUsed: Boolean(referenceInline),
    });

  } catch (error) {
    logger.error('Error processing mask edit:', error);
    return sendError(res, 500, 'Failed to process masked edit', { details: error.message });
  }
});

router.post('/api/segment', genLimiter, async (req, res) => {
  try {
    const proUser = requireProAccount(req, res);
    if (!proUser) return;

    if (!genAI) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    const { image, query } = req.body;
    if (!image || typeof image !== 'string' || !image.includes(',')) {
      return sendError(res, 400, 'Image is required');
    }
    const trimmedQuery = typeof query === 'string' ? query.trim().slice(0, MAX_SEGMENT_QUERY_LENGTH) : '';

    // Google's own segmentation sample sends ~1024px — plenty for masks, and
    // normalized coordinates map back onto any resolution. The sharp pass also
    // validates the payload is a real, decodable image.
    const rawBuffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    let imageBuffer;
    try {
      imageBuffer = await sharp(rawBuffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch {
      return sendError(res, 400, 'Invalid image data');
    }

    // Boxes only — no segmentation masks. Gemini can't deliver decodable
    // pixel masks anyway (it leaks internal <seg_NN> tokens), and asking for
    // them roughly triples the output and invites runaway generations that
    // made the wand hang for ages. The client selects via box_2d.
    const target = trimmedQuery
      ? `Detect: ${trimmedQuery}.`
      : 'Detect every distinct movable object in the room (furniture, decor, plants, lamps, rugs, appliances, clutter). Do not include the floor, walls, ceiling, windows, or doors.';
    const prompt = target +
      ' Output a JSON list where each entry contains the 2D bounding box in the key "box_2d" and a short text label in the key "label". Use descriptive labels.';

    // Thinking off per Google's spatial-understanding guidance; the token cap
    // bounds worst-case latency (a full 24-item list fits comfortably).
    const modelInstance = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.5,
        maxOutputTokens: 2048,
      },
    });

    let cleaned = [];
    // Flash occasionally returns an empty or unparseable list for a fully
    // furnished room; one quick retry smooths most of those out.
    for (let attempt = 1; attempt <= 2 && !cleaned.length; attempt++) {
      const result = await modelInstance.generateContent([
        { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
        { text: prompt },
      ]);
      const response = await result.response;
      let text = '';
      try { text = response.text(); } catch {
        const parts = (response && response.candidates && response.candidates[0] &&
          response.candidates[0].content && response.candidates[0].content.parts) || [];
        text = parts.map((p) => p.text || '').join('');
      }

      // The list arrives as text, often inside ```json fences, sometimes with prose.
      const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
      const jsonText = fenced ? fenced[1] : text;
      let items;
      try {
        items = JSON.parse(jsonText);
      } catch {
        const arr = jsonText.match(/\[[\s\S]*\]/);
        try { items = arr ? JSON.parse(arr[0]) : []; } catch { items = []; }
      }
      if (!Array.isArray(items)) items = [];

      cleaned = items
        .filter((it) => it && Array.isArray(it.box_2d) && it.box_2d.length === 4)
        .slice(0, 24)
        .map((it) => ({
          box_2d: it.box_2d.map((v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)))),
          mask: null, // reserved: pixel masks if Gemini ever returns real ones
          label: typeof it.label === 'string' ? it.label.slice(0, 80) : '',
        }))
        .filter((it) => it.box_2d[2] > it.box_2d[0] && it.box_2d[3] > it.box_2d[1]);
      if (!cleaned.length && DEBUG_MODE && attempt === 1) {
        logger.debug('[Segment] empty first pass (textLen ' + text.length + ') — retrying once');
      }
    }

    if (DEBUG_MODE) {
      logger.debug('[Segment] query:', trimmedQuery || '(all objects)', '→', cleaned.length, 'items');
    }
    return res.json({ success: true, items: cleaned });
  } catch (error) {
    logger.error('Error processing segmentation:', error);
    return sendError(res, 500, 'Failed to analyze the photo');
  }
});

  return router;
}
