// promptMatrix.js is the STYLE layer: what movable furniture and decor to add. It must
// never instruct the image model to ADD or INSTALL a permanent element.
//
// WHY THIS FILE EXISTS RATHER THAN A COMMENT. That rule was a comment in promptMatrix.js
// for months. It was written after every bathroom prompt was found opening with "Add a
// <style> toilet" — and a toilet duly appeared on the hardwood floor of a photo that was
// never a bathroom. The comment was honoured for toilets and shower curtains, and quietly
// ignored for everything else: the same file went on ordering walk-in showers, frameless
// shower doors, floating vanities, freestanding baths, subway-tile backsplashes, built-in
// dishwashers and chandeliers, plus "and natural lighting" — which a model delivers by
// enlarging or inventing a window. Meanwhile the block a thousand characters later in the
// assembled prompt forbade touching any of it. A model resolving that contradiction picks
// the itemised shopping list over the abstract rule, every time.
//
// A comment does not block a deploy. This does.
//
// The check is on the VERB, not the noun. "keep the existing backsplash exactly as
// photographed" is exactly what these prompts should say; "Add a subway tile backsplash"
// is the bug. Both contain the word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptMatrix } from '../../lib/staging/promptMatrix.js';
import { PERMANENT_ELEMENT_NOUNS } from '../../lib/staging/preservation-rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.join(HERE, '..', '..', 'lib', 'staging', 'promptMatrix.js');

// Verbs that mean "bring this into existence". Anything else — keep, preserve, existing,
// already — is the correct way to mention a permanent element and must stay allowed.
const ADD_VERBS = ['add', 'include', 'install, ', 'install ', 'replace with', 'fit a', 'fit an'];

// Phrases where a permanent noun is a LOCATION or a MODIFIER, not the thing being added.
// "countertop accessories" are accessories that sit on a counter; nobody is installing one.
// Kept short and explicit: a new false positive fails loudly here rather than being absorbed
// by a looser matcher that would also start missing real offences.
const LOCATION_PHRASES = [
  'countertop accessor',
  'on the counter',
  'at any existing island or counter',
  'counter accessories',
];

/**
 * Every clause of a prompt string, split on the separators these prompts actually use.
 * A clause is the unit the check runs on, because "Keep the existing cabinetry, counters,
 * backsplash and sink" and "Add bar stools" live in the same sentence often enough that
 * checking whole sentences produces false positives on correct prompts.
 * @param {string} text
 * @returns {string[]}
 */
function clauses(text) {
  return text.split(/(?<=[.!?])\s+/).flatMap((sentence) => {
    // Carry the sentence's leading verb into each comma-separated item, so "Add a sofa,
    // a chandelier, and a rug" flags the chandelier rather than only the first item.
    const lead = /^\s*(add|include|install)\b/i.exec(sentence);
    const parts = sentence.split(/,\s*|\s+and\s+/i);
    return lead ? parts.map((p, i) => (i === 0 ? p : `${lead[1]} ${p}`)) : parts;
  });
}

/**
 * The detector, over one prompt string. Extracted so the guard can be pointed at known-bad
 * text as well as at the real matrix — a scan that has never failed is not evidence that it
 * works, only that nothing has tripped it.
 * @param {string} text
 * @returns {string[]} The offending clauses, each with the noun that flagged it.
 */
function findAddedPermanentElements(text) {
  /** @type {string[]} */
  const found = [];
  for (const clause of clauses(text)) {
    const lower = clause.toLowerCase();
    if (/\b(keep|keeping|preserve|preserving|existing|already|unchanged|as photographed)\b/.test(lower)) continue;
    if (!ADD_VERBS.some((v) => lower.includes(v))) continue;
    if (LOCATION_PHRASES.some((p) => lower.includes(p))) continue;
    for (const noun of PERMANENT_ELEMENT_NOUNS) {
      // Word boundaries, not substrings: "toiletries" is not a toilet, "woven" is not
      // an oven, "tapered-leg" is not a tap, and a "windowsill" is not a window.
      const pattern = new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(lower)) {
        found.push(`"${clause.trim()}" → adds "${noun}"`);
        break;
      }
    }
  }
  return found;
}

