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
import { promptMatrix } from '../../lib/staging/promptMatrix.js';
import { generatePrompt } from '../../lib/staging/prompts.js';
import { PERMANENT_ELEMENT_NOUNS } from '../../lib/staging/preservation-rules.js';

// No filesystem read any more: the WC guard below runs over the promptMatrix OBJECT. The
// version it replaced scanned the file's text with the comments stripped out, precisely so
// the history could discuss toilets — and the history now discusses them at length.

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

/* THE ONE EXEMPTION, and its exact vocabulary. Since 2026-08-18 a Bathroom prompt may
 * install the fixtures a bathroom needs, because a room with no plumbing in it cannot be
 * staged as a bathroom at all — see the comment above the Bathroom block in promptMatrix.js.
 *
 * IT IS AN ALLOWLIST OF NOUNS, NOT A SKIP OF THE ROOM. Everything else in
 * PERMANENT_ELEMENT_NOUNS — window, skylight, doorway, archway, backsplash, counter,
 * built-in, cabinetry, every light, flooring, wallpaper, fireplace, radiator, staircase —
 * stays banned in Bathroom exactly as in every other room. That is what stops "fixtures over
 * windows", the worst of the failures this guard was built after, coming back through the
 * one door now standing open.
 *
 * Sanitaryware only. If you find yourself adding a second key to this object, the thing to
 * question is the change that made you want to, not this list. */
const INSTALLABLE_BY_ROOM = Object.freeze({
  Bathroom: Object.freeze([
    'shower', 'shower door', 'shower enclosure', 'shower screen',
    'bathtub', 'bath tub', 'tub', 'basin', 'washbasin', 'wash basin',
    'wc', 'water closet', 'sink', 'faucet', 'tap', 'toilet', 'vanity',
  ]),
});

/**
 * The detector, over one prompt string. Extracted so the guard can be pointed at known-bad
 * text as well as at the real matrix — a scan that has never failed is not evidence that it
 * works, only that nothing has tripped it.
 * @param {string} text
 * @param {string} [roomType] - When given, nouns this room may install are not offences.
 * @returns {string[]} The offending clauses, each with the noun that flagged it.
 */
