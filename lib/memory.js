// Per-user AI chat memory storage + LLM-driven memory action evaluation.
// Extracted from server.js.
import fs from 'fs';
import path from 'path';

export function createMemory(deps) {
  const { __dirname, DEBUG_MODE, openai } = deps;

  function getMemoriesFile() {
    const logDir = process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
    return path.join(logDir, 'memories.json');
  }

  function loadAllMemories() {
    try {
      const file = getMemoriesFile();
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file, 'utf8').trim();
        // If file is empty or only whitespace, initialize it
        if (!data || data === '') {
          const initialized = {};
          fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
          return initialized;
        }
        return JSON.parse(data);
      } else {
        // File doesn't exist, create it with empty object
        const logDir = path.dirname(file);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        const initialized = {};
        fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
        return initialized;
      }
    } catch (error) {
      console.error('Error loading memories:', error);
      // If JSON is invalid, reinitialize the file
      try {
        const file = getMemoriesFile();
        const logDir = path.dirname(file);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        const initialized = {};
        fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
        return initialized;
      } catch (initError) {
        console.error('Error initializing memories file:', initError);
        return {};
      }
    }
  }

  function loadMemories(userId) {
    const allMemories = loadAllMemories();
    return allMemories[userId] || [];
  }

  function saveMemories(userId, memories) {
    try {
      const file = getMemoriesFile();
      const logDir = path.dirname(file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const allMemories = loadAllMemories();
      allMemories[userId] = memories;
      fs.writeFileSync(file, JSON.stringify(allMemories, null, 2));
      if (DEBUG_MODE) {
        console.log(`✓ Successfully saved ${memories.length} memories for user: ${userId} to ${file}`);
      }

      if (DEBUG_MODE) {
        console.log('All memories structure:', JSON.stringify(allMemories, null, 2));
      }
    } catch (error) {
      console.error('✗ Error saving memories:', error);
      console.error('Error details:', error.stack);
      console.error('File path:', getMemoriesFile());
      console.error('User ID:', userId);
      console.error('Memories to save:', JSON.stringify(memories, null, 2));
    }
  }

  async function evaluateMemoryActions(userMessage, aiResponse, currentMemories, model = 'gpt-4o-mini') {
    try {
      if (!openai) {
        console.error('OpenAI not initialized, cannot evaluate memory actions');
        return { stores: [], forgets: [] };
      }

      // Build current memories list for context
      let memoriesContext = '';
      if (currentMemories && currentMemories.length > 0) {
        memoriesContext = '\n\nCurrent stored memories:\n';
        currentMemories.forEach((memory, index) => {
          memoriesContext += `${index + 1}. [ID: ${memory.id}] ${memory.content}\n`;
        });
      }

      const prompt = `You are a memory management system. Analyze the following conversation and determine if any memory actions should be taken.

User message: "${userMessage}"
AI response: "${aiResponse}"${memoriesContext}

You can perform two types of actions:
1. STORE: Store new important information as a permanent memory (you can store MULTIPLE memories from one message)
2. FORGET: Delete an existing memory that is no longer relevant, incorrect, or the user wants forgotten

CRITICAL RULES - Only store GENERAL, LONG-TERM preferences that apply to ALL future conversations:

✅ DO store ONLY:
- User's profession/role (e.g., "User is a real estate agent", "User works in interior design")
- User's personal name or identity information
- General design philosophy or approach (e.g., "User prefers sustainable/eco-friendly design", "User focuses on accessibility")
- Long-term business context (e.g., "User runs a staging company", "User specializes in luxury properties")

❌ DO NOT store (these are generation-specific and should NEVER be saved):
- ANY room-specific requests (e.g., "stage this bedroom", "this living room", "this kitchen")
- ANY image-specific requests (e.g., "stage this image", "this photo", "this room")
- ANY styling requests for a specific generation (e.g., "coastal theme", "modern style", "luxury furniture" - these are for ONE image, not a general preference)
- ANY furniture or decor preferences mentioned in context of a specific image
- ANY color, material, or design choices for a specific room/image
- Temporary requests or one-time instructions
- Context about uploaded images, staging requests, or generation tasks
- Any request that includes words like "this", "that", "the image", "the room", "stage", "generate", "create"

When in doubt, DO NOT store. Only store information that:
1. Applies to ALL future conversations regardless of what the user is working on
2. Is about the USER themselves, not about their work or requests
3. Would be useful even if the user never mentions images, staging, or design again
4. Is explicitly stated as a general preference (e.g., "I always prefer modern design" vs "make this modern")

Consider forgetting a memory if:
- The user explicitly asks to forget something
- A stored memory is incorrect or outdated
- The user contradicts a previous memory
- The memory is no longer relevant
- The memory is actually generation-specific (clean up old mistakes)

You can perform MULTIPLE actions in one response. For example, you can forget an old memory AND store a new one, or store multiple new memories.

Respond with a JSON object in this exact format:
{
  "stores": ["memory description 1", "memory description 2", ...],
  "forgets": ["memory ID 1", "memory ID 2", ...]
}

If no actions are needed, return: {"stores": [], "forgets": []}
If storing memories, include brief descriptions in the "stores" array.
If forgetting memories, include the memory IDs from the current memories list in the "forgets" array.
If the user wants to forget ALL memories, use "forgets": ["all"] - this will clear all stored memories for the user.

Be EXTREMELY selective. The default should be to NOT store anything. Only store if you are 100% certain it is a general, long-term preference about the user themselves, not about their work or specific requests.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a memory management system. Always respond with valid JSON only, no other text." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: "json_object" }
      });

      const responseText = completion.choices[0].message.content.trim();

      if (DEBUG_MODE) {
        console.log('Memory evaluation response:', responseText);
      }

      try {
        const result = JSON.parse(responseText);
        const stores = Array.isArray(result.stores) ? result.stores : [];
        const forgets = Array.isArray(result.forgets) ? result.forgets : [];

        if (DEBUG_MODE) {
          console.log('Memory actions parsed - Stores:', stores.length, 'Forgets:', forgets.length);
        }

        return { stores, forgets };
      } catch (parseError) {
        console.error('Error parsing memory actions JSON:', parseError);
        console.error('Response was:', responseText);
        return { stores: [], forgets: [] };
      }
    } catch (error) {
      console.error('Error evaluating memory actions:', error);
      console.error('Error details:', error.stack);
      return { stores: [], forgets: [] };
    }
  }

  return { getMemoriesFile, loadAllMemories, loadMemories, saveMemories, evaluateMemoryActions };
}
