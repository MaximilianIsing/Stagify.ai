// Tier: markup/i18n drift guards — the homepage FAQ's three copies of the same nine
// answers.
//
// WHY THIS EXISTS. The FAQ text is written down in three places that no runtime code
// reconciles:
//
//   1. `faq.rooms.*` in english.json — what a visitor actually reads, because
//      language-loader.js assigns textContent from the pack on every load.
//   2. The inline text in index.html — the pre-hydration and no-JS rendering.
//   3. `#faq-jsonld` — the FAQPage structured data Google reads.
//
// Before this file existed, five of the seven answers shipped a SHORTER, DIFFERENT
// string in the markup than the pack put on screen, and the JSON-LD was a hand-copied
// third version. Nothing failed, because each of the three looks perfectly reasonable on
// its own — the only way to see it is to compare them, which is what this does. The
// section is regenerated from english.json, so the correct fix for a failure here is
// almost always to edit english.json and re-derive, not to patch one copy.
//
// The JSON-LD is deliberately NOT translated: language-loader.js:117 only ever touches
// the FIRST ld+json block in the document, and #faq-jsonld is the fourth. Localized
// pages therefore serve English FAQPage data. That is existing, intentional behaviour —
// this file pins the English parity, not a per-locale one.
//
// On the packs: test/server/static.test.js already gates key PRESENCE across all 11
// (english.json is the baseline). What it cannot check is the shape of a value, so the
// checks here cover the three that matter — that nothing is blank, that no pack still
// ships the English sentence, and that no question outgrows the space the floor plan
// reserves for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LANG_DIR = path.join(ROOT, 'public', 'languages');

const english = JSON.parse(fs.readFileSync(path.join(LANG_DIR, 'english.json'), 'utf8'));
const ROOM_KEYS = Object.keys(english.faq.rooms);

/** The three-part shape every room carries in every pack. */
const FIELDS = ['label', 'question', 'answer'];

/**
 * `<summary>`'s spans and the answer `<p>` ship the English text as their inline
 * fallback, so it has to be un-escaped before comparing with the pack.
 * @param {string} s
 */
function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Pull each `<details class="… faq-room">` out of index.html in document order,
 * with the three inline strings it authors.
 * @returns {Array<{key: string, label: string, question: string, answer: string}>}
 */
function roomsInMarkup() {
  const out = [];
  const block = /<details\b[^>]*\bclass="faq-q faq-room"[^>]*\bdata-room="([^"]+)"[^>]*>([\s\S]*?)<\/details>/g;
  for (const [, key, body] of INDEX.matchAll(block)) {
    const text = (cls) =>
      unescapeHtml((body.match(new RegExp(`class="${cls}"[^>]*>([^<]*)<`)) || [])[1] || '');
    out.push({
      key,
      label: text('faq-room__label'),
      question: text('faq-room__q'),
      answer: text('faq-room__a'),
    });
  }
  return out;
}

/** The FAQPage block, parsed. */
function faqJsonLd() {
  const raw = INDEX.match(
    /<script type="application\/ld\+json" id="faq-jsonld">([\s\S]*?)<\/script>/
  );
  assert.ok(raw, 'index.html has no #faq-jsonld block');
  return JSON.parse(raw[1]);
}

const packs = () =>
  fs.readdirSync(LANG_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, json: JSON.parse(fs.readFileSync(path.join(LANG_DIR, name), 'utf8')) }));

// --------------------------------------------------------------------------
// The three copies agree
// --------------------------------------------------------------------------

test('the markup ships exactly the rooms english.json defines, in the same order', () => {
  const markup = roomsInMarkup();
  assert.equal(markup.length, 9, 'nine rooms are drawn on the plan');
  assert.deepEqual(
    markup.map((r) => r.key),
    ROOM_KEYS,
    'data-room order must match english.json key order — the JSON-LD is indexed positionally against it'
  );
});

