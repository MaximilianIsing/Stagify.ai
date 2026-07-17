// Pure image transforms (sharp) extracted verbatim from server.js. DEBUG_MODE is
// only used to gate diagnostic logging.
import sharp from 'sharp';
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';

const AR_NOOP_TOLERANCE = 0.01; // within 1% of source ratio — already fine, skip re-encode
const AR_MAX_CORRECTION = 0.08; // correct drifts up to 8%; beyond that, leave as-is

// Gemini's image models only emit a fixed set of aspect ratios. Requesting the nearest
// one (imageConfig.aspectRatio) pins the output to a stable bucket, so an iterative
// "download → re-upload → stage again" workflow can't accumulate AR drift into a visible
// stretch. Decimal ratios are precomputed for nearest-match. Source: Google's supported
// list for gemini-2.5/3.1-flash-image (verified honored by both against a live call).
const GEMINI_ASPECT_RATIOS = [
  { label: '21:9', ratio: 21 / 9 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '5:4', ratio: 5 / 4 },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '9:16', ratio: 9 / 16 },
];
// Crop the pinned output back to its target ratio only when it drifts past this — i.e.
// when the model clearly IGNORED the pin. Sits comfortably above the honored buckets'
// ~3% approximation slack, so an honored output is never cropped (which is what keeps
// round-trips from slowly zooming in).
const AR_PIN_CROP_TOLERANCE = 0.05;

// Delivery upscale (Option A). The image models return ~1 MP native output, so we
// enlarge the FINISHED result before serving it. This is interpolation only — it adds
// no genuine detail — but a clean lanczos upscale + gentle sharpen makes the served
// image larger and display/print better. Because the client sizes its canvas to the
// returned image's natural dimensions (and the download re-encodes from that canvas),
// it also raises the resolution of the file the user downloads. Encoded as WebP so the
// bigger image ships a SMALLER payload than the PNG the model returned.
const DELIVERY_UPSCALE_FACTOR = 2;   // enlarge the model's native output this many ×
const DELIVERY_MAX_EDGE = 4096;      // …but never let the long edge exceed this (px)
const DELIVERY_WEBP_QUALITY = 90;    // near-lossless; the client's download re-encodes to JPEG anyway
const DELIVERY_SHARPEN_SIGMA = 0.7;  // gentle unsharp to counter interpolation softness

/**
 * Downscale an image to fit within 1920×1080 (measured on its VISUAL, EXIF-oriented
 * dimensions), preserving aspect ratio. Two invariants the whole pipeline relies on:
 *  1. EXIF orientation is ALWAYS baked into the pixels (sharp auto-orient), so a
 *     rotated phone photo is never handed to a model sideways.
 *  2. The result is ALWAYS JPEG — the source buffer is returned untouched only when it
 *     is already an upright (orientation 1), in-bounds JPEG; every other input
 *     (oversized, non-JPEG, or carrying a non-trivial EXIF orientation) is re-encoded
 *     to JPEG q90. Callers may therefore always label the result `image/jpeg`.
 * @param {Buffer} imageBuffer - Source image bytes.
 * @returns {Promise<Buffer>} A JPEG buffer — freshly encoded, or the original bytes when they were already an upright, in-bounds JPEG.
 * @throws Re-throws any sharp decode/encode error.
 */
