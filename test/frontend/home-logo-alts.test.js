// The homepage's two logo strips carry no translatable alt text, on purpose.
//
// Both were shipping unkeyed English inside otherwise fully-localized sections:
// 7 testimonial logos as "<Brokerage> logo" and 22 sponsor logos as
// "<Company> logo — Stagify.ai partner". Neither said anything a visitor could not
// already read — and neither could be fixed by translating, because the only word
// carrying information in each is a proper noun.
//
// An empty alt here is a DECISION, and it looks exactly like the bug an a11y sweep
// exists to catch, so these guards state the decision rather than leaving the next
// person to rediscover it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

const section = (needle) => {
  const at = html.indexOf(needle);
  const start = html.lastIndexOf('<section', at);
  return html.slice(start, html.indexOf('</section>', at));
};

// The brokerage is in `.tw-org` beside the image, translated in all 11 packs. An alt
// of "Tahari Realty logo" made a screen reader announce the name twice — the second
// time in English regardless of locale.
test('every testimonial logo has an empty alt', () => {
  const imgs = [...section('id="testimonials"').matchAll(/<img class="tw-logo"[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 7, 'expected 7 testimonial logos');
  for (const img of imgs) {
    const alt = img.match(/\balt="([^"]*)"/);
    assert.ok(alt, `a testimonial logo has no alt attribute at all: ${img}`);
    assert.equal(alt[1], '', `.tw-logo alt must stay empty, got "${alt[1]}" — the org name is already in .tw-org`);
  }
});

// The visible set names the company and nothing else; the marquee duplicates are
// aria-hidden, so any alt on them is text nobody can reach.
test('sponsor logos carry a bare company name, and the duplicates carry nothing', () => {
  const strip = section('class="sponsors"');
  const dupAt = strip.indexOf('<!-- Duplicate set for seamless loop -->');
  assert.ok(dupAt > 0, 'the duplicate-set boundary comment moved');

  const altsIn = (s) => [...s.matchAll(/<img src="media-webp\/sponsors\/[^>]*>/g)]
    .map((m) => {
      const alt = m[0].match(/\balt="([^"]*)"/);
      return alt ? alt[1] : null;
    });

  const real = altsIn(strip.slice(0, dupAt));
  const dup = altsIn(strip.slice(dupAt));
  assert.equal(real.length, 11, 'expected 11 visible sponsor logos');
  assert.equal(dup.length, 11, 'expected 11 duplicated sponsor logos');

  for (const alt of real) {
    assert.ok(alt, 'a visible sponsor logo lost its alt entirely — it should name the company');
    assert.ok(
      !/\blogo\b|partner|Stagify/i.test(alt),
      `sponsor alt must be the bare company name, got "${alt}" — the <h2> above already says what the strip is`,
    );
  }
  for (const alt of dup) {
    assert.equal(alt, '', `an aria-hidden duplicate must have an empty alt, got "${alt}"`);
  }
});

// The whole point: these sections must not reintroduce unkeyed English. Every OTHER
// text attribute in them either carries a data-lang-attr or is empty.
test('neither strip reintroduces an untranslated logo string', () => {
  // Comments stripped first: both sections carry a comment QUOTING the old alt to
  // explain why it went, and a naive scan fails on the explanation itself.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(
    !markup.includes('Stagify.ai partner'),
    'the "logo — Stagify.ai partner" suffix is back; it was unkeyed English in all 11 locales',
  );
  const testimonials = markup.slice(markup.indexOf('tw-deck'), markup.indexOf('id="compare"'));
  const bad = [...testimonials.matchAll(/alt="([^"]*\blogo\b[^"]*)"/gi)];
  assert.deepEqual(bad.map((m) => m[1]), [], 'a testimonial alt says "logo" again');
});
