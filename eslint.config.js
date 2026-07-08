// ESLint flat config (ESLint 9+). Enforced in CI — a warning or error fails the build (.github/workflows/ci.yml).
//
// Two linted scopes, each carrying the recommended ruleset:
//   1. Backend — server.js, instrument.js, routes/, lib/, the test suite. Node ES modules.
//   2. Frontend — the files under public/scripts/ that are actual ES modules. This list is
//      AUTO-DISCOVERED (see collectEsmFrontend): any file with a top-level `import … from`
//      or `export` is a real module (proper scope, so browser globals lint cleanly with no
//      cross-file `no-undef`) and gets linted. As classic <script> files migrate to ESM they
//      start being linted automatically — no edit here is needed.
//
// Everything else under public/ — classic <script> files that share globals across files, plus
// minified/generated bundles (carousel, star-border, sponsors-scroll, language-loader, demo-data,
// vendor/*) — has neither marker, matches NO block, and is intentionally left unlinted. Do NOT add
// a broad `public/**` ignore: ESLint can't un-ignore files beneath a `/**`-ignored ancestor, which
// would make the frontend block unreachable; scoping via `files` (below) is what keeps the classic
// scripts out.

import js from '@eslint/js';
import globals from 'globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const recommendedRules = js.configs.recommended.rules;

// A file is a frontend ES module if it has a top-level `export` or a static `import … from` /
// side-effect `import '…'`. Dynamic `import()` in a classic script does NOT count (it has no
// `from` and no leading `export`), so those correctly stay unlinted.
const ESM_MARKER = /^\s*(?:export\b|import\s+(?:[^(;]*\sfrom\s|['"]))/m;

function collectEsmFrontend(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory missing → nothing to lint
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue; // third-party bundles
      out.push(...collectEsmFrontend(full));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
      let src;
      try {
        src = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (ESM_MARKER.test(src)) {
        // ESLint wants POSIX-style globs relative to this config's directory.
        out.push(path.relative(rootDir, full).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

const frontendEsmFiles = collectEsmFrontend(path.join(rootDir, 'public', 'scripts'));

export default [
  {
    ignores: [
      'node_modules/**',
      'ds-bundle/**',     // generated bundle
      'supademo-local/**',
      'to-build/**',      // source masters (media-png, OG_Image, demos) — not runtime code
      '**/*.min.js',
    ],
  },

  {
    // Backend: Node, ES modules.
    files: [
      'eslint.config.js',
      'server.js',
      'load-env.js',
      'instrument.js',
      'routes/**/*.js',
      'lib/**/*.js',
      'test/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...recommendedRules,
      // Start lenient: real-bug rules only. Tighten once the baseline is clean.
      // An unused variable is often a typo or dead code, but allow an underscore
      // prefix (e.g. `_next`) to intentionally mark an ignored arg.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  {
    // Frontend: native ES modules (no build step), auto-discovered above. Browser globals.
    files: frontendEsmFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Set on window by the classic language scripts (language-loader.js, etc.).
        LanguageSystem: 'readonly',
      },
    },
    rules: {
      ...recommendedRules,
      // Empty `catch {}` is a deliberate best-effort-swallow pattern in the UI code;
      // caught-error bindings that go unused are fine for the same reason.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
