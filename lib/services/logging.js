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
import { appendCsvRow } from './csv-append.js';

/**
 * Build the CSV/file logging helpers bound to the injected base dir.
 * @param {{ __dirname: string }} deps - The base directory to resolve the `data/` folder against.
 * @returns {{ getDataLogDir: () => string, escapeCsvField: (field: any) => string, logPromptToFile: (promptText: string, roomType: string, furnitureStyle: string, additionalPrompt: string, removeFurniture: boolean | string, userRole: string, userReferralSource: string, userEmail: string, req: import('express').Request | null, outcome?: { status?: string, durationMs?: number, model?: string, attempts?: number, errorCode?: string }) => void, logMaskEditToFile: (prompt: string, model: string, geminiModel: string, imageWidth: number, imageHeight: number, userId: string, req: import('express').Request) => void, logChatToFile: (userId: string, userMessage: string, aiResponse: string, files: any[], ipAddress: string, userAgent: string) => void, logRejectionToFile: (kind: string, code: string, detail?: string, who?: { email?: string|null, userId?: string|null, req?: import('express').Request|null }) => void }} The CSV logging API.
 */
// prompt_logs.csv column order. The five outcome columns were appended (never
// inserted) so a row written before they existed still parses correctly — the
// admin dashboard reads these files BY INDEX, so inserting a column mid-row
// would silently re-label every historical render.
const PROMPT_LOG_HEADER = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress,status,durationMs,model,attempts,errorCode';
// The pre-outcome header, kept only so an existing file can be upgraded in place.
const PROMPT_LOG_HEADER_LEGACY = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress';
// Headers for the other two logs. Named constants (rather than inline strings at the
// write site) so appendCsvRow gets the same value on the create and append paths.
const MASK_LOG_HEADER = 'timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent';
const CHAT_LOG_HEADER = 'timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent';
// rejection_logs.csv — requests that were turned away BEFORE any render happened.
//
// Deliberately its own file rather than rows in prompt_logs.csv: the dashboard counts
// every prompt-log row as a generation, so folding rejections in there would inflate
// the headline "Generations" number and the success rate with things that never ran.
// A rejection is a different kind of event and gets a different table.
const REJECTION_LOG_HEADER = 'timestamp,kind,code,detail,email,userId,ipAddress,userAgent';

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

    // Bring a pre-outcome file's header up to date before appending. Harmless when
    // the file does not exist yet — it returns without touching anything, and
    // appendCsvRow then writes the current header.
    upgradePromptLogHeader(logFile);
    appendCsvRow(logFile, PROMPT_LOG_HEADER, csvRow, 'prompt log');
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
    appendCsvRow(logFile, MASK_LOG_HEADER, csvRow, 'mask log');
  } catch (error) {
    logger.error('Error in logMaskEditToFile:', error);
  }
}

/**
 * Append one turned-away request to rejection_logs.csv.
 *
 * These are the drop-offs the product could previously not see at all. An upload the
 * stageability gate refused, a free account hitting its daily cap, a caller bouncing
 * off a rate limiter — none of them reach processStaging, so none of them wrote a row
 * anywhere. The single most likely first-session abandonment (upload the wrong photo,
 * get refused, leave) produced zero evidence that it had happened.
 *
 * Best-effort like every other writer here: it never throws, because a failure to
 * record a rejection must not turn into a second failure for the user.
 * @param {string} kind - Event class: 'unstageable' | 'daily_limit' | 'rate_limit' | 'file_too_large'.
 * @param {string} code - Stable machine code (e.g. an UNSTAGEABLE category, 'DAILY_LIMIT_REACHED', the limiter name).
 * @param {string} [detail] - Optional human/diagnostic detail (e.g. '50/50', the byte size).
 * @param {{ email?: string|null, userId?: string|null, req?: import('express').Request|null }} [who] - Who was turned away; email/userId come from the validated session where one exists.
 * @returns {void}
 */
function logRejectionToFile(kind, code, detail, who = {}) {
  try {
    const req = who.req || null;
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection?.remoteAddress || 'unknown') : 'unknown';
    const userAgent = req && typeof req.get === 'function' ? (req.get('user-agent') || 'unknown') : 'unknown';

    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(kind || 'unknown'),
      escapeCsvField(code || 'unknown'),
      escapeCsvField(detail || ''),
      escapeCsvField(who.email || 'unknown'),
      escapeCsvField(who.userId || 'unknown'),
      escapeCsvField(ipAddress),
      escapeCsvField(userAgent),
    ].join(',') + '\n';

    const logFile = path.join(getDataLogDir(), 'rejection_logs.csv');
    appendCsvRow(logFile, REJECTION_LOG_HEADER, csvRow, 'rejection log');
  } catch (error) {
    logger.error('Error in logRejectionToFile:', error);
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

    appendCsvRow(logFile, CHAT_LOG_HEADER, csvRow, 'chat log');
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
    logRejectionToFile,
  };
}
