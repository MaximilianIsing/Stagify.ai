// Shared JSDoc/TS shapes for the AI Designer (scripts/ai-designer-app.js and
// its islands under scripts/ai-designer/).
//
// Type-check only — never shipped to the browser. Reference from .js with e.g.
//   /** @param {import('./types.js').AdImage} img */
// (the `.js` specifier is deliberate: TS resolves it to this .d.ts, and no such
// runtime file exists to import.)
//
// PERMISSIVE by design, same stance as lib/types/*.d.ts and the Masking
// Studio's types.d.ts. Unlike that studio there is no single shared mutable
// store here — the entry hands each island getters and callbacks instead. What
// recurs across the islands is the conversation-history shape and the image
// objects derived from it, so those are what is written down.
//
// `image-history.js` is the authority on both: `extractRawImagesChronological`
// builds AdImage, `applyThumbnailLabels` adds `displayLabel` in place. Keep
// these in step with it.

/**
 * One image in the conversation, as collected for the thumbnail strip.
 * `displayLabel` is absent until `applyThumbnailLabels` has run, which
 * `collectImagesFromConversationHistory` always does before returning.
 */
export interface AdImage {
  url: string;
  isStaged: boolean;
  isGenerated: boolean;
  isMasked: boolean;
  filename: string | null;
  /** The originating upload's base name; derived images inherit it. */
  rootBaseName: string | null;
  /** 1-based "(Staged #n)" counter within a root, or null before labelling. */
  stagedNumber: number | null;
  /** 1-based "(Masked n)" counter within a root, or null before labelling. */
  maskNumber: number | null;
  displayLabel?: string;
}

/** One `image_url` item inside a conversation message's content array. */
export interface AdImageContentItem {
  type: 'image_url';
  image_url: { url: string };
  filename?: string | null;
  rootBaseName?: string | null;
  isStaged?: boolean;
  isGenerated?: boolean;
  isMasked?: boolean;
  stagedNumber?: number | null;
  maskNumber?: number | null;
  /** Server-supplied per-image note, attached while parsing the reply. */
  annotation?: string;
}

/** One `text` item inside a conversation message's content array. */
export interface AdTextContentItem {
  type: 'text';
  text: string;
}

/**
 * A conversation-history entry. `content` is a plain string for simple turns
 * and an item array once images are attached — both shapes are live, which is
 * why every consumer array-guards before filtering.
 */
export interface AdHistoryEntry {
  /**
   * 'user' | 'assistant' | 'system' in practice, but typed loosely on purpose:
   * entries are built from variables at half a dozen sites, so a union here
   * only produces widening errors at every construction without catching a
   * real class of bug. `extractRawImagesChronological` compares against the
   * literals and ignores anything else.
   */
  role: string;
  /**
   * A plain string for simple turns; an item array once images are attached.
   * Typed as a loose array because the array is assembled field-by-field at
   * several sites — AdImageContentItem / AdTextContentItem document what the
   * items actually are, and the consumers filter on `type` before reading.
   */
  content: string | any[];
  [key: string]: unknown;
}
