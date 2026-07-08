// Single source of truth for the boot-time debug flags.
//
// DEBUG_MODE / EMAIL_DEBUG_MODE were previously computed inline in server.js and
// then either closed over by in-server free functions OR copied by value into
// every router deps bag. That split meant a function extracted to lib/ had no way
// to read the same flag without threading it. Computing them once here — from the
// same env vars / fallback files, at module load (after load-env.js populates
// process.env) — lets any module import the identical value. Behavior-preserving:
// same precedence (env var, then file) and same boot log lines as before.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function computeFlag(envVar, fallbackFile) {
  let value = process.env[envVar];
  if (value === undefined) {
    const file = path.join(rootDir, fallbackFile);
    if (fs.existsSync(file)) {
      value = fs.readFileSync(file, 'utf8').trim();
    }
  }
  return value === undefined ? undefined : value.toLowerCase() === 'true';
}

// Debug mode - check environment variable first, then fall back to debug.txt
export let DEBUG_MODE = false;
try {
  const flag = computeFlag('DEBUG', 'debug.txt');
  if (flag !== undefined) {
    DEBUG_MODE = flag;
    if (DEBUG_MODE) {
      console.log(`Debug mode: ${DEBUG_MODE ? 'ENABLED' : 'DISABLED'}`);
    }
  }
} catch (error) {
  console.error('Error reading debug configuration:', error.message);
  DEBUG_MODE = false;
}

// Email debug mode - if true, redirect all outbound mail to DEBUG_EMAIL (local/staging only).
export const DEBUG_EMAIL = 'maximilianbising@gmail.com';
export let EMAIL_DEBUG_MODE = false;
try {
  const flag = computeFlag('EMAIL_DEBUG', 'emaildebug.txt');
  if (flag !== undefined) {
    EMAIL_DEBUG_MODE = flag;
  }
  if (EMAIL_DEBUG_MODE) {
    console.log(`Email debug mode: ENABLED - All emails will be sent to ${DEBUG_EMAIL}`);
  } else {
    console.log('Email debug mode: DISABLED - Emails go to actual recipients');
  }
} catch (error) {
  console.error('Error reading email debug configuration:', error.message);
  EMAIL_DEBUG_MODE = false;
  console.log('Email debug mode: DISABLED (default after error)');
}
