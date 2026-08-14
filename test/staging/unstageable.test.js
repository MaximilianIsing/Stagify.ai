import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGEABLE_IMAGE_CHECK_PROMPT,
  UNSTAGEABLE_CODES,
  GENERIC_UNSTAGEABLE_CODE,
  DEFAULT_UNSTAGEABLE_REASON,
} from '../../lib/staging/unstageable.js';

// The drift guard unstageable.js's own header asks for and never had.
//
// That header says prompt and taxonomy live in the same file because "if the two ever
// drift, the gate silently mislabels rejections (the model says '4 = document', we tell
// the user 'vehicle')". The EXTERIOR gate has had such a guard since it shipped
// (test/staging/exterior-prompts.test.js); the interior gate — the one every upload goes
// through — was running on the comment alone. Adding a seventh digit is the moment to
// close that, because a mislabelled rejection now also sends the user to the wrong page.

/** Digit → a word that must appear in that digit's line of the prompt. */
const DIGIT_MEANINGS = {
  1: 'person',
  2: 'animal',
  3: 'food',
  4: 'screenshot',
  5: 'vehicle',
  6: 'other object',
  7: 'outside of a building',
};

/** The digit lines the prompt actually publishes, as [digit, lowercased text] pairs. */
function listedDigits() {
  return [...STAGEABLE_IMAGE_CHECK_PROMPT.matchAll(/^(\d) = (.+)$/gm)]
    .map((m) => [m[1], m[2].toLowerCase()]);
}

test('the prompt publishes exactly the digits the taxonomy maps', () => {
  const listed = listedDigits().map(([d]) => d).filter((d) => d !== '0');
  assert.deepEqual(
    listed.slice().sort(),
    Object.keys(UNSTAGEABLE_CODES).slice().sort(),
    'a digit in one and not the other is the drift the file header warns about',
  );
  assert.equal(new Set(listed).size, listed.length, 'a digit listed twice makes the reply ambiguous');
});

test('every published digit still means what the taxonomy says it means', () => {
  for (const [digit, text] of listedDigits()) {
    if (digit === '0') continue;
    const expected = DIGIT_MEANINGS[digit];
    assert.ok(expected, `digit ${digit} has no expected meaning recorded in this test`);
    assert.ok(text.includes(expected), `digit ${digit} must still mean "${expected}", got: ${text}`);
  }
});

test('0 is reserved for VALID and has no taxonomy entry', () => {
  // A zero entry would give a valid upload a rejection code, which every consumer reads
  // as "rejected" — the browser would paint an error over a photo it just accepted.
  assert.equal(UNSTAGEABLE_CODES['0'], undefined);
  assert.match(STAGEABLE_IMAGE_CHECK_PROMPT, /^0 = VALID/m);
});

test('the generic fallbacks stay distinct from every category', () => {
  const entries = Object.values(UNSTAGEABLE_CODES);
  assert.ok(!entries.some((e) => e.code === GENERIC_UNSTAGEABLE_CODE));
  assert.ok(!entries.some((e) => e.message === DEFAULT_UNSTAGEABLE_REASON));
});

test('the accept-list still names every outdoor living area the tool stages', () => {
  // THE assertion that catches "made digit 7 work by deleting the outdoor bullet".
  // Patios, balconies, decks and yards are spaces you put furniture in, so they are
  // interior-staging inputs; only the BUILDING seen from outside belongs to digit 7. A
  // prompt that reaches the right verdict on facades by refusing every outdoor photo
  // would pass every other test here while silently removing a shipped capability — and
  // it would upsell the Exterior Studio to people who do not need it.
  const text = STAGEABLE_IMAGE_CHECK_PROMPT.toLowerCase();
  for (const space of ['patio', 'balcony', 'deck', 'terrace', 'porch', 'yard']) {
    assert.ok(text.includes(space), `the accept-list must still name ${space}`);
  }
});

