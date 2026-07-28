// Post-routing dispatch sequencing for the AI Designer chat endpoints, extracted
// from routes/chat.js.
//
// Once a handler has a routing decision (and has opened its optional SSE stream)
// it runs the same five dispatch steps against the pipeline, folding each step's
// `textSuffix` into the reply text and collecting the images each produced.
//
// ============================ THE ORDER IS NOT SHARED ========================
// /api/chat runs GENERATE before STAGING; /api/chat-upload runs STAGING before
// GENERATE. That difference is deliberate and observable — it decides which step
// appends its suffix to the reply text first, and which step's model call happens
// first. So the order is a REQUIRED parameter (`order`), never a default baked in
// here. Each caller passes its own historical order and gets exactly its original
// sequence. Do not "simplify" this by fixing one order.
//
// The three tail steps (recall → image-request → CAD) DO run in the same order in
// both handlers, so they are sequenced here unconditionally.
//
// Text folding is per phase and matches the original lines exactly:
//   generate → `text = text + suffix`          (no `|| ''` guard — original)
//   staging  → `text = (text || '') + suffix`
//   cad      → `text = (text || '') + suffix`
// The image-request step does not append: it REPLACES text with its own return.

/** The two orders the handlers use. Exported so callers/tests can name them. */
export const GENERATE_THEN_STAGING = /** @type {const} */ (['generate', 'staging']);
export const STAGING_THEN_GENERATE = /** @type {const} */ (['staging', 'generate']);

/**
 * Bind the post-routing dispatch sequence to the pipeline steps it drives.
 * Collaborators are named explicitly rather than taking the whole deps bag; they
 * are the functions createChatPipeline() returns (typed `Function` there, hence
 * here).
 * @param {{ runStagingRequests: Function, runGenerateRequests: Function, resolveRecalledImage: Function, resolveRequestedImage: Function, runCadRequests: Function }} steps - The pipeline dispatch steps.
 * @returns {{ runPostRoutingDispatch: (args: { text: string, order: readonly string[], stagingArgs: any, generateArgs: any, recallArgs: any, requestedArgs: any, cadArgs: any }) => Promise<{ text: string, stagingResults: any[], generatedImages: any[], recalledImageForDisplay: any, requestedImageForDisplay: any, cadResults: any[] }> }} The dispatch runner.
 */
export default function createPostRoutingDispatch(steps) {
  const { runStagingRequests, runGenerateRequests, resolveRecalledImage, resolveRequestedImage, runCadRequests } = steps;

  /**
   * Run the five post-routing dispatch steps and thread the reply text through them.
   * `order` must list both 'staging' and 'generate' exactly once — the caller's own
   * historical order (see the module header: the two endpoints differ).
   * @param {{ text: string, order: readonly string[], stagingArgs: any, generateArgs: any, recallArgs: any, requestedArgs: any, cadArgs: any }} args - The reply text so far, the staging/generate order, and each step's argument bundle (`requestedArgs` must NOT carry `text` — the current text is injected).
   * @returns {Promise<{ text: string, stagingResults: any[], generatedImages: any[], recalledImageForDisplay: any, requestedImageForDisplay: any, cadResults: any[] }>} The updated text plus every dispatch result.
   */
  async function runPostRoutingDispatch({ text, order, stagingArgs, generateArgs, recallArgs, requestedArgs, cadArgs }) {
    assertImageOrder(order);

    let currentText = text;
    /** @type {any[]} */
    let stagingResults = [];
    /** @type {any[]} */
    let generatedImages = [];

    for (const phase of order) {
      if (phase === 'staging') {
        const stagingOut = await runStagingRequests(stagingArgs);
        stagingResults = stagingOut.stagingResults;
        if (stagingOut.textSuffix) currentText = (currentText || '') + stagingOut.textSuffix;
      } else {
        const generateOut = await runGenerateRequests(generateArgs);
        generatedImages = generateOut.generatedImages;
        if (generateOut.textSuffix) currentText = currentText + generateOut.textSuffix;
      }
    }

    // Recall.
    const recalledImageForDisplay = resolveRecalledImage(recallArgs);

    // Image request (may re-run GPT to analyze, replacing text).
    const requestedOut = await resolveRequestedImage({ ...requestedArgs, text: currentText });
    const requestedImageForDisplay = requestedOut.requestedImageForDisplay;
    currentText = requestedOut.text;

    // CAD.
    const cadOut = await runCadRequests(cadArgs);
    const cadResults = cadOut.cadResults;
    if (cadOut.textSuffix) currentText = (currentText || '') + cadOut.textSuffix;

    return {
      text: currentText,
      stagingResults,
      generatedImages,
      recalledImageForDisplay,
      requestedImageForDisplay,
      cadResults,
    };
  }

  return { runPostRoutingDispatch };
}

/**
 * Guard the required `order`: exactly one 'staging' and one 'generate'. Unreachable
 * for the two shipped call sites — it exists so a future caller cannot silently skip
 * a dispatch step (or reorder it) by passing a partial list.
 * @param {readonly string[]} order - The caller-supplied phase order.
 * @returns {void}
 */
function assertImageOrder(order) {
  const ok = Array.isArray(order)
    && order.length === 2
    && order.includes('staging')
    && order.includes('generate');
  if (!ok) {
    throw new TypeError(`runPostRoutingDispatch: order must be ['staging','generate'] in either order, got ${JSON.stringify(order)}`);
  }
}
