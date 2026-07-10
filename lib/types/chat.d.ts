// Shared JSDoc/TS shapes for the AI-Designer chat pipeline (lib/chat).
// Type-check only — no runtime effect. Reference from .js files with e.g.
//   /** @param {import('../types/chat.js').ChatMessage[]} messages */
// (`import('...chat.js')` resolves to this .d.ts under NodeNext.)
//
// Deliberately PERMISSIVE: most fields optional and unions broad so that adding
// a reference never introduces a new tsc error. Widen further before narrowing.

import type { StagingParams } from './staging.js';

/**
 * An item inside a message's `content` array. `text` items carry `text`; image
 * items carry `image_url.url` (a data: URL) plus optional metadata side-channels.
 * Underscore-prefixed fields are internal and stripped before sending to OpenAI.
 */
export interface ContentItem {
  type: 'text' | 'image_url' | string;
  text?: string;
  image_url?: { url: string };
  filename?: string;
  originalname?: string;
  isStaged?: boolean;
  isGenerated?: boolean;
  annotationPromise?: Promise<string | null>;
  annotation?: string | null;
  _annotation?: string | null;
  _filename?: string;
  [key: string]: unknown;
}

/**
 * One conversation turn as exchanged with the client and reshaped for OpenAI.
 * `content` is either a plain string (text-only) or an array of ContentItem.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | string;
  content: string | ContentItem[];
  [key: string]: unknown;
}

/**
 * A multer upload (subset actually read across lib/chat). Compatible with
 * Express.Multer.File.
 */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

/**
 * A resolved image extracted from conversation history (the index space that
 * usePreviousImage / imageIndex / recall address).
 */
export interface HistoryImage {
  url: string;
  isStaged: boolean;
  isGenerated: boolean;
  messageIndex: number;
  filename: string | null;
  annotation: string | null;
}

/**
 * The AI routing 'staging' object (raw model output). Fields are optional /
 * loosely-typed because the model may omit them.
 */
export interface StagingRequest {
  shouldStage?: boolean;
  roomType?: string;
  additionalPrompt?: string;
  removeFurniture?: boolean;
  usePreviousImage?: number | boolean | null;
  furnitureImageIndex?: number | number[] | null;
  styleReference?: boolean;
  [key: string]: unknown;
}

/** The AI routing 'generate' object (text-to-image). */
export interface GenerateRequest {
  shouldGenerate?: boolean;
  prompt?: string;
  [key: string]: unknown;
}

/**
 * The AI routing 'cad' object (blueprint -> 3D render). Also stored as the
 * `params` of a CadResult.
 */
export interface CadRequest {
  shouldProcessCAD?: boolean;
  imageIndex?: number;
  furnitureImageIndex?: number | number[] | null;
  additionalPrompt?: string;
  [key: string]: unknown;
}

/**
 * The store/forget instruction set — both the AI's raw request and the applied
 * result use this shape.
 */
export interface MemoryActions {
  stores: string[];
  forgets: string[];
}

/**
 * The parsed JSON of the AI Designer routing completion. Every action field is
 * optional and may be a single object or an array.
 */
export interface RoutingDecision {
  response?: string;
  memories?: MemoryActions;
  staging?: StagingRequest | StagingRequest[] | null;
  imageRequest?: Record<string, unknown> | null;
  recall?: Record<string, unknown> | null;
  generate?: GenerateRequest | GenerateRequest[] | null;
  cad?: CadRequest | CadRequest[] | null;
  [key: string]: unknown;
}

/** A stored user memory record. */
export interface Memory {
  id?: string;
  content: string;
  timestamp?: string;
  userMessage?: string;
  [key: string]: unknown;
}

/** One successful staging output collected by runStagingRequests. */
export interface StagingResult {
  stagedImage: string;
  params: StagingParams;
  annotationPromise: Promise<string | null>;
}

/**
 * One generated image collected by runGenerateRequests. buildDesignerResponse
 * tolerates a bare string too (`g.image || g`).
 */
export interface GeneratedImageResult {
  image: string;
  annotationPromise: Promise<string | null>;
}

/** One CAD render collected by runCadRequests. */
export interface CadResult {
  cadImage: string;
  params: CadRequest;
  annotationPromise: Promise<string | null>;
}

/**
 * The result of splitting a multi-image upload into a room + furniture
 * references.
 */
export interface DualUploadResolution {
  roomBuffer: Buffer;
  furnitureBuffers: Buffer[];
  source: string;
}

/**
 * The handler-specific final image fallback injected into runStagingRequests
 * when there is neither a dual upload nor a usePreviousImage selection.
 */
export interface FallbackImageResolution {
  buffer: Buffer;
  source: string;
  logMessage?: string;
}

/**
 * A rejected upload record produced during content building and consumed by the
 * routing error-recovery pass.
 */
export interface UnsupportedFileDescriptor {
  name: string;
  type: string;
  ext?: string;
  fileType: string;
}

/**
 * The assembled JSON response body from buildDesignerResponse. Scalar image
 * fields appear for a single result and array fields for multiples.
 */
export interface DesignerResponse {
  response?: string;
  memories?: MemoryActions;
  stagedImage?: string;
  stagedImages?: string[];
  stagingParams?: StagingParams | StagingParams[];
  stagedImageAnnotations?: Record<string, string>;
  generatedImage?: string;
  generatedImages?: string[];
  generatedImageAnnotations?: Record<string, string>;
  cadImage?: string;
  cadImages?: string[];
  cadParams?: CadRequest[];
  cadImageAnnotation?: string;
  cadImageAnnotations?: Record<string, string>;
  requestedImage?: string;
  recalledImage?: string;
  imageAnnotations?: Record<string, string>;
  files?: Array<{ name: string; type: string }>;
  [key: string]: unknown;
}
