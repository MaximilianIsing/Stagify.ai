// Parse safety net for the UNLINTED classic frontend scripts.
//
// eslint only lints the ES-module files under public/scripts/ (those with a top-level
// `import … from` / `export`); the classic <script> files that share globals across
// files — admin.js, profile-menu.js, auth.js, carousel.js, … — match no lint block and
// escape the net entirely (see eslint.config.js). A syntax typo in one of them ships
// silently: it isn't imported by any node test and the linter never sees it.
//
// This gives them the one guarantee a browser needs before anything else: the file
// PARSES. We compile each with `new vm.Script(...)` (compile-only, never executed) which
// parses in the same sloppy-script mode the browser uses for a classic <script>. It only
// catches syntax errors — undefined browser globals are runtime, so nothing is stubbed —
// but a broken bundle now fails `npm test` instead of the user's tab. The classic set is
// AUTO-DISCOVERED with the same ESM marker eslint uses, so new classic scripts join
// automatically and migrating one to ESM hands it off to the real linter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(rootDir, 'public', 'scripts');

// Same marker eslint.config.js uses: a top-level `export` or static/side-effect
// `import … from` / `import '…'`. Files WITHOUT it are classic scripts (unlinted).
const ESM_MARKER = /^\s*(?:export\b|import\s+(?:[^(;]*\sfrom\s|['"]))/m;

function collectClassicScripts(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue; // third-party bundles, not ours to guard
      out.push(...collectClassicScripts(full));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
      const src = fs.readFileSync(full, 'utf8');
      if (!ESM_MARKER.test(src)) out.push(full);
    }
  }
  return out;
}

const classicScripts = collectClassicScripts(scriptsDir);
const rel = (f) => path.relative(rootDir, f).split(path.sep).join('/');

test('there are classic scripts to guard, and the flagged ones are covered', () => {
  assert.ok(classicScripts.length > 0, 'expected to discover unlinted classic scripts under public/scripts');
  const names = new Set(classicScripts.map((f) => path.basename(f)));
  // The code review specifically called out these two as escaping the lint net.
  assert.ok(names.has('admin.js'), 'admin.js must be in the parse net');
  assert.ok(names.has('profile-menu.js'), 'profile-menu.js must be in the parse net');
});

for (const file of classicScripts) {
  test(`classic script parses: ${rel(file)}`, () => {
    const src = fs.readFileSync(file, 'utf8');
    // Compile only — this parses the file without running it, so undefined browser
    // globals (window, document) are irrelevant. A SyntaxError throws here.
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }));
  });
}
