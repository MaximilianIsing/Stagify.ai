// Shared JSDoc/TS shapes for the staging pipeline (lib/staging).
// Type-check only. Reference from .js with e.g.
//   /** @param {import('../types/staging.js').StagingParams} params */
// PERMISSIVE by design — see note in chat.d.ts.

/**
 * The per-request staging descriptor threaded through the staging pipeline.
 * Built from the AI routing response (chat) or the multipart form body
 * (virtual-staging), then read by processStaging and generatePrompt. Merged from
 * the chat and virtual-staging variants: only `roomType` is reliably present,
 * so everything else is optional and unions are broad.
 */
export interface StagingParams {
  roomType: string;
  furnitureStyle?: string;
  additionalPrompt?: string;
  removeFurniture?: boolean | string;
  usePreviousImage?: boolean | number | null;
  furnitureImageIndex?: number | number[] | null;
  styleReference?: boolean;
  preserveExistingStaging?: boolean;
  /**
   * The room's locked design bible (multi-photo listing staging). Its presence is what
   * selects the THIRD meaning of the extra-image channel in staging-generation.js —
   * "this is the same room already staged, from another angle; reproduce these exact
   * pieces" — and switches the quality gate to worst-of(quality, continuity). Mutually
   * exclusive with `styleReference` in effect: the style suffix instructs the model to
   * change the furniture, which is the opposite of what a support frame needs.
   */
  designBible?: import('./projects.js').DesignBible | null;
  /** Which frame of its room this is. 'hero' defines the bible; 'support' is conditioned on it. */
  frameRole?: 'hero' | 'support';
  [key: string]: unknown;
}

/**
 * Optional out-parameter of `processStaging`. The retry loop returns only the winning
 * image, so per-render stats a caller wants to persist have to be collected as they go
 * past. Written only when the caller supplies an object; every field stays undefined
 * until the render reaches the point that produces it.
 *
 * `consistencyScore` is deliberately `null` (not 100) when no continuity check ran —
 * "unchecked" must not be indistinguishable from "checked and clean".
 */
export interface StagingOutcome {
  promptText?: string;
  model?: string;
  attempts?: number;
  durationMs?: number;
  qualityScore?: number | null;
  consistencyScore?: number | null;
  mismatchedSlots?: string[];
  errorCode?: string;
}

/**
 * Auth/usage context passed to the virtual-staging handler alongside req/res.
 */
export interface VirtualStagingMeta {
  user: ({ id: string; email: string; plan: string } & Record<string, unknown>) | null;
  recordUsage: boolean;
  treatAsPro: boolean;
}

/**
 * A persisted user memory as read by the prompt builders (only `.content` is
 * used). Structurally a subset of chat.js `Memory`; kept here so staging prompt
 * files can reference a local name.
 */
export interface StoredMemory {
  content: string;
  id?: string;
  [key: string]: unknown;
}