test('the interior/exterior boundary is drawn by CAMERA POSITION, not by what is visible', () => {
  // The two false positives that matter, both of which contain a facade in frame:
  //   - a living room shot through a window onto the house opposite
  //   - a back patio with the rear of the house filling the top half
  // A content-based rule ("is a building visible?") rejects both. The prompt therefore
  // says where the camera stands is what decides, and spells out each case.
  const text = STAGEABLE_IMAGE_CHECK_PROMPT.toLowerCase();
  assert.ok(text.includes('where the camera is'), 'the camera-position rule must survive');
  assert.ok(text.includes('windows show'), 'a room seen from indoors stays valid through its windows');
  assert.ok(text.includes('from inside it'), 'an outdoor living area is defined by shooting from inside it');
});

test('the prompt keeps its fail-open posture, including the new 0-vs-7 tie-break', () => {
  // The asymmetry that sets the tie-break: a facade wrongly accepted costs one poor
  // render on a photo the user chose; a patio wrongly rejected refuses a legitimate
  // upload AND upsells a tool they do not need, which reads as the product inventing a
  // reason to sell. Ties go to 0 in both directions.
  assert.match(STAGEABLE_IMAGE_CHECK_PROMPT, /unsure/i, 'the general "when unsure, answer 0" must survive');
  assert.match(
    STAGEABLE_IMAGE_CHECK_PROMPT,
    /cannot decide between 0 and\s+7, answer 0/i,
    'and the specific 0-vs-7 tie-break, which is what protects patios and window views',
  );
});

test('the reject line is qualified, so a facade is not swept back into VALID', () => {
  // The subtlest way this feature could ship doing nothing. The catch-all reads "reject
  // ONLY when the image is clearly NEITHER a property space NOR furniture" — and a house
  // photographed from the kerb IS a property space, so unqualified it tells the grader to
  // answer 0 for the exact thing digit 7 exists for. "Otherwise" scopes it beneath the
  // boundary paragraph.
  assert.match(
    STAGEABLE_IMAGE_CHECK_PROMPT,
    /Otherwise reject ONLY when the image is clearly NEITHER a property space NOR\s+furniture/,
    'the catch-all must stay subordinate to the exterior boundary above it',
  );
  const boundaryAt = STAGEABLE_IMAGE_CHECK_PROMPT.indexOf('ONE BOUNDARY MATTERS');
  const catchAllAt = STAGEABLE_IMAGE_CHECK_PROMPT.indexOf('Otherwise reject ONLY');
  assert.ok(boundaryAt > -1 && boundaryAt < catchAllAt, 'and the boundary must come first to be what it qualifies');
});

test('the boundary paragraph rules out the two digits that already compete for a facade', () => {
  // A kerbside photo with a car on the drive is answered 5 by the pre-7 prompt, and a
  // grader that reads "not a room" reaches for 6. Both are answers the model already
  // likes, so the new digit has to displace them by name.
  const boundary = STAGEABLE_IMAGE_CHECK_PROMPT.slice(
    STAGEABLE_IMAGE_CHECK_PROMPT.indexOf('ONE BOUNDARY MATTERS'),
    STAGEABLE_IMAGE_CHECK_PROMPT.indexOf('Otherwise reject ONLY'),
  );
  assert.ok(boundary.includes('(6)'), 'the boundary must say a facade is not UNRELATED_OBJECT');
  assert.ok(boundary.includes('(5)'), 'nor a VEHICLE just because a car is parked in front of it');
  assert.match(boundary, /answer 7/, 'and must name the digit it is steering to');
});

test('EXTERIOR names the Exterior Studio but carries no URL', () => {
  // The message is the canonical English the API returns and the browser falls back to.
  // The destination is plan-dependent (Exterior Studio for Stagify+, the plus page for
  // everyone else) and has to carry the visitor's locale prefix, so it lives in
  // public/scripts/unstageable-cta.js. A URL baked in here would be wrong for one of the
  // two plans, wrong for ten of the eleven languages, and unclickable besides — every
  // consumer renders this string with textContent.
  const { message } = UNSTAGEABLE_CODES['7'];
  assert.match(message, /Exterior Studio/);
  assert.ok(!/https?:|\.html|<a[\s>]/i.test(message), 'no URL or markup in the canonical copy');
});
