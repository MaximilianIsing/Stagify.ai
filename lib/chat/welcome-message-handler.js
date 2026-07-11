// GET /api/welcome-message handler, extracted verbatim from routes/chat.js.
//
// Returns a generic first-visit greeting, or — for a returning user who has
// stored memories — an AI-personalized welcome. Every failure path (no OpenAI
// client, a model error, or an unexpected throw) falls back to a static
// message, so the endpoint always resolves with a 200.
//
// deps: { openai, requireProAccount, loadMemories }
import { buildWelcomeMessagePrompt, WELCOME_MESSAGE_SYSTEM } from '../staging/prompts.js';
import { logger } from '../logger.js';

/**
 * Build the GET /api/welcome-message handler. Returns a generic greeting, or an
 * AI-personalized welcome for a returning user with stored memories. Every failure path
 * (no OpenAI client, a model error, or an unexpected throw) falls back to a static message,
 * so the endpoint always resolves with a 200.
 * @param {{ openai: any, requireProAccount: (req: import('express').Request, res: import('express').Response) => any, loadMemories: (userId: any) => any[] }} deps - Injected OpenAI client (loosely typed; unused when null), pro gate, and memory loader.
 * @returns {{ handleWelcomeMessage: (req: import('express').Request, res: import('express').Response) => Promise<import('express').Response | void> }} The welcome-message handler API.
 */
export default function createWelcomeMessageHandler(deps) {
  const { openai, requireProAccount, loadMemories } = deps;

  /**
   * Handle GET /api/welcome-message. Pro-gated; responds `{ message, isReturning }`.
   * @param {import('express').Request} req - Express request.
   * @param {import('express').Response} res - Express response.
   * @returns {Promise<import('express').Response | void>} Resolves after sending the JSON greeting (void when the pro gate already responded).
   */
  async function handleWelcomeMessage(req, res) {
    try {
      const proUser = requireProAccount(req, res);
      if (!proUser) return;

      // Key memories on the validated session account, never a client-supplied
      // ?userId query param (trusting that would leak another user's memories).
      const userId = proUser.id;

      // Load stored memories for this user
      const memories = loadMemories(userId);

      // Check if user has memories (returning user)
      const isReturningUser = memories && memories.length > 0;

      if (isReturningUser) {
        // Generate personalized welcome message using AI
        try {
          if (!openai) {
            // Fallback to generic if AI not available
            return res.json({
              message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
              isReturning: true
            });
          }

          const prompt = buildWelcomeMessagePrompt(memories);

          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: WELCOME_MESSAGE_SYSTEM },
              { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 150
          });

          const personalizedMessage = completion.choices[0].message.content.trim();

          return res.json({
            message: personalizedMessage,
            isReturning: true
          });
        } catch (error) {
          logger.error('Error generating personalized welcome message:', error);
          // Fallback to generic
          return res.json({
            message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
            isReturning: true
          });
        }
      } else {
        // First-time user - return generic welcome message
        return res.json({
          message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. I can help you:\n• Stage rooms by uploading images and describing your desired style\n• Answer questions about interior design and home staging\n• Modify and refine staged room designs\n• Convert your top-down floorplans into 3D renders\n\nUpload an image of a room to get started, or ask me anything about interior design!',
          isReturning: false
        });
      }
    } catch (error) {
      logger.error('Error in welcome message endpoint:', error);
      // Fallback to generic message
      res.json({
        message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. Upload an image of a room to get started, or ask me anything!',
        isReturning: false
      });
    }
  }

  return { handleWelcomeMessage };
}
