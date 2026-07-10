// Shared discovery of the frontend ES-module files under public/scripts/.
//
// Imported by BOTH eslint.config.js (the lint scope) and
// scripts/typecheck-frontend.js (the type-check scope) so the two scopes can
// never drift apart: every file we lint we also type-check, and vice-versa.
//
// A file counts as a frontend ES module iff it has a top-level `export` or a
// static / side-effect `import` (see ESM_MARKER). Classic shared-global
// `<script>` files (no import/export — they hang everything off `window`) and
// vendor/*.min.js bundles have neither marker and are intentionally excluded:
// tsc would treat the classic ones as one shared global script and drown the
// output in cross-file noise, exactly as ESLint leaves them unlinted.
import fs from 'node:fs';
import path from 'node:path';

// A top-level `export`, or a static `import … from` / side-effect `import '…'`.
// A dynamic `import()` in a classic script does NOT match (no leading `export`,
// no `from`), so those files correctly stay out of scope.
export const ESM_MARKER = /^\s*(?:export\b|import\s+(?:[^(;]*\sfrom\s|['"]))/m;

/**
 * @param {string} dir Directory to scan (recursively).
 * @param {string} [rootDir] Base the returned paths are made relative to (POSIX
 *   separators). Defaults to `dir`.
 * @returns {string[]} Relative paths of the ES-module files found.
 */
export function collectEsmFrontend(dir, rootDir = dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory missing → nothing to collect
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue; // third-party bundles
      out.push(...collectEsmFrontend(full, rootDir));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
      let src;
      try {
        src = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (ESM_MARKER.test(src)) {
        out.push(path.relative(rootDir, full).split(path.sep).join('/'));
      }
    }
  }
  return out;
}
