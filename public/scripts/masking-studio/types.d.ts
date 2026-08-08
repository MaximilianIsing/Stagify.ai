// Shared JSDoc/TS shapes for the Masking Studio (scripts/masking-studio-app.js
// and its islands under scripts/masking-studio/).
//
// Type-check only — never shipped to the browser. Reference from .js with e.g.
//   /** @param {import('./types.js').MsState} state */
// (the `.js` specifier is deliberate: TS resolves it to this .d.ts, and no such
// runtime file exists to import.)
//
// PERMISSIVE by design, same stance as lib/types/*.d.ts: this describes the
// store as it is, not as it should be. The point is that the entry and the eight
// islands agree on one written shape — not to force a rewrite.
//
// The layer defaults are single-sourced in `layers.js` (`createLayer`); keep
// MsLayer in step with it.

/**
 * Options for `setBaseImage`.
 *
 * `sourceName` DEFAULTS TO CLEARED when omitted, which is what stops a fresh upload from
 * inheriting the last photo's filename. Callers that mean to keep it must say so.
 */
export interface MsBaseImageOpts {
  /** Skip creating the first area layer — used when a restore is about to add its own. */
  noLayer?: boolean;
  /** The photo's filename, for the gallery entry's name. */
  sourceName?: string;
}

/** Working-resolution room photo. Null until a photo is accepted. */
export interface MsBase {
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
}

/** One decoded Gemini segmentation mask, cached for wand hit-testing. */
export interface MsSegItem {
  canvas: HTMLCanvasElement;
  area: number;
  label: string;
}

/**
 * A pending "snap to object" suggestion: the pixels the AI painted just past the
 * user's highlight, at the `pw`×`ph` working grid `snap-refine.js` computes on.
 */
export interface MsSpill {
  pw: number;
  ph: number;
  fill: Uint8Array;
  count: number;
}

/** One layer's canvas as of a stroke boundary — an undo/redo stack entry. */
export interface MsUndoEntry {
  id: string;
  canvas: HTMLCanvasElement;
}

/** Coarse/feather geometry of the last generation run, reused when re-blending. */
export interface MsGenMeta {
  coreGrow: number;
  featherPx: number;
}

/**
 * One masked area. Created by `createLayer` (layers.js) and rehydrated by
 * `deserializeLayer` (session.js); those two are the only producers.
 */
export interface MsLayer {
  id: string;
  colorIdx: number;
  canvasEl: HTMLCanvasElement;
  /** Whether any stroke has landed — recomputed by the downsampled alpha scan. */
  painted: boolean;
  /** User-given name; empty → "Area {n}". */
  name: string;
  prompt: string;
  /** 'stage' adds furniture; 'remove' clears the area. */
  mode: 'stage' | 'remove';
  presetsOpen: boolean;
  /** Furniture reference photo, as a PNG data URL. */
  furniture: string | null;
  furnitureName: string;
  status: 'idle' | 'generating' | 'done' | 'failed';
  /** The selected candidate — what compositeAll draws. */
  editedImg: HTMLImageElement | null;
  /** Every generated version of this area, capped at 4. */
  candidates: HTMLImageElement[];
  candIdx: number;
  /** Cached feathered blend mask; nulled whenever strokes change. */
  blendMask: HTMLCanvasElement | null;
  spill: MsSpill | null;
  errorMsg: string;
  /** The layer's card in the sidebar, once rendered. */
  el: HTMLElement | null;
}

/**
 * The studio's single mutable store, created in the entry and injected into
 * every island. Eight islands read it and seven write to it, so treat a change
 * here as a change to all of them.
 */
export interface MsState {
  base: MsBase | null;
  /** Area layers, in z-order. */
  layers: MsLayer[];
  /** Selected area — the one that receives brush strokes. */
  activeId: string | null;
  phase: 'empty' | 'draw' | 'generating' | 'review';
  /** Review-phase viewer toggle. */
  view: 'before' | 'compare' | 'after';
  /** Brush size as a step on the relative scale in scripts/mask/brush-scale.js. */
  brushStep: number;
  layerSeq: number;
  /** Bumped per run so stale async completions can be ignored. */
  genRun: number;
  genMeta: MsGenMeta | null;
  /** Pre-stroke canvas snapshots (LIFO, capped). */
  undoStack: MsUndoEntry[][];
  /** Undone states, restored by Ctrl+Y (same cap). */
  redoStack: MsUndoEntry[][];
  segCache: MsSegItem[] | null;
  /** Bumped on photo change → drops in-flight segmentation results. */
  segToken: number;
  /** Dragging the compare divider. */
  comparing: boolean;
  /** 1 = fit to view, up to 4x. */
  zoom: number;
  /** Space held → pan mode. */
  spaceDown: boolean;
  panning: boolean;
  /** The photo's filename, for the gallery entry's name. Cleared with the photo. */
  sourceName: string;
  /**
   * Pixel digest of the last composite that was saved, so pressing Looks Good twice on an
   * unchanged result does not create a second entry — and so a genuinely refined one does.
   */
  savedDigest: string;
}

/** A palette slot. The set is fixed in the entry; `colorIdx` indexes into it. */
export interface MsPaletteEntry {
  hex: string;
  name: string;
}
