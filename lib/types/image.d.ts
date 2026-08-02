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
 *
 * `degraded` marks a verdict that was NOT actually measured — the reviewer was
 * disabled or threw, and the image was accepted unreviewed. It is deliberately
 * distinct from a genuine `perfect: true`: both accept the image, but only one of
 * them means the image was looked at. Without it a reviewer outage is
 * indistinguishable from a flawless run, so the quality gate can switch itself off
 * and report 100% success.
 */
export interface ImageReviewResult {
  perfect: boolean;
  score: number;
  reason?: string;
  degraded?: boolean;
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
