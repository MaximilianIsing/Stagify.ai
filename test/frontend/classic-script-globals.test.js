// Undefined-global net for the UNLINTED classic frontend scripts.
//
// test/frontend/classic-scripts-parse.test.js proves each classic script PARSES;
// it says so itself that "undefined browser globals are runtime, so nothing is
// stubbed". This test covers exactly that gap, because the gap has bitten one
// file three separate times.
//
// The trap: ai-designer.html loads ai-designer-model-selector.js as a plain
// <script> (no type="module") while everything it collaborates with is a
// deferred <script type="module">. A module's top-level bindings are NOT
// globals, so naming one from the classic script is a ReferenceError. In a
// non-strict classic script a bare identifier resolves through the scope chain
// to the global object — so the fix is an explicit `window.name = name` bridge
// on the module side, and that bridge is invisible to every other check we run.
//
// Deleting one bridge line breaks a user-facing feature silently:
//   - window.closeImageModal   → the lightbox "x" stops working
//   - window.getConversationHistory → bug reports lose their transcript
//   - window.showToast / window.lang → the bug-report dialog gives NO feedback
//     on success or on an empty description, so users file the report twice
//   - window.updateMaskEditorTranslations → throws on EVERY AI Designer load
//     and the mask editor stops being re-localized
//
// So: find every bare identifier the classic scripts CALL, and require each one
// to be declared in that file, a known browser/JS global, or bridged onto
// window by some ES module under public/scripts/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESM_MARKER } from '../../scripts/collect-esm-frontend.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(rootDir, 'public', 'scripts');
const rel = (f) => path.relative(rootDir, f).split(path.sep).join('/');

/**
 * Blank out comment bodies AND string/template contents, preserving offsets-ish
 * so the remaining text is pure code. Both matter here: a comment naming
 * `showToast` (this codebase documents its own fixes in prose, so they do) would
 * otherwise satisfy the very guard that is supposed to notice the call is gone,
 * and a name inside a string is not a call.
 * Mis-stripping fails safe — it can only drop a real call site, which trips the
 * "found too few call sites" assertion below rather than hiding a regression.
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { quote = null; out += c; i += 1; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      out += '  ';
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      i += 2;
      out += '  ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function collect(dir, predicate, out = []) {
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
      collect(full, predicate, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (predicate(src)) out.push(full);
    }
  }
  return out;
}

const classicScripts = collect(scriptsDir, (src) => !ESM_MARKER.test(src));
const esmScripts = collect(scriptsDir, (src) => ESM_MARKER.test(src));

// Every name any ES module hands to the classic layer via `window.x = ...`,
// `window.x=` or `window['x'] =`. Comments stripped first, so a line that merely
// TALKS about the bridge does not count as the bridge.
function windowBridgedNames() {
  const names = new Set();
  for (const file of esmScripts) {
    const code = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/\bwindow\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(m[1]);
    for (const m of code.matchAll(/\bwindow\s*\[\s*'([A-Za-z_$][\w$]*)'\s*\]\s*=(?!=)/g)) names.add(m[1]);
  }
  return names;
}

// Names declared inside the file itself. Deliberately over-inclusive (it sweeps
// params and destructured bindings without scope analysis) because a false
// NEGATIVE here just means we skip a name — the risk we care about is a false
// alarm on a locally-defined helper.
function locallyDeclared(code) {
  const names = new Set();
  const add = (re, group = 1) => {
    for (const m of code.matchAll(re)) names.add(m[group]);
  };
  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  // Destructured and multi-declarator bindings: `const { a, b } = x`, `let a, b`.
  for (const m of code.matchAll(/\b(?:const|let|var)\s*(?:\{|\[)([^}\]]*)[}\]]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Function parameters, including arrow params — callbacks do get invoked.
  for (const m of code.matchAll(/(?:function\s*\*?\s*[A-Za-z_$][\w$]*\s*|=>\s*|function\s*)\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}

// Callable globals a browser provides. Not exhaustive by design — an unknown
// name SHOULD fail this test and be triaged, either as a real bridge or as a
// deliberate addition here.
const BROWSER_GLOBALS = new Set([
  'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'queueMicrotask', 'structuredClone', 'getComputedStyle', 'matchMedia', 'atob', 'btoa',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'String', 'Number', 'Boolean',
  'Array', 'Object', 'Date', 'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'JSON', 'Math', 'Proxy', 'Reflect',
  'FormData', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'Image',
  'Event', 'CustomEvent', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'AbortController', 'Intl', 'BigInt', 'Uint8Array', 'ArrayBuffer', 'DataView',
  'require', 'importScripts', 'reportError',
]);

// Reserved words that the `name(` pattern also matches.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
  'delete', 'void', 'in', 'of', 'do', 'else', 'await', 'yield', 'throw', 'case',
  'with', 'super', 'this', 'import', 'export', 'constructor',
]);

/**
 * Bare `name(` call sites — not `.name(`, not `?.name(`, not a keyword.
 *
 * Uses a LOOKBEHIND, not a consumed prefix character. An earlier version matched
 * `(^|[^.\w$?])` and so ate the character before each name; in a nested call like
 * `showToast(lang('x'))` the `(` was consumed by the `showToast` match, leaving
 * `lang` with nothing to match against — the inner call was invisible. That is
 * exactly the call shape this guard exists to protect, so it silently passed with
 * the `window.lang` bridge deleted.
 */
