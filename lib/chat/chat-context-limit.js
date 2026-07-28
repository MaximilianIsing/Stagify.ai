// Conversation-length cap shared by /api/chat and /api/chat-upload, extracted
// verbatim from routes/chat.js.
//
// A single conversation is capped at MAX_USER_MESSAGES user messages before the
// client must start a fresh chat. Keeps the model's context window (and the
// per-request cost) bounded; the client resets by reloading the chat.
//
// Pure and dependency-free: both handlers ask `isContextLimitReached(history)`
// and, when it is true, return `buildContextLimitResponse()` as a 200 JSON body
// (NOT an error) — the client keys off the `contextLimitReached` flag.

/** Maximum number of user messages allowed in one conversation. */
export const MAX_USER_MESSAGES = 20;

/** The user-facing message returned once the cap is hit. */
export const CONTEXT_LIMIT_MESSAGE =
  `You've reached the maximum conversation context limit (${MAX_USER_MESSAGES} messages). ` +
  'Please reload the chat by clicking the reload button (↻) to the left of the file upload ' +
  'button to start a fresh conversation.';

/**
 * Count the `role: 'user'` turns in a conversation.
 * @param {Array<{ role: string }>} messages - Conversation messages (deduplicated by the caller).
 * @returns {number} How many of them are user turns.
 */
export function countUserMessages(messages) {
  return messages.filter(msg => msg.role === 'user').length;
}

/**
 * Whether the conversation has hit the user-message cap. The comparison is `>=`,
 * matching the original inline check: the 20th user message is already refused.
 * @param {Array<{ role: string }>} messages - Conversation messages (deduplicated by the caller).
 * @returns {boolean} True when the caller must answer with the context-limit body.
 */
export function isContextLimitReached(messages) {
  return countUserMessages(messages) >= MAX_USER_MESSAGES;
}

/**
 * The 200 JSON body both handlers return once the cap is hit.
 * @returns {{ response: string, contextLimitReached: true }} The context-limit response body.
 */
export function buildContextLimitResponse() {
  return {
    response: CONTEXT_LIMIT_MESSAGE,
    contextLimitReached: true,
  };
}
