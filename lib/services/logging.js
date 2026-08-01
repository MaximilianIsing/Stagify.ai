// CSV/file logging helpers extracted from server.js.
//
// Factory pattern (see lib/data/enterprise-store.js, routes/billing.js): the module
// exports createLogging(deps); server.js injects its module-scope __dirname, which
// is what the CSVs are resolved against. The prompt/contact-count INITIALIZERS stay
// in server.js because they reassign server-scope counter state.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { escapeCsvField } from '../http/csv-escape.js';
import { resolveDataDir } from '../data/data-dir.js';

/**
 * Absolute ceiling on any one CSV in this module, in bytes.
 *
 * These three files are APPEND-ONLY and were the only writers on the volume with no bound
 * at all — `bug_reports.csv` and `email_open_logs.csv` both grew one years ago and got a
 * ceiling; these did not. That mattered more once the Listing Studio landed: a single
 * 30-photo listing at three variations writes ~80 prompt rows where the one-photo stager
 * wrote one, and `chat_logs.csv` carries whole user messages and model replies.
 *
 * They share the volume with SQLite's WAL, so an unbounded log does not merely waste disk —
 * a full volume takes auth, sessions and Stripe webhooks down with it. The blast radius is
 * the whole app, which is why a log file needs a ceiling at all.
 *
 * 64 MB each: years of real traffic, and small enough that all three together cannot
 * threaten the 20 GB disk. Raise or lower per deploy via the env var of the same name.
 */
export const CSV_LOG_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The effective ceiling, so an operator can move it without a code change. A missing or
 * nonsense value falls back to the constant rather than to "unbounded".
 * @returns {number} Bytes.
 */
export function csvLogMaxBytes() {
  const override = Number(process.env.CSV_LOG_MAX_BYTES);
  return Number.isFinite(override) && override > 0 ? override : CSV_LOG_MAX_BYTES;
}

// One warning per file per process. A full log would otherwise emit a line per render,
// turning a disk problem into a log-volume problem of its own.
const ceilingWarned = new Set();

/**
 * Whether one more row may be appended to `logFile`.
 *
 * SKIPS THE ROW, never truncates and never rotates. Truncation would silently drop history
 * an operator may be relying on, and `prompt_logs.csv` in particular is what seeds the
 * public "Rooms Staged" count at boot — rewriting it would move a public number. Refusing
 * to grow is the honest failure: the log stops, and nothing else does.
 *
 * A stat error is treated as "allowed". The alternative — failing closed — would mean a
 * transient fs hiccup silently stops all analytics, and this function must never be the
 * reason a paid render is not recorded.
 * @param {string} logFile - Absolute path.
 * @returns {boolean} True when the append may proceed.
 */
function withinCeiling(logFile) {
  try {
    const { size } = fs.statSync(logFile);
    if (size < csvLogMaxBytes()) return true;
    if (!ceilingWarned.has(logFile)) {
      ceilingWarned.add(logFile);
      logger.warn(`[logging] ${path.basename(logFile)} reached ${Math.round(size / (1024 * 1024))}MB `
        + '— no further rows will be written. Download and archive it, or raise CSV_LOG_MAX_BYTES.');
    }
    return false;
  } catch {
    // No file yet, or it could not be stat'd: let the writer decide.
    return true;
  }
}

/**
 * Build the CSV/file logging helpers bound to the injected base dir.
 * @param {{ __dirname: string }} deps - The base directory to resolve the `data/` folder against.
 * @returns {{ getDataLogDir: () => string, escapeCsvField: (field: any) => string, logPromptToFile: (promptText: string, roomType: string, furnitureStyle: string, additionalPrompt: string, removeFurniture: boolean | string, userRole: string, userReferralSource: string, userEmail: string, req: import('express').Request | null, outcome?: { status?: string, durationMs?: number, model?: string, attempts?: number, errorCode?: string }) => void, logMaskEditToFile: (prompt: string, model: string, geminiModel: string, imageWidth: number, imageHeight: number, userId: string, req: import('express').Request) => void, logChatToFile: (userId: string, userMessage: string, aiResponse: string, files: any[], ipAddress: string, userAgent: string) => void }} The CSV logging API.
 */
// prompt_logs.csv column order. The five outcome columns were appended (never
// inserted) so a row written before they existed still parses correctly — the
// admin dashboard reads these files BY INDEX, so inserting a column mid-row
// would silently re-label every historical render.
const PROMPT_LOG_HEADER = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress,status,durationMs,model,attempts,errorCode';
// The pre-outcome header, kept only so an existing file can be upgraded in place.
const PROMPT_LOG_HEADER_LEGACY = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress';