test('the permanence scan actually catches the prompts that caused this bug', () => {
  // Real text, verbatim from the versions of these entries that shipped. If the scan below
  // reports the matrix clean, it must be because the matrix IS clean — not because the
  // matcher quietly stopped matching.
  const regressions = [
    'Add a modern toilet, sleek sink with modern faucet, walk-in shower, floating vanity with backlit mirror.',
    'Include a minimalist kitchen island, modern bar stools, geometric pendant lighting, subway tile backsplash.',
    'Add premium appliances including a professional refrigerator, double oven, wine cooler, and espresso machine.',
    'Add a rattan chair, seashell accessories, ocean-themed wall art, and natural lighting.',
    'Add a plush sectional with velvet throw pillows, elegant wall art, and chandelier lighting.',
  ];
  for (const bad of regressions) {
    assert.ok(
      findAddedPermanentElements(bad).length > 0,
      `the scan must flag: ${bad}`,
    );
  }

  // …and it must NOT flag correct prompts, or it will simply be disabled by the next person
  // who hits a false positive.
  const good = [
    'Keep the existing cabinetry, counters, backsplash, sink and built-in appliances exactly as photographed.',
    'Add bar stools at any existing island or counter, tasteful countertop accessories, and a fruit bowl.',
    'Add a marble tray of fine toiletries and a candle, a polished wastebasket, and elegant wall art.',
    'Add woven storage baskets under the bed and a trailing plant in a tapered-leg pot.',
    'Add a potted herb garden on the windowsill and country wall art.',
  ];
  for (const ok of good) {
    assert.deepEqual(findAddedPermanentElements(ok), [], `the scan must NOT flag: ${ok}`);
  }
});

test('no promptMatrix entry instructs the model to ADD a permanent element', () => {
  /** @type {string[]} */
  const offences = [];

  for (const [roomType, styles] of Object.entries(promptMatrix)) {
    for (const [style, text] of Object.entries(styles)) {
      for (const hit of findAddedPermanentElements(text)) {
        offences.push(`${roomType}/${style}: ${hit}`);
      }
    }
  }

  assert.deepEqual(
    offences, [],
    'promptMatrix must style the room it was given, not renovate it — move these to a ' +
    '"keep the existing …" clause:\n  ' + offences.join('\n  '),
  );
});

test('every room type still tells the model to keep what is already built', () => {
  // The rooms defined by their fixtures are the ones where deleting the "Add a bath /
  // Add a backsplash" instruction could otherwise leave the model with no guidance about
  // them at all — which is its own way of losing them. They must say so positively.
  for (const roomType of ['Kitchen', 'Bathroom']) {
    for (const [style, text] of Object.entries(promptMatrix[roomType])) {
      if (style === 'custom') continue; // the user's own words replace this entry wholesale
      assert.match(
        text, /exactly as photographed/,
        `${roomType}/${style} must explicitly preserve its existing fixtures`,
      );
    }
  }
});

test('the "no toilet" decision is enforced, not just documented', () => {
  // The specific regression this whole guard grew out of. Checked against the file's
  // PROMPT STRINGS only — the comment block above them describes the history and naturally
  // contains the word.
  const source = fs.readFileSync(MATRIX_PATH, 'utf8');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '');      // line comments
  for (const banned of ['toilet', 'toilet paper holder', 'shower curtain']) {
    // Word-bounded: "a marble tray of toiletries" is styling, and is meant to stay.
    assert.ok(
      !new RegExp(`\\b${banned}\\b`, 'i').test(stripped),
      `"${banned}" must not appear in any promptMatrix prompt string`,
    );
  }
});
