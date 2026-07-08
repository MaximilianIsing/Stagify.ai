// Pure image transforms (sharp) extracted verbatim from server.js. DEBUG_MODE is
// only used to gate diagnostic logging.
import sharp from 'sharp';
import { DEBUG_MODE } from '../config/runtime-flags.js';

const AR_NOOP_TOLERANCE = 0.01; // within 1% of source ratio — already fine, skip re-encode
const AR_MAX_CORRECTION = 0.08; // correct drifts up to 8%; beyond that, leave as-is

/**
 * Downscales an image to fit within 1920x1080 while maintaining aspect ratio
 */
export async function downscaleImage(imageBuffer) {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
      
    // Check if downscaling is needed
    if (metadata.width <= 1920 && metadata.height <= 1080) {
      return imageBuffer;
    }
    
    // Calculate the scaling factor to fit within 1920x1080 while maintaining aspect ratio
    const scaleWidth = 1920 / metadata.width;
    const scaleHeight = 1080 / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    const processedBuffer = await image
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return processedBuffer;
  } catch (error) {
    console.error("Error downscaling image:", error);
    throw error;
  }
}

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
        console.log(`[AspectRatio] drift ${(drift * 100).toFixed(1)}% exceeds ${AR_MAX_CORRECTION * 100}% cap — leaving output as-is (no zoom/distortion).`);
      }
      return outputBuffer;
    }
    // Keep the full width, adjust only the height to hit the source ratio. This is
    // a small stretch/squash — no cropping, no padding, all content preserved.
    const newHeight = Math.max(1, Math.round(meta.width / targetRatio));
    if (DEBUG_MODE) {
      console.log(`[AspectRatio] correcting ${(drift * 100).toFixed(1)}% drift: ${meta.width}x${meta.height} -> ${meta.width}x${newHeight}.`);
    }
    return await sharp(outputBuffer)
      .resize(meta.width, newHeight, { fit: 'fill' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('[AspectRatio] enforcement failed, returning model output as-is:', error.message);
    return outputBuffer;
  }
}

// Pad a reference/extra image with TRANSPARENT margins so its aspect ratio matches
// `targetAR` (room width / height). This stops Gemini from leaking the reference's
// own aspect ratio into the generated output. Only the short side grows — the
// subject is never scaled, stretched, or cropped, just framed in a room-shaped
// canvas. Returns { buffer, padded }; when padded the buffer is PNG (transparent
// alpha needs PNG). Pads only when the AR differs by more than `tol` (0 = any diff).
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
export async function normalizeMaskOutputToRoom(base64Png, roomW, roomH) {
  try {
    const buf = Buffer.from(base64Png, 'base64');
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.height && roomW && roomH) {
      const roomAR = roomW / roomH;
      const outAR = meta.width / meta.height;
      if (Math.abs(outAR - roomAR) / roomAR > 0.01) {
        const fixed = await sharp(buf).resize(roomW, roomH, { fit: 'cover' }).png().toBuffer();
        if (DEBUG_MODE) console.log(`[Mask Edit] AR drift corrected ${meta.width}×${meta.height} → ${roomW}×${roomH} (cover crop)`);
        return `data:image/png;base64,${fixed.toString('base64')}`;
      }
    }
  } catch (e) {
    console.warn('[Mask Edit] output AR normalization failed; returning raw output:', e.message);
  }
  return `data:image/png;base64,${base64Png}`;
}

export async function downscaleImageForGPT(dataUrl) {
  try {
    // Extract base64 data and MIME type
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      if (DEBUG_MODE) {
        console.log('[Image Downscale] Invalid data URL format, returning original');
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
    
    // OpenAI recommends max 2048x2048, but 1024x1024 is better for performance
    const maxDimension = 1024;
    
    // Check if downscaling is needed
    if (metadata.width <= maxDimension && metadata.height <= maxDimension) {
      if (DEBUG_MODE) {
        console.log(`[Image Downscale] Image ${metadata.width}x${metadata.height} is within limits, no downscaling needed`);
      }
      return dataUrl;
    }
    
    if (DEBUG_MODE) {
      console.log(`[Image Downscale] Downscaling image from ${metadata.width}x${metadata.height} to fit within ${maxDimension}x${maxDimension}`);
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
      console.log(`[Image Downscale] Downscaled to ${newWidth}x${newHeight}, size reduced by ${reduction}%`);
    }
    
    return newDataUrl;
  } catch (error) {
    console.error('[Image Downscale] Error downscaling image:', error);
    // Return original if downscaling fails
    return dataUrl;
  }
}

// Composite the model's raw output onto the original through the mask — edited
// pixels only inside the white mask region, original everywhere else — so the QA
// reviewer judges the COMBINED result the user actually receives (not raw output
// that may have drifted outside the mask). Falls back to the raw output on error.
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
    console.error('[Mask QA] composite for review failed, reviewing raw output:', e.message);
    return editedDataUrl;
  }
}
