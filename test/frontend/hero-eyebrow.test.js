// The hero's eyebrow — the short line above the headline — must stay VISIBLE ON MOBILE.
//
// It used to hold the slogan "Upload. Stage. Imagine." and was hidden below 768px, which
// was the right call: the slogan named no product and the hero is sized to the viewport,
// so it cost a line for nothing. It now holds "Free virtual staging", the same phrase as
// <title> and og:title, and it is the only text above the fold that says what the page is.
//
// That makes re-hiding it a silent, expensive mistake. Indexing is mobile-first, so a
// `display:none` under a max-width query does not just cost phone visitors the one line
// that explains the product — it takes the phrase away from the crawler whose rendering
// decides the ranking. Nothing errors, nothing looks broken, and the desktop page still
// reads perfectly.
//
// It is also a mistake with form: the hide existed in THREE places at once (twice in
// styles.css, at 768px and again at 480px, and a third time in index.css). Removing three
// copies of a rule and leaving nothing behind is how a fourth gets added a month later,
// so this is that "nothing behind".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Comments FIRST. The rules this file guards are commented with prose that quotes the very
// declaration it warns against ("do not re-add the hide", next to the old `display:none`),
// so a raw scan matches the warning as if it were a live rule.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const SHEETS = ['styles.css', 'index.css', 'home.css', 'hero-picker.css'];

test('no stylesheet hides the hero eyebrow', () => {
  const offenders = [];

  for (const sheet of SHEETS) {
    const css = stripComments(read('public', 'styles', sheet));
    // Every rule whose selector list mentions .catchphrase, with its declaration block.
    for (const m of css.matchAll(/([^{}]*\.catchphrase[^{}]*)\{([^}]*)\}/g)) {
      if (/display\s*:\s*none/i.test(m[2])) {
        offenders.push(`${sheet}: ${m[1].trim().replace(/\s+/g, ' ')} { ${m[2].trim()} }`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'the hero eyebrow is hidden by CSS again:\n  ' + offenders.join('\n  ') +
      '\n\nThat line is the only text above the fold naming the product, and indexing is ' +
      'mobile-first, so hiding it below a breakpoint hides "Free virtual staging" from the ' +
      'rendering Google actually ranks. It was measured before being unhidden: at 390x844, ' +
      '375x667 and 360x640 it moves the CTA from 236px to 274px and the hero still ends ' +
      'above the fold on all three. If it has to go, take the phrase somewhere visible ' +
      'first, then delete this test with it.'
  );
});

test('the eyebrow markup and the English pack say the same thing', () => {
  const html = read('public', 'index.html');
  const tag = html.match(/<p class="catchphrase"[^>]*>([^<]*)<\/p>/);
  assert.ok(tag, 'public/index.html no longer ships the hero eyebrow <p class="catchphrase">');

  const key = tag[0].match(/data-lang="([^"]+)"/);
  assert.ok(key, 'the hero eyebrow lost its data-lang attribute, so it will never translate');
  assert.equal(
    key[1],
    'hero.eyebrow',
    'the hero eyebrow points at a different language key than hero.eyebrow. The ten ' +
      'server-rendered locale URLs resolve this key at render time, so a rename that misses ' +
      'one side ships the English string to every non-English visitor.'
  );

  assert.ok(
    !/data-hover-glow/.test(tag[0]),
    'the hero eyebrow carries data-hover-glow again.\n' +
      'public/scripts/hover-glow.js writes the effect as INLINE styles and reverts with ' +
      "`textShadow = 'none'` on mouseout. 'none' is a value, not a removal, and an inline " +
      'style outranks the sheet — so from the first hover onwards the eyebrow permanently ' +
      'loses the `0 1px 10px rgba(9,17,45,.5)` scrim shadow in hero-picker.css that carries ' +
      'white text over a bright render. Which of the 48 renders is showing is the visitor\'s ' +
      'choice, so that shadow is not decoration.\n' +
      'Nothing errors and a first page view looks correct, which is why this is a test and ' +
      'not a comment. The hover lives in `.hp-bar .catchphrase` in ' +
      'public/styles/hero-picker.css — extend it there.'
  );

  const pack = JSON.parse(read('public', 'languages', 'english.json'));
  assert.equal(
    tag[1].trim(),
    pack.hero.eyebrow,
    'the eyebrow baked into index.html and hero.eyebrow in english.json disagree.\n' +
      `  markup : ${JSON.stringify(tag[1].trim())}\n` +
      `  pack   : ${JSON.stringify(pack.hero.eyebrow)}\n` +
      'The markup is what a crawler and a no-JS visitor read; the pack is what everyone ' +
      'else ends up with. They have to be the same sentence.'
  );
});