export async function downscaleImage(imageBuffer) {
  try {
    // .rotate() with no args auto-orients from the EXIF orientation tag and clears it,
    // so the pixels handed downstream are always upright.
    const image = sharp(imageBuffer).rotate();
    const metadata = await image.metadata();

    // sharp types width/height as optional (undefined for a dimensionless input);
    // without concrete dimensions there is nothing to normalize — pass through.
    if (metadata.width == null || metadata.height == null) return imageBuffer;

    // metadata reports the STORED dimensions; EXIF orientations 5–8 rotate by 90°, so
    // the visual (post-rotate) width/height are swapped. Size decisions use those.
    const orientation = metadata.orientation || 1;
    const swap = orientation >= 5;
    const width = swap ? metadata.height : metadata.width;
    const height = swap ? metadata.width : metadata.height;

    // Already an upright, in-bounds JPEG → nothing to normalize, return the bytes as-is.
    if (width <= 1920 && height <= 1080 && orientation === 1 && metadata.format === 'jpeg') {
      return imageBuffer;
    }

    // Fit within 1920×1080 on the visual dimensions (scale is capped at 1 so we never
    // enlarge). When the image already fits, scale is 1 and this pass only bakes in the
    // orientation and/or normalizes the format to JPEG.
    const scale = Math.min(1920 / width, 1080 / height, 1);
    const newWidth = Math.max(1, Math.round(width * scale));
    const newHeight = Math.max(1, Math.round(height * scale));

    return await image
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (error) {
    logger.error("Error downscaling image:", error);
    throw error;
  }
}

/**
 * Visual (post-EXIF-orientation) dimensions for a sharp metadata object. EXIF
 * orientations 5–8 rotate the image 90°, swapping the stored width and height, so any
 * aspect-ratio reasoning must use these rather than the raw metadata dims.
 * @param {{ width?: number, height?: number, orientation?: number } | null | undefined} meta - sharp metadata (or null/undefined).
 * @returns {{ width: number, height: number } | null} The visual dimensions, or null when width/height are unavailable.
 */
export function orientedDimensions(meta) {
  if (!meta || !meta.width || !meta.height) return null;
  return (meta.orientation || 1) >= 5
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

/**
 * Nudge an output image back toward a target aspect ratio by stretching only its
 * height (no crop, no padding). No-ops when within 1% of target or when drift exceeds
 * the 8% correction cap; fails open to the input on error.
 * @param {Buffer} outputBuffer - Model output image bytes.
 * @param {number} targetWidth - Target width used to derive the desired ratio.
 * @param {number} targetHeight - Target height used to derive the desired ratio.
 * @returns {Promise<Buffer>} The ratio-corrected PNG, or the input buffer when left uncorrected.
 */
export async function enforceAspectRatio(outputBuffer, targetWidth, targetHeight) {
  try {
    if (!targetWidth || !targetHeight) return outputBuffer;
    const targetRatio = targetWidth / targetHeight;
    const meta = await sharp(outputBuffer).metadata();
    if (!meta.width || !meta.height) return outputBuffer;
    const outRatio = meta.width / meta.height;
    const drift = Math.abs(outRatio - targetRatio) / targetRatio;
    if (drift < AR_NOOP_TOLERANCE) return outputBuffer; // close enough already
    if (drift > AR_MAX_CORRECTION) {
      if (DEBUG_MODE) {
        logger.debug(`[AspectRatio] drift ${(drift * 100).toFixed(1)}% exceeds ${AR_MAX_CORRECTION * 100}% cap — leaving output as-is (no zoom/distortion).`);
      }
      return outputBuffer;
    }
    // Keep the full width, adjust only the height to hit the source ratio. This is
    // a small stretch/squash — no cropping, no padding, all content preserved.
    const newHeight = Math.max(1, Math.round(meta.width / targetRatio));
    if (DEBUG_MODE) {
      logger.debug(`[AspectRatio] correcting ${(drift * 100).toFixed(1)}% drift: ${meta.width}x${meta.height} -> ${meta.width}x${newHeight}.`);
    }
    return await sharp(outputBuffer)
      .resize(meta.width, newHeight, { fit: 'fill' })
      .png()
      .toBuffer();
  } catch (error) {
    logger.error('[AspectRatio] enforcement failed, returning model output as-is:', error.message);
    return outputBuffer;
  }
}

/**
 * Upscale a FINISHED output image for delivery: enlarge it by DELIVERY_UPSCALE_FACTOR
 * (capped so the long edge never exceeds DELIVERY_MAX_EDGE) with a lanczos3 kernel and a
 * gentle sharpen, then encode as WebP. This adds no genuine detail — it is a clean
 * interpolation so the served image is larger than the model's ~1 MP native output — and
 * WebP keeps the enlarged result's payload below the original PNG's. Runs on the final
 * result only (after the quality gate, which judged the native-resolution image). Fails
 * open to the input on any error, and returns non-data-URL input untouched.
 * @param {string} dataUrl - The finished image as a `data:<mime>;base64,...` URL.
 * @returns {Promise<string>} A `data:image/webp;base64,...` URL (upscaled and/or WebP-normalized), or the input unchanged when it is not a data URL or on error.
 */
export async function upscaleForDelivery(dataUrl) {
  try {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!m) return dataUrl; // not a data URL — nothing to do
    const buffer = Buffer.from(m[2], 'base64');
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return dataUrl;

    // Cap the factor so the long edge never exceeds DELIVERY_MAX_EDGE — protects the
    // rare already-large input (e.g. a 4K pro-model render) from ballooning.
    const longEdge = Math.max(meta.width, meta.height);
    const factor = Math.min(DELIVERY_UPSCALE_FACTOR, DELIVERY_MAX_EDGE / longEdge);

    if (factor <= 1) {
      // Already at/over the target size — don't enlarge, but still normalize to WebP so
      // delivery stays a single, smaller-payload format.
      const webp = await sharp(buffer).webp({ quality: DELIVERY_WEBP_QUALITY }).toBuffer();
      return `data:image/webp;base64,${webp.toString('base64')}`;
    }

    const targetW = Math.round(meta.width * factor);
    const targetH = Math.round(meta.height * factor);
    const out = await sharp(buffer)
      .resize(targetW, targetH, { kernel: sharp.kernel.lanczos3 })
      .sharpen({ sigma: DELIVERY_SHARPEN_SIGMA })
      .webp({ quality: DELIVERY_WEBP_QUALITY })
      .toBuffer();
    if (DEBUG_MODE) {
      logger.debug(`[Delivery Upscale] ${meta.width}×${meta.height} → ${targetW}×${targetH} (×${factor.toFixed(2)}), WebP q${DELIVERY_WEBP_QUALITY}`);
    }
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch (error) {
    logger.error('[Delivery Upscale] failed, returning model output as-is:', error.message);
    return dataUrl;
  }
}

/**
 * Snap an image's dimensions to the nearest aspect ratio the Gemini image models
 * support, returning both the API label and its decimal ratio. Passing that label as
 * `imageConfig.aspectRatio` pins the model's output to a stable bucket, so iterative
 * re-staging can't accumulate aspect-ratio drift. Compares in log space so wide and tall
 * ratios are weighted symmetrically.
 * @param {number} width - Source width in px.
 * @param {number} height - Source height in px.
 * @returns {{ label: string, ratio: number } | null} The nearest supported ratio, or null when width/height are missing.
 */
export function nearestGeminiAspectRatio(width, height) {
  if (!width || !height) return null;
  const ar = width / height;
  let best = null;
  let bestErr = Infinity;
  for (const candidate of GEMINI_ASPECT_RATIOS) {
    const err = Math.abs(Math.log(ar / candidate.ratio));
    if (err < bestErr) {
      bestErr = err;
      best = candidate;
    }
  }
  return best;
}

/**
 * Cover-crop an image to a target aspect ratio WITHOUT stretching or upscaling — a
 * centered crop at the image's own resolution. This is only a safety net for the rare
 * model output that ignores the pinned `aspectRatio`: it no-ops when the output is
 * already within `tol` of the target (so an honored bucket is never touched, which is
 * what keeps repeated round-trips from slowly zooming in). Fails open to the input.
 * @param {Buffer} buffer - Output image bytes.
 * @param {number} targetRatio - Desired width/height ratio.
 * @param {number} [tol=AR_PIN_CROP_TOLERANCE] - Drift below which the image is left untouched.
 * @returns {Promise<Buffer>} The centered-cropped PNG, or the input unchanged when within tolerance or on error.
 */
export async function cropToAspectRatio(buffer, targetRatio, tol = AR_PIN_CROP_TOLERANCE) {
  try {
    if (!targetRatio || !isFinite(targetRatio)) return buffer;
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return buffer;
    const outRatio = meta.width / meta.height;
    const drift = Math.abs(outRatio - targetRatio) / targetRatio;
    if (drift <= tol) return buffer; // honored the pin (or its bucket) — leave it alone
    let cropW = meta.width;
    let cropH = meta.height;
    if (outRatio > targetRatio) {
      cropW = Math.max(1, Math.round(meta.height * targetRatio)); // too wide → trim the sides
    } else {
      cropH = Math.max(1, Math.round(meta.width / targetRatio)); // too tall → trim top/bottom
    }
    const left = Math.floor((meta.width - cropW) / 2);
    const top = Math.floor((meta.height - cropH) / 2);
    if (DEBUG_MODE) {
      logger.debug(`[AspectRatio] pin ignored (${(drift * 100).toFixed(1)}% off) — center-cropping ${meta.width}×${meta.height} → ${cropW}×${cropH}.`);
    }
    return await sharp(buffer)
      .extract({ left, top, width: cropW, height: cropH })
      .png()
      .toBuffer();
  } catch (error) {
    logger.error('[AspectRatio] pin-crop safety net failed, returning output as-is:', error.message);
    return buffer;
  }
}

// Pad a reference/extra image with TRANSPARENT margins so its aspect ratio matches
// `targetAR` (room width / height). This stops Gemini from leaking the reference's
// own aspect ratio into the generated output. Only the short side grows — the
// subject is never scaled, stretched, or cropped, just framed in a room-shaped
// canvas. Returns { buffer, padded }; when padded the buffer is PNG (transparent
// alpha needs PNG). Pads only when the AR differs by more than `tol` (0 = any diff).
/**
 * Pad a reference image with transparent margins so its aspect ratio matches `targetAR`.
 * @param {Buffer} buffer - Reference/extra image bytes.
 * @param {number} targetAR - Desired aspect ratio (room width / height).
 * @param {number} [tol=0] - Ratio-difference tolerance below which no padding is applied.
 * @returns {Promise<{ buffer: Buffer, padded: boolean }>} The possibly-padded buffer (PNG when padded) and whether padding was applied.
 */
export async function padBufferToAspectRatio(buffer, targetAR, tol = 0) {
  if (!targetAR || !isFinite(targetAR)) return { buffer, padded: false };
  const meta = await sharp(buffer).metadata();
  const w = meta.width, h = meta.height;
  if (!w || !h) return { buffer, padded: false };
  const ar = w / h;
  if (Math.abs(ar - targetAR) / targetAR <= tol) return { buffer, padded: false };
  let tw = w, th = h;
  if (ar > targetAR) th = Math.round(w / targetAR);       // too wide → grow height
  else if (ar < targetAR) tw = Math.round(h * targetAR);  // too tall → grow width
  if (tw === w && th === h) return { buffer, padded: false };
  const out = await sharp(buffer)
    .resize(tw, th, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return { buffer: out, padded: true };
}

// Build a "locator" image for mask editing: the room with the brushed region's
// BORDER drawn as a bright magenta outline (NOT a fill — a fill tempts the model
// to reproduce it as a colored splotch in the output). The model generates from
// the CLEAN room and reads this copy only to see WHERE to edit, so the magenta
// never needs to appear in the result. Magenta is used because it is almost never
// a real room/furniture color, so "ignore it" is unambiguous. Throws on failure so
// the caller can fall back to the plain mask.
/**
 * Build a mask-editing "locator" image: the room with the brushed region's border
 * drawn as a bright magenta outline (border only, never a fill).
 * @param {Buffer} roomBuffer - Clean room image bytes.
 * @param {Buffer} maskBuffer - Brush mask (white inside the brushed area).
 * @param {number} width - Output width in px.
 * @param {number} height - Output height in px.
 * @returns {Promise<Buffer>} A PNG of the room with the magenta locator outline composited on.
 * @throws On any sharp failure, so the caller can fall back to the plain mask.
 */
export async function buildMarkedRoomImage(roomBuffer, maskBuffer, width, height) {
  const W = width, H = height;
  const THICK = Math.max(3, Math.round(Math.min(W, H) * 0.006)); // outline thickness, px
  const maskAlpha = await sharp(maskBuffer)
    .resize(W, H, { fit: 'fill' })
    .extractChannel(0) // white (255) inside the brushed area, 0 outside
    .raw()
    .toBuffer();
  const inside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inside[i] = maskAlpha[i] >= 128 ? 1 : 0;
  // Erode `inside` by THICK with a separable min-filter (O(W*H*THICK)); the outline
  // is the band that is inside but NOT in the eroded core — a clean border, no fill.
  const horiz = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let keep = 1;
      for (let dx = -THICK; dx <= THICK; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= W || !inside[row + nx]) { keep = 0; break; }
      }
      horiz[row + x] = keep;
    }
  }
  const rgba = Buffer.alloc(W * H * 4); // zero-filled → fully transparent by default
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const idx = y * W + x;
      if (!inside[idx]) continue;
      let eroded = 1;
      for (let dy = -THICK; dy <= THICK; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H || !horiz[ny * W + x]) { eroded = 0; break; }
      }
      if (!eroded) { // inside but on the border band → magenta outline
        rgba[idx * 4] = 255;     // R
        rgba[idx * 4 + 1] = 0;   // G
        rgba[idx * 4 + 2] = 255; // B
        rgba[idx * 4 + 3] = 255; // A (opaque)
      }
    }
  }
  const overlay = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return await sharp(roomBuffer)
    .resize(W, H, { fit: 'fill' })
    .composite([{ input: overlay, blend: 'over' }])
    .png()
    .toBuffer();
}