export function createLogging(deps) {
  const { __dirname } = deps;

  // A file written before the outcome columns existed still carries the legacy
  // header, which would mislabel the new columns for anyone opening the download
  // in a spreadsheet. Rewrite just that first line, once per process, via
  // temp+rename so a crash mid-write can't truncate the log. The data rows are
  // left alone: their missing trailing cells read as empty, which is exactly what
  // "outcome unknown" should look like.
  let promptHeaderChecked = false;
  function upgradePromptLogHeader(logFile) {
    if (promptHeaderChecked) return;
    promptHeaderChecked = true;
    try {
      const text = fs.readFileSync(logFile, 'utf8');
      const brk = text.indexOf('\n');
      if (brk === -1) return;
      if (text.slice(0, brk).replace(/\r$/, '') !== PROMPT_LOG_HEADER_LEGACY) return;
      const tmp = logFile + '.tmp';
      fs.writeFileSync(tmp, PROMPT_LOG_HEADER + '\n' + text.slice(brk + 1));
      fs.renameSync(tmp, logFile);
      logger.info('[logging] Upgraded prompt_logs.csv header with the outcome columns');
    } catch (e) {
      logger.warn('[logging] Could not upgrade the prompt log header:', e.message);
    }
  }

/**
 * Append one staging render to prompt_logs.csv.
 *
 * Called ONCE per request, AFTER the model call resolves or rejects — the row is
 * a record of what happened, not of what was attempted. `outcome` carries that
 * result; omit it and the outcome columns read as unknown, same as a legacy row.
 * @param {object} [outcome] - Result of the render.
 * @param {string} [outcome.status] - 'ok' or 'failed'.
 * @param {number} [outcome.durationMs] - Wall-clock time of the whole request.
 * @param {string} [outcome.model] - Resolved Gemini model id.
 * @param {number} [outcome.attempts] - Images produced, incl. quality-gate retries.
 * @param {string} [outcome.errorCode] - Short failure code when status is 'failed'.
 */
function logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, userReferralSource, userEmail, req, outcome) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';
    const o = outcome || {};
    // typeof, not just Number.isFinite: the latter doesn't narrow `number | undefined`.
    const durationMs = typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) ? String(Math.round(o.durationMs)) : '';
    const attempts = typeof o.attempts === 'number' && Number.isFinite(o.attempts) ? String(o.attempts) : '';

    // Create CSV row
    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(roomType),
      escapeCsvField(furnitureStyle),
      escapeCsvField(additionalPrompt || ''),
      escapeCsvField(removeFurniture),
      escapeCsvField(userRole || 'unknown'),
      escapeCsvField(userReferralSource || 'unknown'),
      escapeCsvField(userEmail || 'unknown'),
      escapeCsvField(ipAddress),
      escapeCsvField(o.status || 'unknown'),
      escapeCsvField(durationMs),
      escapeCsvField(o.model || 'unknown'),
      escapeCsvField(attempts),
      escapeCsvField(o.errorCode || '')
    ].join(',') + '\n';

    const logFile = path.join(getDataLogDir(), 'prompt_logs.csv');

    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);

    if (!fileExists) {
      // Create new file with header and first row
      fs.writeFileSync(logFile, PROMPT_LOG_HEADER + '\n' + csvRow);
    } else {
      // The absolute ceiling. Checked here rather than around the whole function so a
      // BRAND NEW file is always created — a ceiling must never stop logging from starting.
      if (!withinCeiling(logFile)) return;
      // Bring a pre-outcome file's header up to date before the first append.
      upgradePromptLogHeader(logFile);
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          logger.error('Error writing to prompt log:', err);
        }
      });
    }
  } catch (error) {
    logger.error('Error in logPromptToFile:', error);
  }
}

// Function to log mask edits to CSV file
function logMaskEditToFile(prompt, model, geminiModel, imageWidth, imageHeight, userId, req) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';
    const userAgent = req ? (req.get('user-agent') || 'unknown') : 'unknown';

    // Create CSV row
    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(prompt || ''),
      escapeCsvField(model || 'unknown'),
      escapeCsvField(geminiModel || 'unknown'),
      escapeCsvField(imageWidth || ''),
      escapeCsvField(imageHeight || ''),
      escapeCsvField(userId || 'unknown'),
      escapeCsvField(ipAddress),
      escapeCsvField(userAgent)
    ].join(',') + '\n';

    const logFile = path.join(getDataLogDir(), 'mask_logs.csv');

    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);

    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // The absolute ceiling — see withinCeiling. A new file is always created; only
      // growth is refused.
      if (!withinCeiling(logFile)) return;
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          logger.error('Error writing to mask log:', err);
        }
      });
    }
  } catch (error) {
    logger.error('Error in logMaskEditToFile:', error);
  }
}

// Where every CSV in this module is written: Render's mounted disk in production,
// <__dirname>/data locally. The rule itself lives in lib/data/data-dir.js — this is
// just the module's bound-to-__dirname view of it.
function getDataLogDir() {
  return resolveDataDir(__dirname);
}

function logChatToFile(userId, userMessage, aiResponse, files, ipAddress, userAgent) {
  try {
    const logFile = path.join(getDataLogDir(), 'chat_logs.csv');

    const timestamp = new Date().toISOString();
    const fileNames = files && files.length > 0 ? files.map(f => f.name || f.originalname || 'unknown').join('; ') : '';
    const fileTypes = files && files.length > 0 ? files.map(f => f.type || f.mimetype || 'unknown').join('; ') : '';

    // Only log user message, not AI response
    const csvRow = `${timestamp},${escapeCsvField(userId)},${escapeCsvField(userMessage)},${escapeCsvField('')},${escapeCsvField(fileNames)},${escapeCsvField(fileTypes)},${escapeCsvField(ipAddress)},${escapeCsvField(userAgent)}\n`;

    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);

    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // The absolute ceiling — see withinCeiling. A new file is always created; only
      // growth is refused.
      if (!withinCeiling(logFile)) return;
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          logger.error('Error writing to chat log:', err);
        }
      });
    }
  } catch (error) {
    logger.error('Error in logChatToFile:', error);
  }
}

  return {
    getDataLogDir,
    escapeCsvField,
    logPromptToFile,
    logMaskEditToFile,
    logChatToFile,
  };
}
