// Single source of truth for the boot-time env flags (debug, staging, stats).
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

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // two levels up: lib/config/ -> repo root

// Reads a setting from the env var first, falling back to a gitignored .txt file
// in the repo root. Returns the trimmed string, or undefined when neither source
// supplies one (so callers can tell "unset" from "set to empty").
function computeSetting(envVar, fallbackFile) {
  let value = process.env[envVar];
  if (value === undefined) {
    const file = path.join(rootDir, fallbackFile);
    if (fs.existsSync(file)) {
      value = fs.readFileSync(file, 'utf8');
    }
  }
  return value === undefined ? undefined : value.trim();
}

function computeFlag(envVar, fallbackFile) {
  const value = computeSetting(envVar, fallbackFile);
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
// The sink address is deployment config, NOT a source constant: it used to be a
// hardcoded developer address, which silently made every fork/self-host redirect
// its debug mail into one person's inbox. Empty string when unconfigured, which
// only matters when EMAIL_DEBUG is on — see the guard below.
export const DEBUG_EMAIL = computeSetting('DEBUG_EMAIL', 'debugemail.txt') || '';
export let EMAIL_DEBUG_MODE = false;
let emailDebugReadFailed = false;
try {
  const flag = computeFlag('EMAIL_DEBUG', 'emaildebug.txt');
  if (flag !== undefined) {
    EMAIL_DEBUG_MODE = flag;
  }
} catch (error) {
  console.error('Error reading email debug configuration:', error.message);
  EMAIL_DEBUG_MODE = false;
  emailDebugReadFailed = true;
  console.log('Email debug mode: DISABLED (default after error)');
}
// Every consumer spells the redirect `EMAIL_DEBUG_MODE ? DEBUG_EMAIL : toEmail`, so
// an enabled flag with no address would send mail to '' — or, if we "helpfully"
// defaulted the flag back to false, to the REAL recipients, which is precisely what
// the operator turned the flag on to prevent. Refuse to boot instead. This can only
// fire where someone deliberately set EMAIL_DEBUG, and it is deliberately thrown
// outside the try above so the catch cannot swallow it into a silent send.
if (EMAIL_DEBUG_MODE && !DEBUG_EMAIL) {
  throw new Error(
    'EMAIL_DEBUG is enabled but DEBUG_EMAIL is empty. Set DEBUG_EMAIL=<address> ' +
    '(or create debugemail.txt) so redirected mail has a destination, or turn EMAIL_DEBUG off.'
  );
}
if (!emailDebugReadFailed) {
  if (EMAIL_DEBUG_MODE) {
    console.log(`Email debug mode: ENABLED - All emails will be sent to ${DEBUG_EMAIL}`);
  } else {
    console.log('Email debug mode: DISABLED - Emails go to actual recipients');
  }
}

// --- Staging environment flags -----------------------------------------------
// When IS_STAGING is truthy ("1"/"true"/"on"/"yes") this deploy is the Stagify
// *staging* (test) site, not production. In that mode we disable the real
// third-party sign-up/payment paths: Google sign-in is turned off (both the UI,
// via /api/auth/config, and the /api/auth/google endpoint) and the Stripe
// subscribe / "Stripe help center" buttons are blocked or hidden in the UI.
// Off by default, so production behaviour is unchanged. HIDE_STAGING_BANNER hides
// ONLY the red staging banner (e.g. for screenshots) — it does NOT re-enable Google
// sign-in or Stripe. server.js emits the boot log so its ordering is unchanged.
export const isTruthyFlag = (v) => /^(1|true|on|yes)$/i.test(String(v || '').trim());
export const IS_STAGING = isTruthyFlag(process.env.IS_STAGING);
export const HIDE_STAGING_BANNER = isTruthyFlag(process.env.HIDE_STAGING_BANNER);
export const SHOW_STAGING_BANNER = IS_STAGING && !HIDE_STAGING_BANNER;

// --- Home-page hero-stat overrides -------------------------------------------
// When STATS_DEBUG=true the home-page hero stats (Rooms Staged / Users Served) are
// faked to the fixed numbers DEBUG_ROOMS / DEBUG_USERS instead of the real counts.
// Each override parses to a finite number, or NaN if unset/blank/non-numeric (so it
// falls back to the real count rather than silently becoming 0). server.js emits the
// boot log so its ordering is unchanged.
export const parseStatOverride = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
export const STATS_DEBUG = String(process.env.STATS_DEBUG || '').trim().toLowerCase() === 'true';
export const DEBUG_ROOMS = parseStatOverride(process.env.DEBUG_ROOMS);
export const DEBUG_USERS = parseStatOverride(process.env.DEBUG_USERS);