// Lock a mask-edit output back to the room's aspect ratio. Gemini "squares up" the
// AR, and the client composites by stretching the result onto the original canvas
// — so a drifted AR would warp the edit out of alignment with the untouched
// surroundings. A centered cover-crop restores the room ratio WITHOUT stretching
// (Gemini usually just adds ceiling/floor bands, so cropping them re-aligns the
// real content). Only acts when the AR actually drifted; fails open to the raw
// output. Returns a PNG data URL.
/**
 * Lock a mask-edit output back to the room's aspect ratio via a centered cover-crop.
 * Only acts when the ratio drifted by more than 1%; fails open to the raw output.
 * @param {string} base64Png - The model output image as raw base64 (no data: prefix).
 * @param {number} roomW - Original room width in px.
 * @param {number} roomH - Original room height in px.
 * @returns {Promise<string>} A `data:image/png;base64,...` URL (cover-cropped when drift was corrected, else the raw input re-wrapped).
 */
export async function normalizeMaskOutputToRoom(base64Png, roomW, roomH) {
  try {
    const buf = Buffer.from(base64Png, 'base64');
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.height && roomW && roomH) {
      const roomAR = roomW / roomH;
      const outAR = meta.width / meta.height;
      if (Math.abs(outAR - roomAR) / roomAR > 0.01) {
        const fixed = await sharp(buf).resize(roomW, roomH, { fit: 'cover' }).png().toBuffer();
        if (DEBUG_MODE) logger.debug(`[Mask Edit] AR drift corrected ${meta.width}×${meta.height} → ${roomW}×${roomH} (cover crop)`);
        return `data:image/png;base64,${fixed.toString('base64')}`;
      }
    }
  } catch (e) {
    logger.warn('[Mask Edit] output AR normalization failed; returning raw output:', e.message);
  }
  return `data:image/png;base64,${base64Png}`;
}

