// Per-user AI chat memory storage. Extracted from server.js; SQLite-backed via the
// shared app database.
//
// STORAGE ONLY — deciding *what* to remember is not done here. This module used to
// carry `evaluateMemoryActions`, a second OpenAI call with its own 55-line prompt that
// classified a conversation turn into stores/forgets. It was superseded and never
// called: the main routing model now emits `memories: { stores, forgets }` as part of
// its structured reply (`DESIGNER_ROUTING_SCHEMA` in lib/staging/prompts.js), and
// lib/chat/chat-memory.js applies it. One model call instead of two.
//
// So if memory *behaviour* needs changing, the levers are the routing schema and the
// system instruction that describes the field — not this file.
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

/**
 * Build the per-user memory store bound to a data directory.
 *
 * Takes no AI client on purpose — see the storage-only note at the top of this file.
 *
 * @param {{ __dirname: string, DEBUG_MODE: boolean }} deps - Base directory the shared
 *   SQLite connection is resolved against, and the debug-logging flag.
 * @returns {{ loadAllMemories: () => Record<string, any[]>, loadMemories: (userId: string) => any[],
 *   saveMemories: (userId: string, memories: any[]) => void, exportAllMemories: () => Record<string, any[]>,
 *   resetAllMemories: () => void, close: () => void }} The store API.
 */
export function createMemory(deps) {
  const { __dirname, DEBUG_MODE } = deps;
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
    /** @type {Record<string, any[]>} */
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

  return {
    loadAllMemories,
    loadMemories,
    saveMemories,
    /** All users' memories in the legacy { userId: [...] } shape — admin backup. */
    exportAllMemories: loadAllMemories,
    /** Clear every user's memories (admin reset). */
    resetAllMemories,
    /** Close the shared DB handle (tests). */
    close: () => closeDb(baseDir),
  };
}
