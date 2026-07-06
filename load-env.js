// Minimal, zero-dependency .env loader.
//
// Reads KEY=VALUE lines from a .env file in the project root and copies them
// into process.env. Imported for its side effect at the very top of server.js
// (before any module that reads a secret), so the rest of the app can keep using
// process.env.* exactly as it already does.
//
// Design notes:
//  - Host-provided vars WIN: we never overwrite a variable that is already set
//    in the environment. In production (Render) the real secrets come from the
//    dashboard and there is no .env file, so this is a no-op there. Locally, the
//    .env fills in the same variables the code already falls back to.
//  - .env is gitignored (see .gitignore) — it holds real secrets and must never
//    be committed. .env.example documents the keys without values.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');

try {
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
    let loaded = 0;
    for (let rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;      // blank or comment
      const eq = line.indexOf('=');
      if (eq === -1) continue;                            // not a KEY=VALUE line
      const key = line.slice(0, eq).trim();
      if (!key) continue;
      let val = line.slice(eq + 1).trim();
      // Strip a single pair of matching surrounding quotes, if present.
      if (val.length >= 2 &&
          ((val[0] === '"' && val[val.length - 1] === '"') ||
           (val[0] === "'" && val[val.length - 1] === "'"))) {
        val = val.slice(1, -1);
      }
      // Never clobber a variable the host already provides.
      if (process.env[key] === undefined) {
        process.env[key] = val;
        loaded++;
      }
    }
    if (process.env.DEBUG && String(process.env.DEBUG).toLowerCase() === 'true') {
      console.log(`[env] Loaded ${loaded} variable(s) from .env`);
    }
  }
} catch (e) {
  console.warn('[env] Could not load .env:', e.message);
}
