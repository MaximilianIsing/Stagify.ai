// ESLint flat config (ESLint 9+). Enforced in CI — a warning or error fails the build (.github/workflows/ci.yml).
//
// Linted scopes, each carrying the recommended ruleset (CSS is stylelint's job — see
// stylelint.config.js; `npm run lint` runs both):
//   1. Backend — server.js, instrument.js, routes/, lib/, the test suite. Node ES modules.
//   2. Frontend — the files under public/scripts/ that are actual ES modules. This list is
//      AUTO-DISCOVERED (see scripts/collect-esm-frontend.js): any file with a top-level
//      `import … from` or `export` is a real module (proper scope, so browser globals lint
//      cleanly with no cross-file `no-undef`) and gets linted. As classic <script> files
//      migrate to ESM they start being linted automatically — no edit here is needed. The
//      type-checker (scripts/typecheck-frontend.js) consumes that same discovery, so the lint
//      scope and the type-check scope are always the same set of files.
//
//   3. Classic scripts — hand-written <script> files under public/scripts/, listed by name in
//      their own block (sourceType 'script'). A new classic file is NOT picked up automatically;
//      add it to that list.
//   4. Tooling — instagram/ and to-build/ (local generators, Node + headless-browser globals).
//
// The only JS left unlinted is generated or third-party: demo-data.js and vendor/*.min.js. They
// match NO block. Do NOT add a broad `public/**` ignore: ESLint can't un-ignore files beneath a
// `/**`-ignored ancestor, which would make the frontend blocks unreachable; scoping via `files`
// (below) is what keeps the generated files out.

import js from '@eslint/js';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEsmFrontend } from './scripts/collect-esm-frontend.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const recommendedRules = js.configs.recommended.rules;

// The frontend lint scope is every real ES module under public/scripts/ — the exact same set
// scripts/typecheck-frontend.js hands the type-checker (both call collectEsmFrontend), so lint
// and type-check always cover identical files. Passing rootDir makes the returned paths the
// POSIX-style, config-relative globs ESLint's `files` expects.
const frontendEsmFiles = collectEsmFrontend(path.join(rootDir, 'public', 'scripts'), rootDir);