/**
 * Downscale a data-URL image to fit within 1024×1024 for GPT-vision, re-encoding as
 * JPEG q85. Returns the input unchanged when it is not a data URL or already fits.
 * @param {string} dataUrl - A `data:<mime>;base64,...` image URL.
 * @returns {Promise<string>} A downscaled `data:image/jpeg;base64,...` URL, or the original string when no downscale was needed or on error.
 */
export async function downscaleImageForGPT(dataUrl) {
  try {
    // Extract base64 data and MIME type
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      if (DEBUG_MODE) {
        logger.debug('[Image Downscale] Invalid data URL format, returning original');
      }
      return dataUrl;
    }
    
    const mimeType = matches[1];
    const base64Data = matches[2];
    
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Get image metadata
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    // sharp types width/height as optional; with no concrete dimensions we can't
    // compute a downscale, so return the original data URL untouched.
    if (metadata.width == null || metadata.height == null) return dataUrl;

    // OpenAI recommends max 2048x2048, but 1024x1024 is better for performance
    const maxDimension = 1024;
    
    // Check if downscaling is needed
    if (metadata.width <= maxDimension && metadata.height <= maxDimension) {
      if (DEBUG_MODE) {
        logger.debug(`[Image Downscale] Image ${metadata.width}x${metadata.height} is within limits, no downscaling needed`);
      }
      return dataUrl;
    }
    
    if (DEBUG_MODE) {
      logger.debug(`[Image Downscale] Downscaling image from ${metadata.width}x${metadata.height} to fit within ${maxDimension}x${maxDimension}`);
    }
    
    // Calculate the scaling factor to fit within maxDimension while maintaining aspect ratio
    const scaleWidth = maxDimension / metadata.width;
    const scaleHeight = maxDimension / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    // Resize and convert to JPEG for smaller size (or keep original format if it's already JPEG)
    let processedBuffer;
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
      processedBuffer = await image
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      // For other formats, convert to JPEG
      processedBuffer = await image
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    }
    
    // Convert back to base64 data URL
    const newBase64 = processedBuffer.toString('base64');
    const newDataUrl = `data:image/jpeg;base64,${newBase64}`;
    
    const originalSize = Buffer.byteLength(dataUrl, 'utf8');
    const newSize = Buffer.byteLength(newDataUrl, 'utf8');
    const reduction = ((1 - newSize / originalSize) * 100).toFixed(1);
    
    if (DEBUG_MODE) {
      logger.debug(`[Image Downscale] Downscaled to ${newWidth}x${newHeight}, size reduced by ${reduction}%`);
    }
    
    return newDataUrl;
  } catch (error) {
    logger.error('[Image Downscale] Error downscaling image:', error);
    // Return original if downscaling fails
    return dataUrl;
  }
}

