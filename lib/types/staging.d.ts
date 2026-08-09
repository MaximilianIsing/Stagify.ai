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
   * Hand the caller the model's NATIVE output before it is upscaled for delivery.
   *
   * processStaging returns only the delivery image — `upscaleForDelivery` enlarges the
   * ~1 MP result to as much as 4096px so the downloaded JPEG looks bigger, and drops the
   * original on the floor. The gallery must not store that: it is a lanczos upscale, so
   * it carries no more information than the native buffer at roughly six times the
   * bytes.
   *
   * An optional callback rather than a wider return type, because changing what
   * processStaging returns ripples into routes/chat.js, lib/chat/chat-staging.js,
   * chat-image-dispatch.js and every test that mounts them — a lot of blast radius for
   * one buffer. Callers that do not pass it are completely unaffected.
   *
   * Must not throw and must not be slow: it runs inside the generation path.
   */
  onNative?: ((buffer: Buffer, meta: { format?: string }) => void) | null;
  /**
   * Supply the whole generation prompt, instead of having processStaging build one from
   * roomType/furnitureStyle via generatePrompt().
   *
   * For a caller whose request is not a room-type + furniture-style combination — the
   * Exterior Studio relights a facade and removes parked cars; there is no room and no
   * furniture. Everything else processStaging does (the EXIF-oriented aspect-ratio pin,
   * the quality-retry loop, per-attempt metering, the prompt_logs.csv row, the crop
   * safety net, the delivery upscale, the onNative gallery hook) applies unchanged, so
   * this is an optional field rather than a second pipeline.
   *
   * Same shape of decision as `onNative` above: callers that do not pass it are
   * completely unaffected.
   */
  promptOverride?: string | null;
  /**
   * Replace the QA reviewer's rubric (QUALITY_REVIEW_PROMPT).
   *
   * That default opens with "AI-generated interior real-estate photos" and enumerates
   * interior failures. Pointed at another subject it grades against the wrong criteria
   * AND says nothing about the defects that render really produces. The reply format is
   * still contractual — the retry loop parses PERFECT/SCORE and forwards WHY.
   */
  reviewBasePrompt?: string | null;
  /**
   * Turn the self-check quality gate off for this render.
   *
   * The gate pays a vision review per attempt and regenerates up to QUALITY_MAX_ATTEMPTS
   * times chasing a better score. That is worth it when the model is INVENTING a room —
   * a melted sofa is a real, catchable defect. It is not worth it for an edit that only
   * relights or cleans up a photograph it was handed: a re-roll returns a different sky,
   * not a better one, for three times the cost and three times the wait.
   *
   * The retry on a thrown provider error is unaffected; only the review-and-reshoot loop
   * is. The render is NOT marked `_qaDegraded`, because that flag means the reviewer
   * broke.
   */
  skipQualityReview?: boolean;
  /**
   * Burn the short "virtually staged" disclosure into the finished pixels, bottom-right.
   *
   * Available on EVERY plan — free and Stagify+ alike. Unlike `removeFurniture`, this is
   * deliberately not gated: it is a legal disclosure (MLS / NAR Article 12), not an upsell,
   * and a paywalled compliance control is worse than no control.
   *
   * Applied inside processStaging BEFORE the `onNative` hook, so the one call covers the
   * delivered image AND the gallery master. Moving it later would leave the stored copy
   * unlabelled — the copy an agent re-downloads months later and publishes.
   *
   * The stamp FAILS CLOSED: if it cannot be applied, processStaging rejects with
   * `DISCLOSURE_STAMP_FAILED` rather than delivering an unlabelled image the user believes
   * is labelled. See lib/image/stamp-disclosure.js.
   *
   * Only the main staging studio sets it. The AI Designer, chat staging, Exterior Studio
   * and Masking Studio build their own params and leave it falsy — a decision, not an
   * omission: they are not producing an MLS listing photo of a furnished room.
   */
  labelVirtuallyStaged?: boolean;
  /**
   * UI language for `labelVirtuallyStaged`, as a `lang` name from lib/i18n/locales.js
   * ('german', 'japanese', …). Unknown or missing values fall back to English rather than
   * failing the render — it arrives from the browser's localStorage.
   */
  stampLang?: string;
  /**
   * Which of the three looks the badge is drawn in — a key of STAMP_STYLES in
   * lib/image/stamp-disclosure.js ('dark', 'light', 'minimal'). Anything else falls back to
   * the default rather than failing the render.
   */
  stampStyle?: string;
  /**
   * The size slider's multiplier on the badge's type size, clamped to
   * [STAMP_SCALE_MIN, STAMP_SCALE_MAX]. 1 is the size the badge gets on its own.
   */
  stampScale?: number;
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
