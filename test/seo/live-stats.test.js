// Tier: unit, against the real homepage — lib/seo/live-stats.js.
//
// This module is a set of regexes run over public/index.html on its way to every visitor
// and every crawler. Two failure modes matter, and they fail in opposite directions:
//
//   - It silently stops matching (an attribute is reordered, the JSON-LD keys move, a `\s`
//     collapses in a template literal). Nobody notices: the page still renders, the hero
//     still animates for humans, and only an agent reading the markup sees blanks again —
//     which is the exact bug this feature was written to fix.
//   - It matches too much and mangles the page or the structured data.
//
// So these tests run against the file on disk rather than a fixture. If the markup in
// index.html drifts away from what the injector expects, this goes red at build time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCount, injectLiveStats } from '../../lib/seo/live-stats.js';
import { stripHtmlComments } from '../../lib/http/text-assets.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const HOME = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const STATS = { roomsStaged: 12345, usersServed: 678 };

/** Every hero-stat span in a body, as {key, attrs, text}. */
function statSpans(html) {
  return [...html.matchAll(/<span\b([^>]*\bclass="hp-stat__num"[^>]*)>([\s\S]*?)<\/span>/g)].map(
    (m) => ({
      attrs: m[1],
      key: /data-stat="([^"]+)"/.exec(m[1])?.[1],
      text: m[2],
    }),
  );
}

/** The single data-lang-jsonld block, parsed. */
function entityJsonLd(html) {
  const m = /<script type="application\/ld\+json" data-lang-jsonld[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  assert.ok(m, 'no data-lang-jsonld block found in index.html');
  return JSON.parse(m[1]);
}

test('formatCount groups exactly like count-up.js format()', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(678), '678');
  assert.equal(formatCount(12345), '12,345');
  assert.equal(formatCount(1234.6), '1,235');
});

test('the real homepage gets both counts written into its hero spans', () => {
  const spans = statSpans(injectLiveStats(HOME, STATS));
  const byKey = Object.fromEntries(spans.map((s) => [s.key, s]));

  assert.deepEqual(Object.keys(byKey).sort(), ['roomsStaged', 'usersServed']);
  assert.equal(byKey.roomsStaged.text, '12,345');
  assert.equal(byKey.usersServed.text, '678');
});

test('aria-hidden is dropped so the figure is in the a11y tree and in extracted text', () => {
  // The whole point: a crawler that strips tags, and a screen reader, both get the number.
  // count-up.js re-adds aria-hidden for the duration of the ramp and removes it at the
  // end, so a JS visitor's end state is unchanged.
  assert.match(HOME, /class="hp-stat__num"[^>]*aria-hidden="true"/, 'fixture assumption');
  for (const span of statSpans(injectLiveStats(HOME, STATS))) {
    assert.ok(!span.attrs.includes('aria-hidden'), `${span.key} kept aria-hidden`);
  }
});

test('the InteractionCounter structured data carries the same numbers', () => {
  const data = entityJsonLd(injectLiveStats(HOME, STATS));
  const counters = Object.fromEntries(
    data.interactionStatistic.map((c) => [c.interactionType, c.userInteractionCount]),
  );

  assert.equal(counters['https://schema.org/CreateAction'], 12345);
  assert.equal(counters['https://schema.org/RegisterAction'], 678);
});

test('the JSON-LD still parses after injection', () => {
  // Guards the one way this could break a page rather than merely fail to help it.
  assert.doesNotThrow(() => entityJsonLd(injectLiveStats(HOME, STATS)));
});

test('injection is idempotent', () => {
  const once = injectLiveStats(HOME, STATS);
  assert.equal(injectLiveStats(once, STATS), once);
});

test('a later count replaces an earlier one rather than appending to it', () => {
  const later = injectLiveStats(injectLiveStats(HOME, STATS), {
    roomsStaged: 99999,
    usersServed: 1,
  });
  const byKey = Object.fromEntries(statSpans(later).map((s) => [s.key, s.text]));
  assert.equal(byKey.roomsStaged, '99,999');
  assert.equal(byKey.usersServed, '1');
});

test('it works on the comment-stripped body, which is what is actually served', () => {
  // lib/http/text-assets.js strips comments first and injects second; testing only the
  // raw file would miss a stripper interaction.
  const served = injectLiveStats(stripHtmlComments(HOME), STATS);
  const byKey = Object.fromEntries(statSpans(served).map((s) => [s.key, s.text]));
  assert.equal(byKey.roomsStaged, '12,345');
  assert.equal(byKey.usersServed, '678');
});

test('pages without hero stats come back byte-identical', () => {
  for (const file of ['about.html', 'faq.html', 'guides.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.equal(injectLiveStats(html, STATS), html, `${file} was modified`);
  }
});

test('a missing or non-finite count leaves the markup as authored', () => {
  // Better a blank figure (today's behaviour) than "NaN" on the homepage.
  const partial = injectLiveStats(HOME, { roomsStaged: NaN, usersServed: 5 });
  const byKey = Object.fromEntries(statSpans(partial).map((s) => [s.key, s]));
  assert.match(byKey.roomsStaged.text, /&nbsp;/);
  assert.ok(byKey.roomsStaged.attrs.includes('aria-hidden'), 'untouched span kept its attrs');
  assert.equal(byKey.usersServed.text, '5');

  assert.equal(injectLiveStats(HOME, null), HOME);
});
