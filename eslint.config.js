// ESLint flat config (ESLint 9). Non-blocking in CI for now — see .github/workflows/ci.yml.
//
// Scope: the BACKEND only. server.js, routes/, lib/, and the test suite are ES modules
// and lint cleanly. The frontend (public/scripts/*.js) is intentionally NOT linted yet:
// those are classic <script> files that share globals across files, so `no-undef` /
// `no-unused-vars` would flood with false positives until they get a browser-specific
// config. Add a separate block for them later.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'public/**',        // frontend deferred (classic scripts, shared globals)
      'ds-bundle/**',     // generated bundle
      'supademo-local/**',
      'demos/**',
      'OG_Image/**',
      'to-build/**',
      '**/*.min.js',
    ],
  },

  js.configs.recommended,

  {
    // Backend: Node, ES modules.
    files: ['server.js', 'load-env.js', 'routes/**/*.js', 'lib/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Start lenient: real-bug rules only. Tighten once the baseline is clean.
      // An unused variable is often a typo or dead code, but allow an underscore
      // prefix (e.g. `_next`) to intentionally mark an ignored arg.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
