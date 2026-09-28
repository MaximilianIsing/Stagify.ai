// Nothing used to stop English prose being written straight into a localized page.
//
// test/server/static.test.js checks that every key in english.json exists in the other
// ten packs, and the drift guards in this folder check a namespace at a time — but all
// of them start from a key. Markup that was never GIVEN a key is invisible to every one
// of them, and both renderers fall back silently to the English baked into the source
// (resolveKey in lib/i18n/render-page.js returns null and the caller leaves the tag
// alone; public/scripts/i18n/language-loader.js does the same in the browser). So a block
// added without data-lang looks perfect in English and ships English under a `de`,
// `ja` or `ru` hreflang, with nothing failing anywhere.
//
// That is how the AI Designer's Stagify+ gate, its hand-rolled bug-report form and
// about fifteen aria-labels accumulated. This sweep is the guard those needed: for
// every page in LOCALIZED_PAGES, any English PROSE — a text node or an
// aria-label/title/placeholder/alt — must sit under a translation key.
//
// "Prose" is the load-bearing word. The pages are full of text that is correctly the
// same in all eleven languages: brand names, the founders' names, hex colours, the
// language switcher's own labels, the API reference's field names and error codes. So
// the rule is not "any letters" but "at least two words, one of which is an English
// function word" — `Stagify.ai`, `INSUFFICIENT_CREDITS`, `Inter 400` and `Deutsch` are
// not sentences in any language, while "Back to staging" is unmistakably one. SKIP
// covers the rest: whole subtrees that are deliberately language-neutral.
//
// That makes this a FLOOR, not a ceiling. A function-word-free imperative like
// "Select base image" slips through, and deliberately so: the alternative is a
// dictionary that fails on every proper noun the site adds. The sweep is here to stop
// paragraphs and whole dialogs shipping untranslated, which is what actually happened.
//
// When this fails, the fix is almost never to add to SKIP. It is to add the key to all
// eleven packs and hang data-lang / data-lang-attr on the element.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LOCALIZED_PAGES } from '../../lib/i18n/locales.js';

const root = process.cwd();
const publicDir = path.join(root, 'public');

/** Attributes whose value a human reads or hears, so a locale must be able to change it. */
const HUMAN_ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

/**
 * English function words. One of these in a two-word-or-longer string is what separates
 * a sentence from a product name, an identifier or a measurement. Deliberately closed
 * class only — no nouns, or "Masking Studio workspace" would depend on "workspace"
 * being listed rather than on the phrase being English.
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'into', 'over', 'under', 'about', 'than', 'then', 'that', 'this',
  'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have',
  'had', 'do', 'does', 'did', 'can', 'will', 'would', 'should', 'your', 'you', 'we',
  'our', 'us', 'they', 'their', 'not', 'no', 'out', 'up', 'back', 'when', 'what', 'why',
  'how', 'where', 'which', 'who', 'all', 'every', 'each', 'any', 'some', 'more', 'most',
  'as', 'so', 'just', 'only', 'also', 'here', 'there',
]);

/**
 * Subtrees that are correctly identical in every language, matched on the opening tag
 * of the element that roots them. Each entry says WHY, because "add it to SKIP" is the
 * wrong fix for almost everything this test catches.
 */
const SKIP = [
  // The language switcher names each language in ITS OWN language — that is the point
  // of a language switcher, and translating "Deutsch" would defeat it.
  /\bclass="[^"]*\blang-(?:switcher|select|menu|pills?|current)\b/i,
  /\bclass="[^"]*\bblog-langs\b/i,
  // developers.html is an API reference: parameter names, enum values, error codes and
  // the curl sample are the wire protocol, not copy. They are the same in every locale.
  /\bclass="[^"]*\b(?:docs-table|docs-code|docs-pre|api-params|api-errors)\b/i,
  /^<(?:code|pre|kbd|samp)\b/i,
  // about.html's brand kit specimens: hex values, file names, "Inter 400", the mark
  // rendered as type. Changing them per locale would make the kit wrong.
  /\bclass="[^"]*\b(?:brand-swatch|brand-type|brand-space|brand-mark|about__marks)\b/i,
];

/** Elements whose content is never visible text. */
const OPAQUE = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source',
  'track', 'wbr',
]);

