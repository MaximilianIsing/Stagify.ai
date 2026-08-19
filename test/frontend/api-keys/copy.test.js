// Tier: source-scan guard — the API dashboard's user-visible copy.
//
// User decision, 2026-08-18: no em dashes anywhere on this page. It is a house style
// rule, so it needs a guard rather than a memory: the character is easy to reintroduce
// (every editor's smart-punctuation does it for you) and the failure is invisible until
// somebody reads the screen.
//
// COMMENTS ARE STRIPPED FIRST. The rest of this repo writes prose in em dashes and will
// keep doing so; what is under test is what reaches a browser, not what a maintainer
// reads. Scanning raw source would report forty hits, none of them real, and the guard
// would be deleted within a week.
//
// The one exemption is the shared site header, whose logo alt text is byte-identical on
// every page (test/frontend/shared-nav.test.js pins that) and is therefore site-wide
// copy rather than this page's. Changing it here alone would break the parity check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const EM_DASH = '—';

/** Everything the dashboard ships to a browser. */
function pageSources() {
  const scripts = fs.readdirSync(path.join(PUBLIC, 'scripts', 'api-keys'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('scripts', 'api-keys', f));
  return [
    'api-keys.html',
    path.join('scripts', 'api-keys-app.js'),
    ...scripts,
  ];
}

/**
 * Source with every comment removed, so only strings and markup are left.
 * @param {string} src - File contents.
 * @returns {string} The uncommented remainder.
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/[^\n'"`]*$/, '')))
    .join('\n');
}

test('no em dash reaches the screen anywhere on the API dashboard', () => {
  const offenders = [];
  for (const rel of pageSources()) {
    const src = stripComments(fs.readFileSync(path.join(PUBLIC, rel), 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (!line.includes(EM_DASH)) return;
      // The shared header, which every page carries byte-identically.
      if (line.includes('class="brand"')) return;
      offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'The API dashboard must not print an em dash. Use a word where a value is missing '
      + '(format.js exports NO_VALUE and NO_DATE), or rewrite the sentence:\n'
      + offenders.join('\n'),
  );
});

test('sanity: the scan reads real files and can still see an em dash', () => {
  // Without this the assertion above passes the moment the paths move or the comment
  // stripper eats everything — the classic way a source-scan guard goes quietly green.
  const sources = pageSources();
  assert.ok(sources.length >= 6, `expected the page plus its islands, found ${sources.length}`);
  for (const rel of sources) {
    assert.ok(fs.existsSync(path.join(PUBLIC, rel)), `${rel} is not there any more`);
  }
  assert.ok(
    stripComments('const a = "before ' + EM_DASH + ' after"; // ' + EM_DASH).includes(EM_DASH),
    'the comment stripper must leave string contents alone',
  );
  assert.ok(
    !stripComments('// just a comment ' + EM_DASH).includes(EM_DASH),
    'and must remove a whole-line comment',
  );
});

test('the placeholders themselves are words, and are what the panes use', () => {
  // Functions rather than constants: the answer is language-dependent and the pack can
  // arrive after the module does. What is pinned here is the ENGLISH fallback each one
  // carries, which is what renders before a pack loads and in every unit spec.
  const format = fs.readFileSync(path.join(PUBLIC, 'scripts', 'api-keys', 'format.js'), 'utf8');
  assert.match(format, /t\('apiKeys\.value\.never', 'Never'\)/);
  assert.match(format, /t\('apiKeys\.value\.none', 'n\/a'\)/);
});
