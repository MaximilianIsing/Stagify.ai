// node --test "instagram/**/*.test.js"
//
// Deliberately NOT under test/ — that glob gates the site deploy, and a marketing tool
// must never be able to block a Render build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDashes, assertNoDashes, assertHtmlClean, assertCopyClean, stripNonVisibleBlocks,
} from './rules.js';

test('catches the em dash that actually shipped in post 07-27', () => {
  // Verbatim from instagram/history/backfill/07-27.png. A careful human wrote this and did not
  // mean to. That is the whole argument for enforcing the rule in code.
  const real = 'Same patio, Coastal preset — staged in ~8 seconds.';
  const hits = findDashes(real);
  assert.equal(hits.length, 1);
  assert.match(hits[0].name, /em dash/);
  assert.throws(() => assertNoDashes(real, 'subhead'), /Banned dash in subhead/);
});

test('bans the whole dash family, not just U+2014', () => {
  for (const sample of ['a ‒ b', 'a – b', 'a — b', 'a ― b', 'a ⸺ b', 'a ⸻ b']) {
    assert.equal(findDashes(sample).length, 1, `expected a hit in ${JSON.stringify(sample)}`);
  }
});

test('an en dash counts, because at post size it is indistinguishable from an em dash', () => {
  assert.throws(() => assertNoDashes('Empty – staged', 'headline'));
});

test('leaves legitimate punctuation alone', () => {
  const clean = [
    "Buyers scroll right past empty patios. Here's the fix.",
    'Empty to staged. One click. Free.',
    'Move-in ready, sold-ready, budget-friendly',
    'A hyphenated-word is fine',
    'Ranges like 8-12 seconds are fine',
    'Ellipsis … and middot · and arrow → survive',
  ];
  for (const sample of clean) {
    assert.deepEqual(findDashes(sample), [], `false positive on ${JSON.stringify(sample)}`);
  }
});

test('catches a double hyphen used as a dash but not a CLI flag or a range', () => {
  assert.equal(findDashes('the room -- empty and cold').length, 1);
  assert.equal(findDashes('run with --dry-run enabled').length, 0);
  assert.equal(findDashes('em--dash inside a word').length, 0);
});

test('reports position and an excerpt so the offending line is findable', () => {
  const [hit] = findDashes('one two three — four five six');
  assert.equal(typeof hit.index, 'number');
  assert.match(hit.excerpt, /three/);
});

test('scans rendered HTML text and attributes', () => {
  assert.throws(
    () => assertHtmlClean('<h1>Empty — staged</h1>', 'render'),
    /Banned dash in render/,
  );
  assert.throws(
    () => assertHtmlClean('<img alt="a room — staged">', 'render'),
    /Banned dash/,
  );
});

test('ignores dashes inside style and script blocks', () => {
  // Load bearing: brand-css.js inlines the site's own :root block, whose comment reads
  // "Brand blues — the ramp the app actually paints with." Scanning raw HTML would fail
  // every single render on a character no viewer can ever see, and the obvious "fix"
  // someone would reach for is turning the check off.
  const html = '<style>/* Brand blues — the ramp */</style><h1>All clear</h1>';
  assert.doesNotThrow(() => assertHtmlClean(html, 'render'));
  assert.equal(stripNonVisibleBlocks(html).includes('—'), false);
});

test('still catches a dash in the body when a style block also contains one', () => {
  const html = '<style>/* tokens — extracted */</style><h1>Empty — staged</h1>';
  assert.throws(() => assertHtmlClean(html, 'render'), /Banned dash/);
});

test('walks nested copy objects and names the offending key path', () => {
  const copy = { headline: 'fine', nested: { deep: ['ok', 'bad — here'] } };
  assert.throws(() => assertCopyClean(copy, 'post'), /post\.nested\.deep\[1\]/);
});

test('empty and missing values are clean, not crashes', () => {
  assert.deepEqual(findDashes(''), []);
  assert.deepEqual(findDashes(null), []);
  assert.doesNotThrow(() => assertCopyClean({ a: null, b: undefined, c: 3 }, 'post'));
});