/** Does this look like an English sentence rather than a name, code or number? */
function isEnglishProse(text) {
  const words = text.toLowerCase().match(/[a-z][a-z'’]*/g) || [];
  if (words.length < 2) return false;
  return words.some((w) => FUNCTION_WORDS.has(w.replace(/[’']s$/, '')));
}

/** The translation keys declared on one opening tag, by the attribute each one sets. */
function keyedAttrsOf(tag) {
  const spec = (tag.match(/\bdata-lang-attr="([^"]*)"/) || [])[1];
  if (!spec) return new Set();
  return new Set(
    spec
      .split(';')
      .map((pair) => (pair.split('|')[1] || '').trim())
      .filter(Boolean),
  );
}

/**
 * Does this opening tag put its own subtree under a key?
 *
 * `data-lang-js` is the odd one out: neither renderer reads it. It marks an element
 * whose text a script writes with its own t() lookup, because the pack value carries a
 * placeholder the renderers cannot fill — `enterprise.success.line` is
 * "…ending in {domain} now have…", and a plain data-lang would paint the literal
 * "{domain}" on the page. The attribute names the key that script uses, so the element
 * is still greppable from the pack, and this sweep can tell "localized elsewhere" from
 * "never localized at all".
 */
function coversContent(tag) {
  return /\bdata-lang(?:-html|-faq|-json|-list|-js)?="/.test(tag);
}

/**
 * Walk a page's markup, reporting every untranslated English string.
 * A hand-rolled scan rather than a DOM library: the repo has no HTML parser dependency,
 * and the pages are hand-authored and well-formed enough for a tag walk (the same
 * approach lib/i18n/render-page.js itself takes for the real rendering).
 *
 * @param {string} html
 * @returns {string[]} one line per offender
 */
function untranslatedStrings(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  const offenders = [];
  /** @type {{tag: string, covered: boolean, opaque: boolean, skipped: boolean}[]} */
  const stack = [];
  let covered = 0;
  let opaque = 0;
  let skipped = 0;

  const tokens = /<\/?([a-zA-Z][\w-]*)\b([^>]*)>|([^<]+)/g;
  let m;
  while ((m = tokens.exec(src)) !== null) {
    const [whole, name, , text] = m;

    if (text !== undefined) {
      if (!opaque && !covered && !skipped) {
        const value = text.replace(/&[a-z]+;|&#\d+;/gi, ' ').trim();
        if (isEnglishProse(value)) offenders.push(`text: ${JSON.stringify(value.slice(0, 90))}`);
      }
      continue;
    }

    const tag = name.toLowerCase();
    if (whole.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag !== tag) continue;
        for (const frame of stack.slice(i)) {
          if (frame.covered) covered -= 1;
          if (frame.opaque) opaque -= 1;
          if (frame.skipped) skipped -= 1;
        }
        stack.length = i;
        break;
      }
      continue;
    }

    const isOpaque = OPAQUE.has(tag);
    const isSkipped = SKIP.some((re) => re.test(whole));

    // Attributes are checked on the tag itself: a key on an ancestor sets that
    // ancestor's attribute, never this one's.
    if (!opaque && !isOpaque && !skipped && !isSkipped) {
      const keyed = keyedAttrsOf(whole);
      for (const attr of HUMAN_ATTRS) {
        if (keyed.has(attr)) continue;
        // <input>/<textarea> take their placeholder from a plain data-lang — see the
        // note in lib/i18n/render-page.js about form fields being client-localized.
        if (attr === 'placeholder' && /\bdata-lang="/.test(whole)) continue;
        const value = (whole.match(new RegExp(`\\b${attr}="([^"]*)"`)) || [])[1];
        if (value && isEnglishProse(value)) {
          offenders.push(`<${tag} ${attr}>: ${JSON.stringify(value.slice(0, 90))}`);
        }
      }
    }

    if (whole.endsWith('/>') || VOID.has(tag)) continue;
    const isCovered = coversContent(whole);
    stack.push({ tag, covered: isCovered, opaque: isOpaque, skipped: isSkipped });
    if (isCovered) covered += 1;
    if (isOpaque) opaque += 1;
    if (isSkipped) skipped += 1;
  }

  return offenders;
}

test('the prose detector tells a sentence from a name, a code and a number', () => {
  // The whole sweep hangs off this one predicate, so pin both directions. If it stopped
  // matching, every page below would pass vacuously.
  for (const yes of [
    'Back to staging',
    'AI Designer is a Stagify+ feature',
    'Rated 5 out of 5 stars',
    'Report a Bug',
    'Stagify.ai founder demonstrating the product at a Compass office',
  ]) {
    assert.ok(isEnglishProse(yes), `should be treated as English prose: ${yes}`);
  }
  for (const no of [
    'Stagify.ai',
    'Stagify+',
    'Deutsch',
    'Português',
    'INSUFFICIENT_CREDITS',
    'Inter 400',
    '#2563eb',
    'multipart/form-data',
    'team@stagify.ai',
    'Maximilian Ising',
    'Douglas Elliman',
    '10 weeks',
    'EN',
  ]) {
    assert.ok(!isEnglishProse(no), `should NOT be treated as English prose: ${no}`);
  }
});

test('the multi-pair data-lang-attr spec is parsed the way both renderers parse it', () => {
  assert.deepEqual([...keyedAttrsOf('<button data-lang-attr="a.b|aria-label">')], ['aria-label']);
  assert.deepEqual(
    [...keyedAttrsOf('<button data-lang-attr="a.b|aria-label;a.b|title">')].sort(),
    ['aria-label', 'title'],
  );
  assert.deepEqual([...keyedAttrsOf('<button aria-label="x">')], []);
});

test('the localized page set is discovered (guard against an empty sweep)', () => {
  assert.ok(LOCALIZED_PAGES.length >= 12, `expected the localized pages, found ${LOCALIZED_PAGES.length}`);
});

for (const page of LOCALIZED_PAGES) {
  test(`no untranslated English in public/${page.file}`, () => {
    const html = fs.readFileSync(path.join(publicDir, page.file), 'utf8');
    const offenders = untranslatedStrings(html);
    assert.deepEqual(
      offenders,
      [],
      `public/${page.file} ships these strings in English under all ten non-English ` +
        'hreflangs — both renderers fall back silently, so nothing else notices. Add the ' +
        'key to every languages/*.json and hang data-lang (text) or ' +
        'data-lang-attr="<key>|<attr>" (attributes) on the element:\n  ' +
        offenders.join('\n  '),
    );
  });
}
