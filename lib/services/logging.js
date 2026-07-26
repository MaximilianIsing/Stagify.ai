// CSV/file logging helpers extracted from server.js.
//
// Factory pattern (see lib/data/enterprise-store.js, routes/billing.js): the module
// exports createLogging(deps); server.js injects its module-scope names
// (__dirname, DEBUG_MODE). The prompt/contact-count INITIALIZERS stay in
// server.js because they reassign server-scope counter state.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { escapeCsvField } from '../http/csv-escape.js';

/**
 * Build the CSV/file logging helpers bound to the injected base dir + debug flag.
 * @param {{ __dirname: string, DEBUG_MODE: boolean }} deps - The base directory for the `data/` folder and the debug flag.
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
  const { __dirname, DEBUG_MODE } = deps;

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

    // Use mounted disk on Render, project data folder locally
    let logDir;

    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      if (DEBUG_MODE) {
        logger.debug('Using Render persistent disk');
      }
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');

      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            logger.debug('Created local data directory successfully');
          }
        } catch {
          if (DEBUG_MODE) {
            logger.debug('Error: Cannot create data directory, using project root');
          }
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');

    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);

    if (!fileExists) {
      // Create new file with header and first row
      fs.writeFileSync(logFile, PROMPT_LOG_HEADER + '\n' + csvRow);
    } else {
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

    // Use mounted disk on Render, project data folder locally
    let logDir;

    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');

      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
        } catch {
          logger.info('Error: Cannot create data directory, using project root');
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'mask_logs.csv');

    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);

    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
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

function getDataLogDir() {
  if (process.env.RENDER && fs.existsSync('/data')) {
    return '/data';
  }
  const logDir = path.join(__dirname, 'data');
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      return __dirname;
    }
  }
  return logDir;
}

function logChatToFile(userId, userMessage, aiResponse, files, ipAddress, userAgent) {
  try {
    let logDir;

    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');

      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            logger.debug('Created local data directory successfully');
          }
        } catch {
          if (DEBUG_MODE) {
            logger.debug('Error: Cannot create data directory, using project root');
          }
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'chat_logs.csv');

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
