// Tier: markup ↔ stylesheet contract — the Masking Studio's dialogs as a phone sees them.
// Both rules here are CSS reaching into masking-studio.html by name, and both fail silent.
//
// "How the Masking Studio works" ends with a keyboard-shortcuts block a phone can act on
// none of (B/E/R/W, the bracket pair, Ctrl+Z, hold-H), so masking-studio.css hides it
// below the mobile breakpoint. That rule reaches across files by id, and nothing else
// connects the two: rename or drop `#ms-help-shortcuts` on either side and the rule goes
// inert in silence — the shortcuts just reappear on phones, and only a person holding a
// phone would ever find out.
//
// Visibility of this same element has a second owner: the app module toggles `.hidden` on
// it to keep the first-visit walkthrough light. That is why the phone rule lives in CSS
// and is width-only — two owners of one element's `display` is how it starts fighting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public');
const HTML = fs.readFileSync(path.join(PUBLIC, 'masking-studio.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PUBLIC, 'styles', 'masking-studio.css'), 'utf8');

/** The body of the phone media block, comments stripped so a mention is not a match. */
function phoneBlock() {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf('@media (max-width: 768px)');
  assert.notEqual(at, -1, 'masking-studio.css no longer has a 768px phone block');
  const open = bare.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < bare.length; i += 1) {
    if (bare[i] === '{') depth += 1;
    else if (bare[i] === '}' && (depth -= 1) === 0) return bare.slice(open + 1, i);
  }
  throw new Error('unbalanced braces in masking-studio.css');
}

test('sanity: the help dialog still carries the shortcuts block the phone rule targets', () => {
  // Without this the assertion below passes vacuously the day the markup is renamed.
  assert.match(HTML, /id="ms-help-shortcuts"/, 'the help dialog lost #ms-help-shortcuts');
  assert.match(HTML, /data-lang="maskingStudio\.helpShortcuts"/, 'the shortcuts heading moved out of the dialog');
});

test('phones do not get the keyboard shortcuts', () => {
  assert.match(
    phoneBlock().replace(/\s+/g, ''),
    /#ms-help-shortcuts\{[^}]*display:none/,
    'the help dialog offers a phone a list of keys it has no way to press',
  );
});

// The floating language pill lives in <main> at z-index 1000 and out-stacks the studio's
// dialog overlay (z-index 300) on its own, so every full-screen dialog on this site takes
// it down while open — .modal / .stage-mask-modal in styles.css, #auth-modal /
// #report-issue-modal in auth.css, the four .ms-pro-gate dialogs here. The studio's four
// shipped without it and only stopped overlapping when .language-picker-container became a
// stacking context (z-index:5) for an unrelated header fix. That is a side effect, not a
// guarantee: whoever un-does it for the header will have no way to know this dialog was
// leaning on it, and the pill lands back on the card on a phone. Hence the guard.
test('an open dialog takes the language pill down', () => {
  assert.match(
    CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ''),
    /body:has\(\.ms-pro-gate\.active\)\.language-picker-container\{display:none/,
    'nothing hides the language pill while a Masking Studio dialog is open',
  );
  // The rule names a class it does not own; without this it can go stale in silence.
  assert.match(HTML, /class="language-picker-container"/, 'the pill wrapper this rule targets was renamed');
  assert.match(HTML, /class="ms-pro-gate"/, 'the dialogs this rule keys on were renamed');
});