// Composite the model's raw output onto the original through the mask — edited
// pixels only inside the white mask region, original everywhere else — so the QA
// reviewer judges the COMBINED result the user actually receives (not raw output
// that may have drifted outside the mask). Falls back to the raw output on error.
/**
 * Composite the model's edit onto the original through the mask (edited pixels only
 * inside the white mask region) so the QA reviewer judges the combined result.
 * @param {Buffer} originalBuf - Original room image bytes.
 * @param {Buffer} maskBuf - Brush mask (white inside the brushed area).
 * @param {string} editedDataUrl - The model's edited image as a `data:...;base64,...` URL.
 * @param {number} width - Composite width in px.
 * @param {number} height - Composite height in px.
 * @returns {Promise<string>} A `data:image/png;base64,...` URL of the masked composite, or the raw edited URL on error.
 */
export async function compositeForReview(originalBuf, maskBuf, editedDataUrl, width, height) {
  try {
    const editedBuf = Buffer.from(editedDataUrl.split(',')[1], 'base64');
    // Mask's red channel = blend weight (white inside the brushed area).
    const maskAlpha = await sharp(maskBuf)
      .resize(width, height, { fit: 'fill' })
      .extractChannel(0)
      .raw()
      .toBuffer();
    const editedRaw = await sharp(editedBuf)
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let i = 0; i < width * height; i++) {
      editedRaw[i * 4 + 3] = maskAlpha[i]; // keep edited only where the mask is white
    }
    const editedPng = await sharp(editedRaw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    const composite = await sharp(originalBuf)
      .resize(width, height, { fit: 'fill' })
      .composite([{ input: editedPng, blend: 'over' }])
      .png()
      .toBuffer();
    return `data:image/png;base64,${composite.toString('base64')}`;
  } catch (e) {
    logger.error('[Mask QA] composite for review failed, reviewing raw output:', e.message);
    return editedDataUrl;
  }
}