function findAddedPermanentElements(text, roomType) {
  const installable = INSTALLABLE_BY_ROOM[roomType] || [];
  /** @type {string[]} */
  const found = [];
  for (const clause of clauses(text)) {
    const lower = clause.toLowerCase();
    if (/\b(keep|keeping|preserve|preserving|existing|already|unchanged|as photographed)\b/.test(lower)) continue;
    if (!ADD_VERBS.some((v) => lower.includes(v))) continue;
    if (LOCATION_PHRASES.some((p) => lower.includes(p))) continue;
    for (const noun of PERMANENT_ELEMENT_NOUNS) {
      if (installable.includes(noun)) continue;
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
      for (const hit of findAddedPermanentElements(text, roomType)) {
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

test('a WC may be asked for in a bathroom prompt and nowhere else', () => {
  // The inverse of the guard this replaces. Until 2026-08-18 the word was banned outright,
  // because every bathroom prompt opened "Add a <style> toilet" and one duly appeared on a
  // hardwood floor. Bathrooms may now install one; nothing else may, and the two other bans
  // are unconditional and stay that way.
  //
  // Runs over the promptMatrix OBJECT rather than the file text. The old version stripped
  // comments first precisely so the history could discuss toilets — and the history now
  // discusses them at length, which makes a text scan the wrong instrument.
  for (const [roomType, styles] of Object.entries(promptMatrix)) {
    for (const [style, text] of Object.entries(styles)) {
      if (roomType !== 'Bathroom') {
        for (const banned of ['toilet', 'wc', 'water closet']) {
          assert.ok(
            !new RegExp(`\\b${banned}\\b`, 'i').test(text),
            `${roomType}/${style} must not install a ${banned} — only Bathroom may`,
          );
        }
      }
      // Banned in EVERY room, bathrooms included. A holder is screwed to a wall, and a
      // curtain asked for with no enclosure to hang it on gets hung from the ceiling —
      // both were real outputs, and neither is fixed by letting bathrooms have plumbing.
      for (const banned of ['toilet paper holder', 'shower curtain']) {
        assert.ok(
          !new RegExp(`\\b${banned}\\b`, 'i').test(text),
          `"${banned}" must not appear in any promptMatrix prompt string (${roomType}/${style})`,
        );
      }
    }
  }
});

test('exactly one room type may install a permanent element', () => {
  assert.deepEqual(
    Object.keys(INSTALLABLE_BY_ROOM), ['Bathroom'],
    'the fixture exemption is meant to be Bathroom and nothing else',
  );
  // The exemption is sanitaryware. If any of these ever joins the list, the failure the
  // original guard was written after is reachable again.
  for (const banned of ['window', 'skylight', 'doorway', 'archway', 'backsplash', 'counter',
    'countertop', 'built-in', 'cabinetry', 'chandelier', 'pendant light', 'ceiling light',
    'wall light', 'flooring', 'wallpaper', 'fireplace']) {
    assert.ok(
      !INSTALLABLE_BY_ROOM.Bathroom.includes(banned),
      `a bathroom may install plumbing, never a ${banned}`,
    );
  }
});

test('every bathroom style keeps what exists and sites what it adds', () => {
  // Three phrases, asserted verbatim, because they are the ones doing the protecting and a
  // paraphrase in six entries out of seven is exactly how that protection goes missing.
  for (const [style, text] of Object.entries(promptMatrix['Bathroom'])) {
    if (style === 'custom') continue; // free text replaces this entry; its rules live in ROOM_TYPE_CONSTRAINTS
    assert.match(text, /exactly as photographed/, `${style} must preserve fixtures that exist`);
    assert.match(text, /never add a second one/, `${style} must forbid a duplicate set`);
    assert.match(
      text, /never across a window, door or glazed wall/,
      `${style} must site what it installs away from the openings`,
    );
  }
});

test('the prompt layer and the architecture lock agree about who may install', () => {
  // The failure mode that produced this whole file: the matrix ordering a fixture while the
  // block emitted after it forbade one. A model resolving that contradiction picks the
  // itemised shopping list over the abstract rule, every time — so the two must never
  // disagree, in either direction.
  const bathroom = generatePrompt('Bathroom', 'standard', '', true);
  assert.ok(
    !bathroom.includes('Do not install anything permanent that is not already there'),
    'the lock still forbids what the bathroom matrix entry just ordered',
  );
  assert.match(bathroom, /SANITARYWARE IS THE ONE EXCEPTION/);
  assert.match(bathroom, /never place, build or extend a fixture over, across or in front of a window/i);

  for (const room of ['Kitchen', 'Bedroom', 'Living room', 'Dining room', 'Office', 'Outdoors', 'Dorm']) {
    assert.match(
      generatePrompt(room, 'standard', '', true),
      /Do not install anything permanent that is not already there/,
      `${room} must still be locked`,
    );
  }
});

test('a free-text bathroom request still cannot lose the keep-clause', () => {
  // furnitureStyle 'custom' replaces the matrix entry wholesale, so a customer typing
  // "make it spa-like" at their real bathroom would otherwise get the relaxed lock with no
  // keep-clause anywhere in the prompt — and a second basin. ROOM_TYPE_CONSTRAINTS is
  // emitted after both the matrix and the removal clause, which is why the rule lives there.
  const custom = generatePrompt('Bathroom', 'custom', 'make it feel spa-like', true);
  assert.match(custom, /KEEP WHAT IS ALREADY THERE/);
  assert.match(custom, /NEVER ADD A SECOND/);
  assert.match(custom, /never place, build or extend a fixture over, across or in front of a window/i);
});