export default [
  {
    ignores: [
      'node_modules/**',
      'ds-bundle/**',     // generated bundle
      'supademo-local/**',
      '**/*.min.js',
    ],
  },

  {
    // Backend: Node, ES modules.
    files: [
      'eslint.config.js',
      'stylelint.config.js',
      'server.js',
      'load-env.js',
      'instrument.js',
      'routes/**/*.js',
      'lib/**/*.js',
      'test/**/*.js',
      // Build/CI tooling. Matched no block until 2026-08-01, so `npx eslint
      // --print-config scripts/test-coverage.js` reported ZERO rules and zero
      // globals — no no-undef, no no-unused-vars, nothing — while `npm run lint`
      // exited 0 without reading them. Uncomfortable in particular because
      // scripts/collect-esm-frontend.js, imported at the top of THIS file to define
      // the lint scope, was itself outside the lint scope.
      'scripts/**/*.js',
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
      // All diagnostics go through lib/logger.js — a raw console.* call is a
      // migration miss. Errors (fails the build) so it can't creep back. The
      // handful of files that legitimately touch console are re-allowed below.
      'no-console': 'error',
    },
  },

  {
    // File-size ratchet for backend product code — the same 650-line cap the
    // frontend ESM modules carry (below), extended here so routes/ and lib/ can't
    // drift into 800–1000-line "junk drawers" unnoticed. Scoped to product code
    // only: test/** is intentionally excluded (test files legitimately grow and
    // aren't the entry-script junk drawers this guards against). When a module
    // bumps the cap, split it into cohesive siblings — don't raise this. The one
    // file over the line is grandfathered just below, as debt to shrink the same way.
    files: ['server.js', 'instrument.js', 'load-env.js', 'routes/**/*.js', 'lib/**/*.js'],
    rules: {
      'max-lines': ['error', 650],
    },
  },

  {
    // Grandfathered: predates the backend 650-line ratchet above. Capped at 800
    // (today's worst is ~780) so it can't regress toward 1000, but not yet forced
    // under 650. Debt: split into cohesive modules, then delete this entry so the
    // global 650 cap applies.
    files: ['lib/data/auth-store.js'],
    rules: {
      'max-lines': ['error', 800],
    },
  },

  {
    // Files allowed to call console directly, in override order after the backend
    // block above (later blocks win in flat config):
    //   - lib/logger.js          — IS the console wrapper.
    //   - lib/config/runtime-flags.js, load-env.js — bootstrap layer; they run
    //     before/beneath the logger (runtime-flags supplies the DEBUG_MODE the
    //     logger imports, so it cannot import the logger back without a cycle).
    //   - test/**                — tests print diagnostics freely.
    //   - scripts/**             — build/CI tools, not the server. Their stdout IS
    //     their interface (a build log, a coverage table), and routing it through
    //     lib/logger.js would subject build output to the server's LOG_LEVEL and
    //     DEBUG_MODE filtering, which is meaningless outside a running server.
    files: [
      'lib/logger.js',
      'lib/config/runtime-flags.js',
      'load-env.js',
      'test/**/*.js',
      'scripts/**/*.js',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // End-to-end Playwright specs + config. They run in Node (process, etc.) but their
    // addInitScript/evaluate callbacks reference browser globals (localStorage, document).
    files: ['playwright.config.js', 'e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      ...recommendedRules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
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
      // File-size ratchet. These entry scripts used to grow into 800–1000-line
      // "junk drawers"; the fix has been to lift cohesive concerns into sibling
      // islands (scripts/<page>/*.js) wired via the factory-island pattern. This
      // caps a served ESM module at 650 lines (raw, incl. comments/blanks) so a
      // file can't drift back there unnoticed. When a module bumps the cap, split
      // it — don't raise this. The three files still over the line are grandfathered
      // just below, as tracked debt to shrink the same way.
      'max-lines': ['error', 650],
    },
  },

  {
    // Frontend: classic (non-module) <script> files. Listed explicitly rather than globbed so
    // the generated demo-data.js and minified bundles stay out. Cross-file globals are read
    // off `window` (window.closeImageModal, …) so no-undef stays on. No max-lines ratchet here:
    // it targets the ESM entry scripts above, and hero-picker.js predates it by a wide margin.
    files: [
      'public/scripts/gates/ai-designer-gate.js',
      'public/scripts/ai-designer/ai-designer-model-selector.js',
      'public/scripts/gates/api-keys-gate.js',
      'public/scripts/guides/demo-player.js',
      'public/scripts/gates/developers-gate.js',
      'public/scripts/gates/faq-redirect.js',
      'public/scripts/gates/gallery-gate.js',
      'public/scripts/home/hero-cta-boot.js',
      'public/scripts/home/hero-picker.js',
      'public/scripts/home/hero-restore.js',
      'public/scripts/gates/preview-gate.js',
      'public/scripts/site/session-class.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        LanguageSystem: 'readonly',
      },
    },
    rules: {
      ...recommendedRules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  {
    // Local tooling: the instagram/ post generator and the to-build/ asset generators.
    // Not runtime code, but they write files the site ships (hero combos, demo data), so a
    // bug here is a bug in production assets. Node scripts that also hand callbacks to a
    // headless browser (page.evaluate), hence both global sets. Linted but not ratcheted:
    // no max-lines, and console is their interface.
    files: ['instagram/**/*.{js,mjs}', 'to-build/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      ...recommendedRules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  {
    // The classic (non-module) files among the tooling above.
    files: [
      'to-build/Iridescent background/iridescence.js',
      'to-build/demos/demo-player.js',
      'to-build/demos/demos.js',
    ],
    languageOptions: {
      sourceType: 'script',
      globals: {
        module: 'readonly',
      },
    },
  },

  {
    // Grandfathered: cohesive-but-large modules that predate the 650-line ratchet
    // above. Capped at 850 so they can't regress toward 1000, but not yet forced
    // under 650. Debt: split each into islands (as was done for app.js /
    // ai-designer-app.js / admin.js / profile-menu.js), then delete its entry here
    // so the global 650 cap applies.
    //
    // The line counts below are CHECKED, not decorative —
    // test/frontend/max-lines-grandfather.test.js fails when one drifts, and fails
    // when a listed file drops under the global cap and should have been delisted.
    // They had gone stale by up to 300 lines, which quietly re-opened the ratchet:
    // a file already back under 650 was still licensed to grow to 850.
    files: [
      'public/scripts/ai-designer/mask-editor.js',    // 718
      'public/scripts/app/stage-mask-editor.js',      // 659
      'public/scripts/masking-studio/masking-studio-app.js',         // 725
    ],
    rules: {
      'max-lines': ['error', 850],
    },
  },
];
