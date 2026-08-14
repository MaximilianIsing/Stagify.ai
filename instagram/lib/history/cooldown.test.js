// node --test "instagram/**/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLedger, checkCandidate, rankCandidates, relaxUntilFeasible,
  noveltyScore, jaccard, contentTokens, trigrams, clampWindow,
} from './cooldown.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The real config, so the test fails when someone loosens a window without meaning to.
const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'config.json'), 'utf8'));

const base = {
  id: 'p', template: 'editorial-card', layoutFamily: 'editorial', featureShown: 'style-presets',
  hookArchetype: 'one-to-many', audience: 'agents', roomType: 'Living room',
  style: 'coastal', palette: 'warm neutral', ctaStyle: 'try-free-pill',
  topic: 'one room five styles', visualSummary: 'brand blue field with a grid of rooms',
  copy: { headline: 'One empty room. Five different buyers.' },
  hashtagSet: ['#virtualstaging', '#homestaging'],
};

const post = (id, over = {}) => ({ ...base, id, ...over });

test('an exact repeat of the previous post is blocked', () => {
  const ledger = buildLedger([post('old')], config);
  const result = checkCandidate(post('new'), ledger, config);
  assert.equal(result.ok, false);
  const blocked = result.violations.map((v) => v.dimension);
  for (const d of ['template', 'featureShown', 'hookArchetype', 'audience', 'roomType']) {
    assert.ok(blocked.includes(d), `expected ${d} to block`);
  }
});

test('an empty history blocks nothing', () => {
  const ledger = buildLedger([], config);
  assert.equal(checkCandidate(post('first'), ledger, config).ok, true);
});

test('a dimension leaves cooldown once its window has passed', () => {
  const window = config.cooldowns.hard.audience; // 3
  // `audience: 'agents'` in the oldest post, then `window` newer posts using other values.
  const history = [post('a0', { audience: 'agents' })];
  for (let i = 0; i < window; i += 1) {
    history.push(post(`a${i + 1}`, { audience: i % 2 ? 'design' : 'homeowners' }));
  }
  const ledger = buildLedger(history, config);
  assert.equal(ledger.dimensions.audience.recency.agents, window);
  assert.equal(ledger.dimensions.audience.blocked.includes('agents'), false);
});

test('the ledger counts recency in posts ago, newest first', () => {
  const ledger = buildLedger(
    [post('oldest', { template: 'a' }), post('mid', { template: 'b' }), post('newest', { template: 'c' })],
    config,
  );
  assert.equal(ledger.dimensions.template.recency.c, 0);
  assert.equal(ledger.dimensions.template.recency.b, 1);
  assert.equal(ledger.dimensions.template.recency.a, 2);
});

test('a candidate missing a cooldown dimension is rejected, not silently passed', () => {
  const ledger = buildLedger([], config);
  const { audience: _dropped, ...incomplete } = post('x');
  const result = checkCandidate(incomplete, ledger, config);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.dimension === 'audience' && v.kind === 'missing'));
});

test('catches a reworded headline that only changed its punctuation', () => {
  const ledger = buildLedger([post('old')], config);
  const candidate = post('new', {
    template: 'stat-card', layoutFamily: 'type-first', featureShown: 'free-tier', hookArchetype: 'myth-bust',
    audience: 'design', roomType: 'Kitchen', style: 'modern', palette: 'cool grey',
    ctaStyle: 'link-in-bio-plain', topic: 'entirely different subject matter here',
    visualSummary: 'white card on pale wash with a single large numeral',
    copy: { headline: 'One empty room, five different buyers' },
  });
  const result = checkCandidate(candidate, ledger, config);
  assert.equal(result.ok, false, 'every discrete dimension is fresh, so only similarity can catch this');
  const hit = result.violations.find((v) => v.dimension === 'headline');
  assert.ok(hit, 'expected the headline similarity gate to fire');
  assert.ok(hit.similarity > config.cooldowns.similarity.headline.maxJaccard);
});

