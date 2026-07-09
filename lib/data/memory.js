// Per-user AI chat memory storage + LLM-driven memory action evaluation.
// Extracted from server.js; now SQLite-backed via the shared app database.
import fs from 'fs';
import path from 'path';
import { resolveDataDir, getDb, closeDb } from './db.js';
import { logger } from '../logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  user_id TEXT PRIMARY KEY,
  data    TEXT NOT NULL
);
`;

function safeParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Legacy JSON reader — used ONCE to import an existing memories.json ({ userId: [...] }).
// Only ever READS the old file; it stays put as a rollback fallback.
function loadLegacyMemories(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function createMemory(deps) {
  const { __dirname, DEBUG_MODE, openai } = deps;
  const baseDir = __dirname;
  const legacyJsonPath = path.join(resolveDataDir(baseDir), 'memories.json');
  const db = getDb(baseDir);
  db.exec(SCHEMA);

  const q = {
    byUser: db.prepare('SELECT data FROM memories WHERE user_id = ?'),
    all: db.prepare('SELECT user_id, data FROM memories'),
    upsert: db.prepare(
      'INSERT INTO memories (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data'
    ),
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    delAll: db.prepare('DELETE FROM memories'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };

  // Every user's memories, in the legacy { userId: [...] } shape.
  function loadAllMemories() {
    const out = {};
    for (const row of q.all.all()) out[row.user_id] = safeParseArray(row.data);
    return out;
  }

  function loadMemories(userId) {
    const row = q.byUser.get(userId);
    return row ? safeParseArray(row.data) : [];
  }

  // Writes ONE user's row — no longer rewrites every user's memories.
  function saveMemories(userId, memories) {
    try {
      q.upsert.run(userId, JSON.stringify(memories || []));
      if (DEBUG_MODE) {
        logger.debug(`✓ Saved ${(memories || []).length} memories for user: ${userId}`);
      }
    } catch (error) {
      logger.error('✗ Error saving memories:', error);
      logger.error('User ID:', userId);
    }
  }

  function resetAllMemories() {
    q.delAll.run();
  }

  // One-time import from a legacy memories.json (guarded so it never re-runs
  // and clobbers live SQLite data).
  (function maybeImportLegacyMemories() {
    if (q.getMeta.get('memories_imported_from_json')) return;
    if (q.count.get().n > 0) {
      q.setMeta.run('memories_imported_from_json', `skipped-nonempty@${Date.now()}`);
      return;
    }
    const legacy = loadLegacyMemories(legacyJsonPath);
    const keys = legacy ? Object.keys(legacy) : [];
    if (keys.length > 0) {
      const importAll = db.transaction((obj) => {
        for (const userId of keys) {
          const arr = Array.isArray(obj[userId]) ? obj[userId] : [];
          q.upsert.run(userId, JSON.stringify(arr));
        }
      });
      importAll(legacy);
      q.setMeta.run(
        'memories_imported_from_json',
        `imported ${keys.length} users@${new Date().toISOString()}`
      );
    } else {
      q.setMeta.run('memories_imported_from_json', `nothing-to-import@${Date.now()}`);
    }
  })();

  async function evaluateMemoryActions(userMessage, aiResponse, currentMemories, _model = 'gpt-4o-mini') {
    try {
      if (!openai) {
        logger.error('OpenAI not initialized, cannot evaluate memory actions');
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
        logger.debug('Memory evaluation response:', responseText);
      }

      try {
        const result = JSON.parse(responseText);
        const stores = Array.isArray(result.stores) ? result.stores : [];
        const forgets = Array.isArray(result.forgets) ? result.forgets : [];

        if (DEBUG_MODE) {
          logger.debug('Memory actions parsed - Stores:', stores.length, 'Forgets:', forgets.length);
        }

        return { stores, forgets };
      } catch (parseError) {
        logger.error('Error parsing memory actions JSON:', parseError);
        logger.error('Response was:', responseText);
        return { stores: [], forgets: [] };
      }
    } catch (error) {
      logger.error('Error evaluating memory actions:', error);
      logger.error('Error details:', error.stack);
      return { stores: [], forgets: [] };
    }
  }

  return {
    loadAllMemories,
    loadMemories,
    saveMemories,
    evaluateMemoryActions,
    /** All users' memories in the legacy { userId: [...] } shape — admin backup. */
    exportAllMemories: loadAllMemories,
    /** Clear every user's memories (admin reset). */
    resetAllMemories,
    /** Close the shared DB handle (tests). */
    close: () => closeDb(baseDir),
  };
}
