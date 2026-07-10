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
  usePreviousImage?: boolean | number;
  furnitureImageIndex?: number | number[] | null;
  styleReference?: boolean;
  preserveExistingStaging?: boolean;
  [key: string]: unknown;
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
