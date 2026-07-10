// Pure helpers for interpreting the AI Designer routing completion and deciding
// how a chat turn will be handled. Extracted verbatim from server.js.

// Parse a routing completion. Strict mode can return a `refusal` instead of
// `content`; surface that as a plain (non-actionable) reply rather than throwing
// on JSON.parse(null), so a rare refusal degrades gracefully.
/**
 * Parse the AI Designer routing completion into a routing decision. A strict-mode
 * refusal (no content) is surfaced as a plain `{ response }` reply instead of throwing
 * on JSON.parse(null), so a rare refusal degrades gracefully.
 * @param {any} completion - The raw OpenAI chat completion (`.choices[0].message`).
 * @returns {import('../types/chat.js').RoutingDecision} The parsed routing decision, or a `{ response }` fallback on refusal.
 */
export function parseDesignerRoutingCompletion(completion) {
  const message = completion?.choices?.[0]?.message;
  if (message && message.refusal) {
    return { response: message.refusal };
  }
  return JSON.parse(message.content);
}

/**
 * True when the assistant response is asking the user for input before acting, so the
 * caller can suppress staging/generate/cad when the model set both questions and actions.
 * @param {string} responseText - The assistant's reply text.
 * @returns {boolean} true when the reply defers to a follow-up question rather than acting.
 */
export function aiResponseDefersImageAction(responseText) {
  if (!responseText || typeof responseText !== 'string') return false;
  const t = responseText.trim().toLowerCase();
  if (/\bhere('s| is)\b.*\b(staged|staging result|your room)\b/.test(t)) return false;
  if (/\bi('ve| have) (staged|created|generated)\b/.test(t)) return false;
  const deferPatterns = [
    /\bcould you (please )?(provide|share|tell|describe|specify|clarify|let me know|confirm)\b/,
    /\bcan you (please )?(provide|share|tell|describe|specify|clarify|let me know|confirm)\b/,
    /\bplease (provide|share|tell|describe|specify|clarify|confirm)\b/,
    /\bwhat (style|color|colour|type|kind|theme|furniture|decor|preference|look|vibe|aesthetic)s?\b/,
    /\bwhich (style|color|colour|theme|look|aesthetic|image|room|option|one)\b/,
    /\bmore (details|information|about|specifics|context)\b/,
    /\bany (preferences|specific|details|requirements)\b/,
    /\bdo you have (specific|any|particular)\b/,
    /\bfor example,?\s*what\b/,
    /\bwould you (like to|prefer to|want to) (share|tell|specify|describe|clarify)\b/,
    /\blet me know (what|which|if|about|your|how)\b/,
    /\bbefore i (stage|generate|create|proceed|start)\b/,
    /\bi('d| would) like to (know|understand|clarify)\b/,
    /\bto make sure\b/,
    /\bnot sure (which|what|if)\b/,
    /\ba few (quick )?questions\b/,
    /\bquick question\b/,
  ];
  if (!deferPatterns.some((p) => p.test(t))) return false;
  return t.includes('?');
}

/**
 * True when the decided intent will trigger the slow image phase (staging, generation,
 * or CAD), so the client can show the long-running loader. Each arg may be a single
 * request object or an array of them.
 * @param {import('../types/chat.js').StagingRequest | import('../types/chat.js').StagingRequest[] | null} stagingReq - The routing 'staging' request(s).
 * @param {import('../types/chat.js').GenerateRequest | import('../types/chat.js').GenerateRequest[] | null} generateReq - The routing 'generate' request(s).
 * @param {import('../types/chat.js').CadRequest | import('../types/chat.js').CadRequest[] | null} cadReq - The routing 'cad' request(s).
 * @returns {boolean} true when at least one request will run in the slow image phase.
 */
export function chatWillProcessSlowImages(stagingReq, generateReq, cadReq) {
  if (stagingReq) {
    const reqs = Array.isArray(stagingReq) ? stagingReq : [stagingReq];
    if (reqs.some((s) => s && s.shouldStage)) return true;
  }
  if (generateReq) {
    const reqs = Array.isArray(generateReq) ? generateReq : [generateReq];
    if (reqs.some((g) => g && g.shouldGenerate && g.prompt)) return true;
  }
  if (cadReq) {
    const reqs = Array.isArray(cadReq) ? cadReq : [cadReq];
    if (reqs.some((c) => c && c.shouldProcessCAD)) return true;
  }
  return false;
}

// Map the AI's decided intent to a loading-status category the client shows
// during the (slow) image phase — language-independent, unlike keyword guessing.
/**
 * Map the decided intent to a loading-status category the client shows during the slow
 * image phase — language-independent, unlike keyword guessing.
 * @param {import('../types/chat.js').StagingRequest | import('../types/chat.js').StagingRequest[] | null} stagingReq - The routing 'staging' request(s).
 * @param {import('../types/chat.js').GenerateRequest | import('../types/chat.js').GenerateRequest[] | null} generateReq - The routing 'generate' request(s).
 * @param {import('../types/chat.js').CadRequest | import('../types/chat.js').CadRequest[] | null} cadReq - The routing 'cad' request(s).
 * @returns {'staging' | 'generating' | 'general'} The loading-status category.
 */
export function chatIntentType(stagingReq, generateReq, cadReq) {
  const some = (r, k) => {
    const arr = Array.isArray(r) ? r : [r];
    return arr.some((x) => x && x[k]);
  };
  if (some(cadReq, 'shouldProcessCAD')) return 'staging';
  if (some(stagingReq, 'shouldStage')) return 'staging';
  if (some(generateReq, 'shouldGenerate')) return 'generating';
  return 'general';
}