test('catches the same topic dressed in new dimensions', () => {
  const ledger = buildLedger([post('old', { topic: 'empty patios lose buyer attention fast' })], config);
  const candidate = post('new', {
    template: 'stat-card', layoutFamily: 'type-first', featureShown: 'free-tier', hookArchetype: 'myth-bust',
    audience: 'design', roomType: 'Kitchen', style: 'modern', palette: 'cool grey',
    ctaStyle: 'link-in-bio-plain',
    topic: 'empty patios lose buyer attention quickly',
    visualSummary: 'completely unrelated visual treatment goes here',
    copy: { headline: 'A totally unrelated headline about something else' },
  });
  const result = checkCandidate(candidate, ledger, config);
  assert.ok(result.violations.some((v) => v.dimension === 'topic'));
});

test('hashtag overlap warns but never blocks', () => {
  const ledger = buildLedger([post('old', { hashtagSet: ['#a', '#b', '#c'] })], config);
  const candidate = post('new', {
    template: 'stat-card', layoutFamily: 'type-first', featureShown: 'free-tier', hookArchetype: 'myth-bust',
    audience: 'design', roomType: 'Kitchen', style: 'modern', palette: 'cool grey',
    ctaStyle: 'link-in-bio-plain', topic: 'unrelated subject entirely',
    visualSummary: 'unrelated visual treatment',
    copy: { headline: 'Unrelated headline text' },
    hashtagSet: ['#a', '#b', '#c'],
  });
  const result = checkCandidate(candidate, ledger, config);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.dimension === 'hashtagSet'));
});

test('novelty scores a repeat near zero and a fresh candidate near full marks', () => {
  const ledger = buildLedger([post('old')], config);
  assert.ok(noveltyScore(post('same'), ledger) < 20);
  const fresh = post('fresh', {
    template: 'stat-card', layoutFamily: 'type-first', featureShown: 'free-tier', hookArchetype: 'myth-bust',
    audience: 'design', roomType: 'Kitchen', style: 'modern', palette: 'cool grey',
    ctaStyle: 'link-in-bio-plain', copy: { headline: 'Nothing alike at all here' },
  });
  assert.ok(noveltyScore(fresh, ledger) > 90);
});

test('ranking puts unblocked candidates first, then the most novel', () => {
  const ledger = buildLedger([post('old')], config);
  const ranked = rankCandidates([
    post('repeat'),
    post('fresh', {
      template: 'stat-card', layoutFamily: 'type-first', featureShown: 'free-tier', hookArchetype: 'myth-bust',
      audience: 'design', roomType: 'Kitchen', style: 'modern', palette: 'cool grey',
      ctaStyle: 'link-in-bio-plain', topic: 'unrelated', visualSummary: 'unrelated',
      copy: { headline: 'Nothing alike' },
    }),
  ], ledger, config);
  assert.equal(ranked[0].candidate.id, 'fresh');
  assert.equal(ranked[0].result.ok, true);
  assert.equal(ranked[1].result.ok, false);
});

test('relaxUntilFeasible terminates and reports what it gave up', () => {
  // Every candidate is a clone of recent history, so nothing can pass at full strictness.
  const history = Array.from({ length: 10 }, (_, i) => post(`h${i}`));
  const ledger = buildLedger(history, config);
  const { ranked, relaxed } = relaxUntilFeasible([post('c1'), post('c2')], ledger, config, { minViable: 1 });
  assert.ok(Array.isArray(relaxed));
  assert.ok(ranked.length === 2);
  // It must not loop forever, and it must be honest about the windows it halved.
  for (const entry of relaxed) {
    assert.ok(entry.to < entry.from);
    assert.ok(entry.to >= 1);
  }
});

test('every relaxable dimension is listed in relaxOrder', () => {
  // A new hard dimension that nobody added to relaxOrder would be silently un-relaxable,
  // which is how a deadlock ships.
  const relaxable = new Set(config.cooldowns.relaxOrder);
  for (const dimension of Object.keys(config.cooldowns.hard)) {
    assert.ok(relaxable.has(dimension), `${dimension} is missing from cooldowns.relaxOrder`);
  }
});

