// Memory-dispatch slice of the AI Designer pipeline (lib/chat/chat-pipeline.js):
// applies the AI's memory store/forget decisions against the user's memory list.
//
// deps: { DEBUG_MODE, saveMemories }. DEBUG_MODE is read from the injected deps
// bundle (NOT lib/config/runtime-flags.js) so the test's injected value governs
// logging.
import { logger } from '../logger.js';

/**
 * Build the memory-dispatch bundle: applies the AI's store/forget decisions
 * against a user's memory list. DEBUG_MODE is read from the injected `deps`
 * bundle (not runtime-flags) so a test's injected value governs logging.
 * @param {{ DEBUG_MODE: boolean, saveMemories: (userId: string, memories: import('../types/chat.js').Memory[]) => void }} deps - Injected dependencies.
 * @returns {{ applyMemoryActions: Function }} The memory-dispatch bundle.
 */
export default function createMemoryDispatch(deps) {
  const { DEBUG_MODE, saveMemories } = deps;

  /**
   * Apply the AI's memory stores/forgets against the user's memory list.
   * Reassigns `memories` internally (forget = filter), so callers MUST use the
   * returned list. `forgets:['all']` wipes everything; individual forgets try an
   * exact id match then a fuzzy content match. Blank stores are skipped, and
   * saveMemories runs only when something changed. No-op unless both
   * `userMessageText` and `memoryActionsFromAI` are truthy.
   * @param {{ memoryActionsFromAI: { stores?: string[], forgets?: string[] } | null, memories: import('../types/chat.js').Memory[], userId: string, userMessageText: string }} args - AI store/forget decisions plus the user's current memory list.
   * @returns {{ memories: import('../types/chat.js').Memory[], memoryActions: import('../types/chat.js').MemoryActions }} The updated memory list and the actions actually applied.
   */
  function applyMemoryActions({ memoryActionsFromAI, memories, userId, userMessageText }) {
    const memoryActions = { stores: [], forgets: [] };
    if (userMessageText && memoryActionsFromAI) {
      if (DEBUG_MODE) {
        logger.debug(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      }

      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          if (DEBUG_MODE) {
            logger.debug(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
          }
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);

            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              if (DEBUG_MODE) {
                logger.debug(`Forgot memory with ID for user ${userId}:`, memoryId);
              }
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m =>
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );

              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                if (DEBUG_MODE) {
                  logger.debug(`Forgot memory for user ${userId}:`, memoryToForget.content);
                }
              }
            }
          }
        }
      }

      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: userMessageText.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            if (DEBUG_MODE) {
              logger.debug(`Stored new memory for user ${userId}:`, newMemory.content);
            }
          }
        }
      }

      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }
    return { memories, memoryActions };
  }

  return { applyMemoryActions };
}
