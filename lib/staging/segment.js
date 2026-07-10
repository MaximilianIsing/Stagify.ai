// POST /api/segment magic-wand handler, extracted verbatim from
// routes/staging.js. Pro gate, sharp-downscale to 1024 jpeg, build the Gemini
// box-detection prompt, run up to 2 generateContent attempts, and parse the
// free-text / fenced-JSON reply into normalized, clamped, capped-at-24 box_2d
// items. The genLimiter middleware stays in the route registration.
//
// deps: { genAI, requireProAccount, MAX_SEGMENT_QUERY_LENGTH, DEBUG_MODE }
import sharp from 'sharp';
import { sendError } from '../http/http-helpers.js';
import { logger } from '../logger.js';

/**
 * Build the POST /api/segment magic-wand Express handler. The returned handler
 * pro-gates the request, base64-decodes and sharp-downscales the posted image to
 * a 1024px JPEG (validating decodability), runs up to 2 gemini-2.5-flash box
 * detection attempts, and parses the fenced/plain JSON reply into items
 * normalized to `{ box_2d: number[4] (0-1000 clamped ints), mask: null, label: string<=80 }`,
 * capped at 24 and filtered to valid boxes. Responds `{ success, items }`.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, requireProAccount: (req: import('express').Request, res: import('express').Response) => (any | null), MAX_SEGMENT_QUERY_LENGTH: number, DEBUG_MODE: boolean }} deps - Injected AI client, pro gate, query-length cap, and debug flag. genAI is typed structurally (just the used `getGenerativeModel`) because the SDK's `GenerationConfig` type omits the newer `thinkingConfig` field this working call sets.
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<import('express').Response>} The POST /api/segment magic-wand Express handler.
 */
export function createSegmentHandler(deps) {
  const { genAI, requireProAccount, MAX_SEGMENT_QUERY_LENGTH, DEBUG_MODE } = deps;

  return async (req, res) => {
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
  };
}