function calledFreeIdentifiers(code) {
  const out = new Set();
  for (const m of code.matchAll(/(?<![.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (!KEYWORDS.has(name)) out.add(name);
  }
  return out;
}

test('there are classic scripts to guard', () => {
  assert.ok(classicScripts.length > 0, 'expected to discover classic scripts under public/scripts');
  assert.ok(esmScripts.length > 0, 'expected to discover ES modules under public/scripts');
});

test('the stripper blanks comments and strings, so prose cannot satisfy this guard', () => {
  const code = stripCommentsAndStrings(
    '// showToast(1)\n/* lang(2) */\nconst s = "updateMaskEditorTranslations(3)";\nrealCall(4);\n'
  );
  const called = calledFreeIdentifiers(code);
  assert.ok(called.has('realCall'), 'a real call must survive stripping');
  for (const ghost of ['showToast', 'lang', 'updateMaskEditorTranslations']) {
    assert.ok(!called.has(ghost), `${ghost} appeared only in a comment/string and must not count as a call`);
  }
});

test('nested and member calls are classified correctly', () => {
  // The INNER call of `outer(inner(...))` must be seen. A prefix-consuming regex
  // misses it, which let the window.lang bridge be deleted with this guard green.
  const nested = calledFreeIdentifiers('outer(inner(deepest(1)));');
  for (const name of ['outer', 'inner', 'deepest']) {
    assert.ok(nested.has(name), `${name} must be detected in a nested call chain`);
  }
  // Member calls are somebody else's property, not a free global.
  const member = calledFreeIdentifiers('a.b(); obj?.c(); x.y.z();');
  for (const name of ['b', 'c', 'z']) {
    assert.ok(!member.has(name), `${name} is a member call and must not be treated as a free identifier`);
  }
});

const bridged = windowBridgedNames();

test('the window bridge is discovered at all (self-test for the scan)', () => {
  // If this regex ever stops matching, every per-file assertion below would pass
  // vacuously. Pin a bridge we know exists.
  assert.ok(bridged.has('closeImageModal'), 'expected to find window.closeImageModal in an ES module');
});

test('identifier extraction still works on the file this guard exists for', () => {
  // Per-file call floors are wrong — faq-redirect.js is a single `location.replace`
  // and demo-data.js is pure data, so zero free calls is correct for them. But if
  // extraction broke everywhere, every assertion below would pass vacuously. Pin the
  // file that has actually carried this bug, and a healthy total across the set.
  const target = classicScripts.find((f) => path.basename(f) === 'ai-designer-model-selector.js');
  assert.ok(target, 'ai-designer-model-selector.js must stay in the classic set');
  const called = calledFreeIdentifiers(stripCommentsAndStrings(fs.readFileSync(target, 'utf8')));
  assert.ok(called.size >= 10, `expected many call sites in ai-designer-model-selector.js, found ${called.size}`);
  assert.ok(called.has('showToast'), 'showToast must still be called there — this guard exists for it');
});

for (const file of classicScripts) {
  test(`classic script has no unresolvable called identifier: ${rel(file)}`, () => {
    const code = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    const called = calledFreeIdentifiers(code);
    const declared = locallyDeclared(code);
    const unresolved = [...called]
      .filter((n) => !declared.has(n) && !BROWSER_GLOBALS.has(n) && !bridged.has(n))
      .sort();
    assert.deepEqual(
      unresolved,
      [],
      `${rel(file)} calls ${unresolved.join(', ')} but nothing declares them in-file, they are not browser `
        + 'globals, and no ES module under public/scripts/ bridges them onto window. Either add a '
        + '`window.<name> = <name>` bridge in the module that owns each, or add it to BROWSER_GLOBALS here.'
    );
  });
}
