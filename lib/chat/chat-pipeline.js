// Post-routing dispatch pipeline for the AI Designer chat endpoints.
//
// Both /api/chat and /api/chat-upload call OpenAI to get a routing decision,
// then run the SAME sequence of side-effecting steps on that decision:
// memory writes, image generation, staging, recall, image-request analysis,
// CAD rendering, and response assembly.
//
// This entry is pure wiring: each cohesive step lives in a sibling module
// (chat-memory / chat-image-dispatch / chat-staging / chat-image-retrieval /
// chat-response), and createChatPipeline composes them into the same 7-method
// interface the two route handlers consume. The `deps` bundle is forwarded
// wholesale; each sub-factory destructures only its own subset.
//
// The two handlers differ only in a few well-defined spots (which history
// array they read, how they resolve a "dual upload", and what the final
// image fallback is). Those differences are passed in as explicit params /
// small callbacks so each handler keeps its exact original behavior.
import createMemoryDispatch from './chat-memory.js';
import createImageDispatch from './chat-image-dispatch.js';
import createStagingDispatch from './chat-staging.js';
import createImageRetrieval from './chat-image-retrieval.js';
import createChatDispatch from './chat-dispatch.js';
import { buildDesignerResponse } from './chat-response.js';

/**
 * Compose the post-routing dispatch pipeline for the AI Designer chat endpoints from its
 * sibling step modules (memory, image dispatch, staging, retrieval, response). Returns the
 * same 7-method interface both /api/chat and /api/chat-upload consume; the `deps` bundle is
 * forwarded wholesale and each sub-factory destructures its own subset.
 * @param {any} deps - The shared dependency bundle forwarded to every sub-factory.
 * @returns {{ applyMemoryActions: Function, runGenerateRequests: Function, resolveRecalledImage: Function, resolveRequestedImage: Function, runCadRequests: Function, runStagingRequests: Function, buildDesignerResponse: typeof import('./chat-response.js').buildDesignerResponse, applyPostRoutingSuppression: Function, logRoutingOutcome: Function, beginChatStream: Function, sendChatResponse: Function }} The composed chat-pipeline API.
 */
export default function createChatPipeline(deps) {
  const { applyMemoryActions } = createMemoryDispatch(deps);
  const { runGenerateRequests, runCadRequests } = createImageDispatch(deps);
  const { runStagingRequests } = createStagingDispatch(deps);
  const { resolveRecalledImage, resolveRequestedImage } = createImageRetrieval(deps);
  const { applyPostRoutingSuppression, logRoutingOutcome, beginChatStream, sendChatResponse } = createChatDispatch(deps);

  return {
    applyMemoryActions,
    runGenerateRequests,
    resolveRecalledImage,
    resolveRequestedImage,
    runCadRequests,
    runStagingRequests,
    buildDesignerResponse,
    applyPostRoutingSuppression,
    logRoutingOutcome,
    beginChatStream,
    sendChatResponse,
  };
}
