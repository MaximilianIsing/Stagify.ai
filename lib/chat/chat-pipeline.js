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
import { buildDesignerResponse } from './chat-response.js';

export default function createChatPipeline(deps) {
  const { applyMemoryActions } = createMemoryDispatch(deps);
  const { runGenerateRequests, runCadRequests } = createImageDispatch(deps);
  const { runStagingRequests } = createStagingDispatch(deps);
  const { resolveRecalledImage, resolveRequestedImage } = createImageRetrieval(deps);

  return {
    applyMemoryActions,
    runGenerateRequests,
    resolveRecalledImage,
    resolveRequestedImage,
    runCadRequests,
    runStagingRequests,
    buildDesignerResponse,
  };
}
