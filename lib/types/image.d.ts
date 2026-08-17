// Shared JSDoc/TS shapes for the image subsystem (lib/image).
// Type-check only. Reference from .js with e.g.
//   /** @param {import('../types/image.js').ImageReviewResult} verdict */
// PERMISSIVE by design — see note in chat.d.ts.

/**
 * A furniture/reference image paired with its MIME type, as consumed by the CAD
 * render path.
 */
export interface FurnitureImageDescriptor {
  image: string | Buffer;
  mimeType?: string;
}

/**
 * Options for lib/staging/cad-handling.js's blueprintTo3D(). An options object rather
 * than positional args because `view`/`room`/`stamp` pushed it past four parameters.
 *
 * `view` picks between the two renders the module produces: 'top-down' (a furnished 3D
 * floor plan seen from above — the DEFAULT, and what a missing/unknown value falls back
 * to) and 'eye-level' (a photorealistic interior photo taken standing inside one room).
 * `room` names that room and is only meaningful for 'eye-level'.
 */
export interface BlueprintRenderOptions {
  mimeType?: string | null;
  furnitureImages?: FurnitureImageDescriptor[];
  additionalPrompt?: string | null;
  view?: 'top-down' | 'eye-level' | null;
  room?: string | null;
  /** "Virtually staged" disclosure params, as returned by readStampRequest(). */
  stamp?: { enabled?: boolean; lang?: string; style?: string; scale?: number } | null;
  /**
   * Receives the model's own output — stamped, but BEFORE the delivery upscale — for
   * callers that need to store it (the gallery does; the delivered upscale is
   * interpolation carrying no extra detail). Best-effort: a throw here is logged and
   * swallowed rather than failing the render.
   */
  onNative?: ((buffer: Buffer) => void) | null;
}

/**
 * The verdict shape returned by the GPT-vision quality reviewers, driving the
 * quality-retry loop. Merged from QualityReviewResult (perfect+score) and the
 * richer ImageReviewResult (adds `reason`); `reason` is optional so both call
 * sites type-check.
 *
 * `degraded` marks a verdict that was NOT actually measured — the reviewer was
 * disabled or threw, and the image was accepted unreviewed. It is deliberately
 * distinct from a genuine `perfect: true`: both accept the image, but only one of
 * them means the image was looked at. Without it a reviewer outage is
 * indistinguishable from a flawless run, so the quality gate can switch itself off
 * and report 100% success.
 *
 * `architectureDrift` answers a DIFFERENT question from `perfect`: whether the render
 * changed the room rather than whether it looks good. A render can be a flawless
 * photograph of the wrong house. It is only ever present when the reviewer was handed
 * the original photo to compare against (`reviewImageQuality`'s `sourceDataUrl`);
 * `undefined` means the question was not asked, which is not the same as `false`.
 */
export interface ImageReviewResult {
  perfect: boolean;
  score: number;
  reason?: string;
  degraded?: boolean;
  architectureDrift?: boolean;
}

/**
 * The success payload of eraseFurniture (null on failure): the emptied room in
 * both encodings the callers need.
 */
export interface EraseResult {
  dataUrl: string;
  buffer: Buffer;
}

/**
 * One record in the hosted-images manifest (index.json). `path` is not stored —
 * it is derived and added when listing.
 */
export interface HostedImageEntry {
  id: string;
  file: string;
  mime: string;
  ext: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  path?: string;
}