test('every inline string in the markup is byte-identical to english.json', () => {
  // This is the check that would have caught the original bug: the pack overwrites
  // textContent on load, so a divergent inline string is invisible in English and
  // simply never seen, while being what crawlers and no-JS visitors get.
  for (const room of roomsInMarkup()) {
    const pack = english.faq.rooms[room.key];
    for (const field of FIELDS) {
      assert.equal(
        room[field],
        pack[field],
        `index.html's ${field} for "${room.key}" differs from english.json. The section is ` +
          'generated from the pack — edit english.json and re-derive the markup, do not ' +
          'patch one copy.'
      );
    }
  }
});

test('#faq-jsonld mirrors english.json question for question', () => {
  const ld = faqJsonLd();
  assert.equal(ld['@type'], 'FAQPage');
  assert.equal(
    ld.mainEntity.length,
    ROOM_KEYS.length,
    'the FAQPage lists one Question per room'
  );

  ld.mainEntity.forEach((entry, i) => {
    const key = ROOM_KEYS[i];
    const pack = english.faq.rooms[key];
    assert.equal(entry['@type'], 'Question');
    assert.equal(entry.name, pack.question, `#faq-jsonld name for "${key}" is stale`);
    assert.equal(
      entry.acceptedAnswer.text,
      pack.answer,
      `#faq-jsonld answer for "${key}" is stale — Google would be served copy the page no ` +
        'longer shows'
    );
  });
});

// --------------------------------------------------------------------------
// The packs
// --------------------------------------------------------------------------

test('all eleven packs carry every room, fully populated', () => {
  const all = packs();
  assert.equal(all.length, 11, 'eleven language packs');

  for (const { name, json } of all) {
    assert.deepEqual(
      Object.keys(json.faq.rooms || {}),
      ROOM_KEYS,
      `${name} does not define the same nine rooms as english.json`
    );
    assert.ok(
      json.faq.plan && String(json.faq.plan.hint || '').trim(),
      `${name} is missing faq.plan.hint`
    );
    assert.ok(!json.faq.questions, `${name} still carries the retired faq.questions block`);
    if (name !== 'english.json') {
      assert.notEqual(
        json.faq.plan.hint.trim(), english.faq.plan.hint.trim(),
        `${name} still ships the English hint`
      );
    }

    for (const key of ROOM_KEYS) {
      for (const field of FIELDS) {
        const value = json.faq.rooms[key][field];
        assert.equal(typeof value, 'string', `${name}: faq.rooms.${key}.${field} is not a string`);
        assert.ok(value.trim().length > 0, `${name}: faq.rooms.${key}.${field} is empty`);
      }
    }
  }
});

test('no pack left a question or answer in English', () => {
  // Scoped to the two SENTENCE fields on purpose. `label` is a single word and matching
  // English there is frequently correct rather than lazy — Photos (fr), Control (es),
  // Privacy (it/nl) are the real words in those languages. Asserting on labels too would
  // be a guard that fires on correct translations, which is how guards get deleted.
  for (const { name, json } of packs()) {
    if (name === 'english.json') continue;
    for (const key of ROOM_KEYS) {
      for (const field of ['question', 'answer']) {
        assert.notEqual(
          json.faq.rooms[key][field],
          english.faq.rooms[key][field],
          `${name}: faq.rooms.${key}.${field} is still the English string`
        );
      }
    }
  }
});