test('a window can never block every value a dimension owns', () => {
  // The real bug this caught: audience had a window of 3 against exactly 3 audiences, so
  // once three posts existed nothing could ever pass again. Config alone cannot be trusted
  // to stay below the ceiling as vocabularies change, so the clamp is enforced here.
  assert.equal(clampWindow(3, 3), 2);
  assert.equal(clampWindow(6, 1), 0);
  assert.equal(clampWindow(2, 8), 2, 'a safe window is left alone');
  assert.equal(clampWindow(4, undefined), 4, 'a free-text dimension has no ceiling');
});

test('a clamped ledger always leaves at least one value open', () => {
  const audiences = ['agents', 'homeowners', 'design'];
  // Three posts in a row, one per audience: the unclamped window of 3 would block all three.
  const history = audiences.map((audience, i) => post(`a${i}`, { audience }));
  const ledger = buildLedger(history, config, { vocabulary: { audience: audiences.length } });
  const blocked = ledger.dimensions.audience.blocked;
  assert.ok(blocked.length < audiences.length, `every audience is blocked: ${blocked.join(', ')}`);
});

test('clamping is reported rather than applied silently', () => {
  const ledger = buildLedger([], config, { vocabulary: { template: 1 } });
  const note = ledger.clampedWindows.find((c) => c.dimension === 'template');
  assert.ok(note, 'expected a clampedWindows entry so a wrong config is visible');
  assert.equal(note.to, 0);
});

test('the shipped config keeps every window under its vocabulary', () => {
  // Guards the config itself, not just the clamp. A new hard dimension with a too-wide
  // window should fail here rather than quietly relying on the runtime rescue.
  const vocabulary = {
    layoutFamily: Object.keys(config.layoutFamilies).filter((k) => !k.startsWith('_')).length,
    featureShown: Object.keys(config.features).filter((k) => !k.startsWith('_')).length,
    hookArchetype: config.hookArchetypes.length,
    audience: Object.keys(config.audiences).length,
    roomType: config.roomTypes.valid.length,
    style: config.styles.valid.length,
    ctaStyle: config.ctaStyles.length,
  };
  for (const [dimension, size] of Object.entries(vocabulary)) {
    const window = config.cooldowns.hard[dimension];
    assert.ok(
      window < size,
      `cooldowns.hard.${dimension} is ${window} but only ${size} values exist, which deadlocks`,
    );
  }
});

test('blocks the visual device even when every template id is different', () => {
  // The failure this dimension exists for. Three consecutive posts divided the frame with a
  // blue line under three different template ids, so template, feature, hook, room, style
  // and CTA all passed and the account shipped the same-looking post three times.
  const history = [
    post('h1', { template: 'legacy-zigzag-split', layoutFamily: 'fullbleed' }),
    post('h2', { template: 'legacy-vertical-wipe', layoutFamily: 'fullbleed' }),
  ];
  const ledger = buildLedger(history, config);
  const candidate = post('new', {
    // Everything else is deliberately fresh, so only layoutFamily can catch it.
    template: 'diagonal-reveal', layoutFamily: 'fullbleed',
    featureShown: 'furniture-removal', hookArchetype: 'problem-reveal', audience: 'design',
    roomType: 'Kitchen', style: 'farmhouse', palette: 'unrelated palette entirely',
    ctaStyle: 'see-all-the-styles', topic: 'a completely unrelated subject',
    visualSummary: 'a completely different treatment altogether',
    copy: { headline: 'Nothing alike whatsoever' },
  });
  const result = checkCandidate(candidate, ledger, config);
  assert.equal(result.ok, false, 'a fourth split-frame post in a row must be blocked');
  assert.ok(result.violations.some((v) => v.dimension === 'layoutFamily'));
});

test('similarity helpers behave', () => {
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(contentTokens('The the and OF a room').has('room'), true);
  assert.equal(contentTokens('The the and OF a room').has('the'), false);
  assert.ok(trigrams('abcd').size > 0);
});
