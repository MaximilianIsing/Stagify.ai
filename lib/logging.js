// CSV/file logging helpers extracted from server.js.
//
// Factory pattern (see lib/enterprise-store.js, routes/billing.js): the module
// exports createLogging(deps); server.js injects its module-scope names
// (__dirname, DEBUG_MODE). The prompt/contact-count INITIALIZERS stay in
// server.js because they reassign server-scope counter state.
import fs from 'fs';
import path from 'path';

export function createLogging(deps) {
  const { __dirname, DEBUG_MODE } = deps;

function logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, userReferralSource, userEmail, req) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';

    // Escape CSV fields that contain commas, quotes, or newlines
    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    // Create CSV row
    const csvRow = [
      escapeCSVField(timestamp),
      escapeCSVField(roomType),
      escapeCSVField(furnitureStyle),
      escapeCSVField(additionalPrompt || ''),
      escapeCSVField(removeFurniture),
      escapeCSVField(userRole || 'unknown'),
      escapeCSVField(userReferralSource || 'unknown'),
      escapeCSVField(userEmail || 'unknown'),
      escapeCSVField(ipAddress)
    ].join(',') + '\n';

    // Use mounted disk on Render, project data folder locally
    let logDir;

    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      if (DEBUG_MODE) {
        console.log('Using Render persistent disk');
      }
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');

      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            console.log('Created local data directory successfully');
          }
        } catch {
          if (DEBUG_MODE) {
            console.log('Error: Cannot create data directory, using project root');
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
      const header = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to prompt log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logPromptToFile:', error);
  }
}

// Function to log mask edits to CSV file
function logMaskEditToFile(prompt, model, geminiModel, imageWidth, imageHeight, userId, req) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';
    const userAgent = req ? (req.get('user-agent') || 'unknown') : 'unknown';

    // Escape CSV fields that contain commas, quotes, or newlines
    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    // Create CSV row
    const csvRow = [
      escapeCSVField(timestamp),
      escapeCSVField(prompt || ''),
      escapeCSVField(model || 'unknown'),
      escapeCSVField(geminiModel || 'unknown'),
      escapeCSVField(imageWidth || ''),
      escapeCSVField(imageHeight || ''),
      escapeCSVField(userId || 'unknown'),
      escapeCSVField(ipAddress),
      escapeCSVField(userAgent)
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
          console.log('Error: Cannot create data directory, using project root');
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
          console.error('Error writing to mask log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logMaskEditToFile:', error);
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

function escapeCsvField(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
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
            console.log('Created local data directory successfully');
          }
        } catch {
          if (DEBUG_MODE) {
            console.log('Error: Cannot create data directory, using project root');
          }
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'chat_logs.csv');

    const timestamp = new Date().toISOString();
    const fileNames = files && files.length > 0 ? files.map(f => f.name || f.originalname || 'unknown').join('; ') : '';
    const fileTypes = files && files.length > 0 ? files.map(f => f.type || f.mimetype || 'unknown').join('; ') : '';

    // Escape commas and quotes in CSV
    const escapeCSV = (str) => {
      if (!str) return '';
      return '"' + String(str).replace(/"/g, '""') + '"';
    };

    // Only log user message, not AI response
    const csvRow = `${timestamp},${escapeCSV(userId)},${escapeCSV(userMessage)},${escapeCSV('')},${escapeCSV(fileNames)},${escapeCSV(fileTypes)},${escapeCSV(ipAddress)},${escapeCSV(userAgent)}\n`;

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
          console.error('Error writing to chat log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logChatToFile:', error);
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