test('no question outgrows the space the static fallback reserves for it', () => {
  // WHAT THIS GUARDS IS NOW THE FALLBACK PATH, not the normal one. It used to be the
  // normal one: the question sat in a title block at `top: calc(100% + 24px)` with the
  // answer pinned 54px below it, so a third line collided with the answer. Both the title
  // block and that fixed offset are gone — home-faq-plan.js's wireAnswerOffsets measures
  // the question and writes `--a-top` under it, so today a long question PUSHES its answer
  // down rather than running into it.
  //
  // The cap survives because the measurement is an enhancement, not a guarantee. With no
  // ResizeObserver the answer falls back to `top: var(--a-top, 27%)` in faq-plan.css, which
  // is a fixed reserve sized for three lines — and there the old collision is still real.
  // 140 characters is the measured three-line ceiling at the narrowest plan width (1001px).
  // German and Russian reach it long before English, which is exactly why it is a test.
  const CAP = 140;
  for (const { name, json } of packs()) {
    for (const key of ROOM_KEYS) {
      const q = json.faq.rooms[key].question;
      assert.ok(
        q.length <= CAP,
        `${name}: faq.rooms.${key}.question is ${q.length} chars, over the ${CAP} cap — it ` +
          'would outgrow the 27% the answer falls back to when nothing measures it. Shorten ' +
          'the question; the room label carries the topic.'
      );
    }
  }
});

test('no answer outgrows the notes column', () => {
  // The answer is set in a fixed column beside the drawing. What it runs out of is the
  // notes panel's own floor — `.faq-plan__notes` is `bottom: 2.5%` in faq-plan.css, and
  // because that panel has an EDGE, an overrun does not fade quietly into the grid the way
  // it did when the column was open at the bottom: it runs off the paper. (It used to run
  // over a title block pinned to the column's foot. That block is retired; the floor is
  // now the panel edge itself.)
  //
  // The column is ~31% of the sheet at ~1.15cqw type, which measures out at roughly 560
  // effective characters. The binding case is a short window, where the sheet is
  // height-capped near 640px but the type has already hit its clamp floor and stopped
  // shrinking with it. Measured today at the smallest sheet the CSS can produce
  // (--sheet-w 696px, 456px tall), the worst German and Russian answers still clear the
  // floor by 30-107px, so this cap is conservative rather than tight.
  //
  // "Effective" doubles CJK, whose glyphs are about twice as wide as Latin ones, so one
  // budget covers all eleven packs.
  const CAP = 560;
  for (const { name, json } of packs()) {
    const wide = /japanese|korean|chinese/.test(name) ? 2 : 1;
    for (const key of ROOM_KEYS) {
      const answer = json.faq.rooms[key].answer;
      const effective = answer.length * wide;
      assert.ok(
        effective <= CAP,
        `${name}: faq.rooms.${key}.answer is ${effective} effective chars, over the ${CAP} ` +
          'the notes column fits. It would run off the bottom of the panel. Tighten the copy.'
      );
    }
  }
});

test('the room labels stay short enough to sit inside their own room', () => {
  // Budgeted PER ROOM, not against one flat number, because the rooms are different
  // widths: `turnaround` is 16% of the stage and `photos` is 24%, so a label that is
  // comfortable in one spills through a wall in the other. German found this the honest
  // way — "Bearbeitungszeit" is fine in any wide room and 16 characters too long in the
  // narrowest one.
  //
  // Budget is ~0.85 characters per percent of stage width for Latin scripts, and ~0.35
  // for CJK, whose glyphs are about twice as wide. The label font scales with the stage
  // (clamp + cqw in faq-plan.css), so this ratio holds at every plan size.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  /** @type {Record<string, number>} */
  const width = {};
  for (const m of html.matchAll(/data-room="(\w+)"[^>]*--w:(\d+)/g)) width[m[1]] = Number(m[2]);
  assert.equal(Object.keys(width).length, ROOM_KEYS.length, 'every room declares a --w');

  for (const { name, json } of packs()) {
    const perPercent = /japanese|korean|chinese/.test(name) ? 0.35 : 0.85;
    for (const key of ROOM_KEYS) {
      const label = json.faq.rooms[key].label;
      const cap = Math.floor(width[key] * perPercent);
      assert.ok(
        label.length <= cap,
        `${name}: faq.rooms.${key}.label is "${label}" (${label.length} chars) but its room ` +
          `is only ${width[key]}% of the plan, which fits about ${cap}. Labels are per-pack ` +
          'strings precisely so a translator can pick a shorter word.'
      );
    }
  }
});
