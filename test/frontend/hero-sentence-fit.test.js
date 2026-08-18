// The hero headline ("Stage this <room> in <style>.") must stay on ONE LINE on desktop.
//
// It wrapped for a reason that had nothing to do with the text: `.hp-bar__main` carried a
// `max-width: 640px` on top of its `minmax(0, 1fr)` grid column, and the cap was the tighter
// of the two. Measured at 1707px there were 778px of column free, 640px allowed, and the
// widest English pair ("dining room" + "Scandinavian") needs 738px at the full 38px. It fit
// the layout and not the cap.
//
// The fix is split across two files, and that is what makes it worth a test. CSS supplies the
// hook (`--hp-sentence-fs` and `.is-fitted`); fitSentence() in scripts/hero-picker.js measures
// the locale's widest room + widest style and writes both. Delete either half and NOTHING
// ERRORS — the variable goes unread, or the class matches no rule, and the headline quietly
// goes back to wrapping in exactly the locales nobody checks. There is no layout in jsdom, so
// the measurement itself cannot be unit-tested; the contract between the halves can.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Comments FIRST, and this file is the reason why: the prose above and in hero-picker.css
// quotes `max-width: 640px` while explaining that it must not come back. A raw scan reads the
// warning as the thing it warns about.
const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJs = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every declaration block whose selector list mentions `sel`. */
const blocks = (css, sel) => {
  const out = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (m[1].includes(sel)) out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
};

test('the hero headline column is not capped below its grid track', () => {
  const css = stripCss(read('public', 'styles', 'hero-picker.css'));
  const offenders = blocks(css, '.hp-bar__main')
    .filter((b) => /max-width\s*:/i.test(b.body))
    .filter((b) => !/max-width\s*:\s*none/i.test(b.body))
    .map((b) => `${b.selector} { ${b.body.trim().replace(/\s+/g, ' ')} }`);

  assert.deepEqual(
    offenders,
    [],
    'a max-width is back on .hp-bar__main:\n  ' + offenders.join('\n  ') +
      '\n\nThe grid track is already minmax(0, 1fr), so it can never reach past the side ' +
      'column. A second cap on top of that is what made the headline wrap: English needs ' +
      '738px for "dining room" + "Scandinavian" at 38px, the column had 778px, and the cap ' +
      'allowed 640px. If a bound is genuinely needed here, it has to be wider than the ' +
      'widest pair in the widest locale, and fitSentence() has to be re-measured against it.'
  );
});

test('the CSS still exposes the two hooks fitSentence() writes', () => {
  const css = stripCss(read('public', 'styles', 'hero-picker.css'));

  const base = blocks(css, '.hp-sentence').find((b) => /^\.hp-sentence\s*$/.test(b.selector));
  assert.ok(base, 'public/styles/hero-picker.css no longer has a bare `.hp-sentence` rule');
  assert.match(
    base.body,
    /font-size\s*:\s*var\(\s*--hp-sentence-fs\s*,/,
    '.hp-sentence stopped reading --hp-sentence-fs, so the size fitSentence() computes for ' +
      'the wordier locales is written and never applied. The clamp must stay the FALLBACK ' +
      'inside the var(), not the declaration itself — it is the ceiling, not the answer.'
  );

  const fitted = blocks(css, '.hp-sentence.is-fitted');
  assert.ok(
    fitted.length && fitted.some((b) => /white-space\s*:\s*nowrap/i.test(b.body)),
    'the `.hp-sentence.is-fitted { white-space: nowrap }` rule is gone. fitSentence() adds ' +
      'that class in the same tick it writes the size; without the rule the sentence keeps ' +
      'wrapping and the whole measurement is dead code.'
  );

  // The nowrap must NOT be unconditional. With JS off the picker is inert and a
  // server-rendered /de or /es ships a long default that has to be free to wrap.
  const unconditional = blocks(css, '.hp-sentence')
    .filter((b) => !b.selector.includes('.is-fitted'))
    .filter((b) => /white-space\s*:\s*nowrap/i.test(b.body));
  assert.deepEqual(
    unconditional.map((b) => b.selector),
    [],
    'white-space: nowrap is applied to .hp-sentence outside the .is-fitted class. That ' +
      'reaches the no-JS and server-rendered-locale cases, where nothing has measured the ' +
      'sentence, and an unmeasured nowrap runs out through the side of the bar — which the ' +
      'file header forbids ("nothing here may overflow .hero").'
  );
});

test('hero-picker.js still writes both halves of the contract', () => {
  const js = stripJs(read('public', 'scripts', 'hero-picker.js'));

  assert.match(
    js,
    /setProperty\(\s*'--hp-sentence-fs'/,
    'hero-picker.js no longer sets --hp-sentence-fs, so the wordier locales lose their pinned ' +
      'size and fall back to the clamp — which does not fit, so they wrap.'
  );
  assert.match(
    js,
    /classList\.add\(\s*'is-fitted'\s*\)/,
    'hero-picker.js no longer adds the is-fitted class, so nothing ever gets white-space: nowrap.'
  );
  assert.match(
    js,
    /classList\.remove\(\s*'is-fitted'\s*\)/,
    'hero-picker.js no longer removes the is-fitted class. It has to be cleared before each ' +
      'measurement and left off below the breakpoint, or a stale nowrap outlives the size it ' +
      'was measured for.'
  );
});
