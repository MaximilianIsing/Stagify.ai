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
 * The verdict shape returned by the GPT-vision quality reviewers, driving the
 * quality-retry loop. Merged from QualityReviewResult (perfect+score) and the
 * richer ImageReviewResult (adds `reason`); `reason` is optional so both call
 * sites type-check.
 */
export interface ImageReviewResult {
  perfect: boolean;
  score: number;
  reason?: string;
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
