// The anti-sameness gate. Pure functions, zero I/O, so it can be tested exhaustively.
//
// Rule two of this tool is "posts must feel unique and new, they should not all look the
// same." An instruction cannot enforce that: an agent with no memory of last Tuesday will
// cheerfully rebuild last Tuesday's post and be pleased with it. So variety is a counter.
//
// Two kinds of check, because they catch different failures:
//   * Recency windows over discrete dimensions catch "same template again", "third
//     agent-targeted post in a row", "living room for the fifth time".
//   * Similarity over free text catches the case the counters miss entirely: a candidate
//     that picks all-new dimension values but is describing the same idea in new clothes.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from',
  'has', 'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'was', 'were', 'what',
  'when', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'not', 'no', 'so', 'if',
]);

/** Dimensions weighted for the novelty score. Higher weight means "matters more to variety". */
const NOVELTY_WEIGHTS = {
  template: 25,
  featureShown: 22,
  hookArchetype: 15,
  audience: 12,
  roomType: 10,
  style: 6,
  palette: 5,
  ctaStyle: 5,
};

export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words, stopwords dropped. Used for topic and visual-summary comparison. */
export function contentTokens(value) {
  return new Set(normalizeText(value).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

/**
 * Character trigrams. Used for headlines specifically.
 *
 * Word-set Jaccard says "One empty room. Five different buyers." and "One empty room, five
 * different buyers" are identical, which is right, but it also says a two-word headline
 * sharing one word is 50% similar, which is noise. Trigrams degrade more gracefully on the
 * very short strings headlines actually are.
 */
export function trigrams(value) {
  const s = ` ${normalizeText(value)} `;
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * The largest window a dimension can carry without deadlocking itself.
 *
 * A window of N blocks the N most recently used values. If a dimension only has N distinct
 * values to choose from, every one of them is blocked forever and no candidate can ever
 * pass. That is not a tuning mistake you notice later, it is a permanent stall.
 *
 * It shipped here immediately: `audience` had a window of 3 against exactly 3 audiences,
 * so the ledger reported "nothing open" the moment nine posts existed. The relaxer would
 * have rescued each run, but a gate that needs rescuing every single time trains you to
 * ignore it. So the ceiling is enforced in code and the clamp is reported.
 *
 * @param {number} window configured window
 * @param {number|undefined} vocabularySize how many distinct values the dimension offers
 */
export function clampWindow(window, vocabularySize) {
  if (!vocabularySize || !Number.isFinite(vocabularySize)) return window;
  return Math.max(0, Math.min(window, vocabularySize - 1));
}

/**
 * Collapse post history into the lookup the gate needs.
 * @param {object[]} posts oldest first, as read from posts.jsonl
 * @param {object} config the parsed config.json
 * @param {{ vocabulary?: Record<string, number> }} opts how many values each dimension has,
 *   used to clamp windows so a dimension can never block every option it owns
 */
export function buildLedger(posts, config, { vocabulary = {} } = {}) {
  const newestFirst = [...posts].reverse();
  const hard = config.cooldowns.hard;

  const dimensions = {};
  const clamped = [];
  for (const [dimension, configured] of Object.entries(hard)) {
    const window = clampWindow(configured, vocabulary[dimension]);
    if (window !== configured) {
      clamped.push({ dimension, from: configured, to: window, vocabulary: vocabulary[dimension] });
    }
    const recency = {};
    newestFirst.forEach((post, index) => {
      const value = post?.[dimension];
      // First occurrence wins because we walk newest first, so recency is "posts ago".
      if (value != null && !(value in recency)) recency[value] = index;
    });
    const blocked = Object.entries(recency)
      .filter(([, index]) => index < window)
      .map(([value]) => value)
      .sort();
    dimensions[dimension] = { window, recency, blocked };
  }

  return {
    count: posts.length,
    dimensions,
    // Non-empty means a configured window was wider than the dimension's vocabulary and
    // had to be reduced. Surfaced rather than silent: it means config.json is wrong.
    clampedWindows: clamped,
    recent: {
      topics: newestFirst.map((p) => ({ id: p.id, text: p.topic ?? '' })),
      visualSummaries: newestFirst.map((p) => ({ id: p.id, text: p.visualSummary ?? '' })),
      headlines: newestFirst.map((p) => ({ id: p.id, text: p.copy?.headline ?? '' })),
      hashtagSets: newestFirst.map((p) => ({ id: p.id, tags: p.hashtagSet ?? [] })),
    },
  };
}

function worstSimilarity(candidateText, entries, window, tokenizer) {
  const mine = tokenizer(candidateText);
  if (!mine.size) return { score: 0, against: null };
  let worst = { score: 0, against: null };
  for (const entry of entries.slice(0, window)) {
    if (!entry.text) continue;
    const score = jaccard(mine, tokenizer(entry.text));
    if (score > worst.score) worst = { score, against: entry.id };
  }
  return worst;
}

/**
 * @param {object} candidate flat post-shaped object
 * @param {ReturnType<typeof buildLedger>} ledger
 * @param {object} config
 * @returns {{ ok: boolean, violations: object[], warnings: object[], noveltyScore: number }}
 */
export function checkCandidate(candidate, ledger, config) {
  const violations = [];
  const warnings = [];

  for (const [dimension, { window, recency }] of Object.entries(ledger.dimensions)) {
    const value = candidate?.[dimension];
    if (value == null) {
      violations.push({
        dimension, kind: 'missing',
        detail: `Candidate has no "${dimension}". Every cooldown dimension must be declared.`,
      });
      continue;
    }
    const ago = recency[value];
    if (ago !== undefined && ago < window) {
      violations.push({
        dimension, value, kind: 'cooldown', recency: ago, window,
        detail: `"${value}" was used ${ago === 0 ? 'in the last post' : `${ago} posts ago`}, inside its ${window}-post window.`,
      });
    }
  }

  const sim = config.cooldowns.similarity;
  const checks = [
    ['topic', candidate.topic, ledger.recent.topics, contentTokens],
    ['visualSummary', candidate.visualSummary, ledger.recent.visualSummaries, contentTokens],
    ['headline', candidate.copy?.headline, ledger.recent.headlines, trigrams],
  ];
  for (const [name, text, entries, tokenizer] of checks) {
    const rule = sim[name];
    if (!rule || !text) continue;
    const worst = worstSimilarity(text, entries, rule.window, tokenizer);
    if (worst.score > rule.maxJaccard) {
      violations.push({
        dimension: name, kind: 'similarity', similarity: Number(worst.score.toFixed(3)),
        max: rule.maxJaccard, against: worst.against,
        detail: `Too close to ${worst.against} (${(worst.score * 100).toFixed(0)}% similar, limit ${(rule.maxJaccard * 100).toFixed(0)}%).`,
      });
    }
  }

  const tagRule = config.cooldowns.warn?.hashtagSet;
  if (tagRule && Array.isArray(candidate.hashtagSet) && candidate.hashtagSet.length) {
    const mine = new Set(candidate.hashtagSet.map((t) => t.toLowerCase()));
    for (const entry of ledger.recent.hashtagSets.slice(0, tagRule.window)) {
      const theirs = new Set((entry.tags ?? []).map((t) => t.toLowerCase()));
      if (!theirs.size) continue;
      const overlap = jaccard(mine, theirs);
      if (overlap > tagRule.maxOverlap) {
        warnings.push({
          dimension: 'hashtagSet', kind: 'overlap', against: entry.id,
          overlap: Number(overlap.toFixed(3)),
          detail: `Hashtags are ${(overlap * 100).toFixed(0)}% the same as ${entry.id}. Not blocking, but swap a few.`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    noveltyScore: noveltyScore(candidate, ledger),
  };
}

/**
 * 0 to 100. A candidate identical to the last post scores near 0; one sharing nothing
 * scores 100. Used to rank surviving candidates, never to block on its own.
 */
export function noveltyScore(candidate, ledger) {
  let weighted = 0;
  let total = 0;
  for (const [dimension, weight] of Object.entries(NOVELTY_WEIGHTS)) {
    const entry = ledger.dimensions[dimension];
    if (!entry) continue;
    const ago = entry.recency[candidate?.[dimension]];
    // Never used reads as maximum distance.
    const distance = ago === undefined ? 1 : Math.min(ago, entry.window) / entry.window;
    weighted += weight * distance;
    total += weight;
  }
  if (!total) return 100;

  const headline = candidate.copy?.headline;
  const penalty = headline
    ? worstSimilarity(headline, ledger.recent.headlines, 30, trigrams).score * 40
    : 0;

  return Math.max(0, Math.min(100, Math.round((100 * weighted) / total - penalty)));
}

/**
 * Rank candidates, unblocked first, then by novelty.
 * @param {object[]} candidates
 */
export function rankCandidates(candidates, ledger, config) {
  return candidates
    .map((candidate) => ({ candidate, result: checkCandidate(candidate, ledger, config) }))
    .sort((a, b) => {
      if (a.result.ok !== b.result.ok) return a.result.ok ? -1 : 1;
      return b.result.noveltyScore - a.result.noveltyScore;
    });
}

/**
 * Widen the gate until at least `minViable` candidates survive.
 *
 * Necessary because the windows can deadlock: with six templates and a six-post window,
 * exactly one template frees up per post, so a single skipped day or a template added
 * mid-flight can block everything. Rather than failing the run, halve one window at a time
 * in the configured order and record what was given up, so the ledger shows honestly when
 * variety had to bend. Halving toward a floor of 1 terminates, and at 1 every dimension
 * permits anything except an exact repeat of the previous post.
 */
export function relaxUntilFeasible(candidates, ledger, config, { minViable = 1 } = {}) {
  const relaxed = [];
  let working = config;
  let ranked = rankCandidates(candidates, ledger, working);

  for (const dimension of config.cooldowns.relaxOrder) {
    if (ranked.filter((r) => r.result.ok).length >= minViable) break;
    const current = working.cooldowns.hard[dimension];
    if (current === undefined || current <= 1) continue;

    const next = Math.max(1, Math.floor(current / 2));
    relaxed.push({ dimension, from: current, to: next });
    working = {
      ...working,
      cooldowns: { ...working.cooldowns, hard: { ...working.cooldowns.hard, [dimension]: next } },
    };
    ranked = rankCandidates(candidates, buildLedgerFromExisting(ledger, working), working);
  }

  return { ranked, relaxed };
}

/** Recompute only the blocked lists when a window shrinks; recency data is unchanged. */
function buildLedgerFromExisting(ledger, config) {
  const dimensions = {};
  for (const [dimension, entry] of Object.entries(ledger.dimensions)) {
    const window = config.cooldowns.hard[dimension] ?? entry.window;
    dimensions[dimension] = {
      window,
      recency: entry.recency,
      blocked: Object.entries(entry.recency)
        .filter(([, index]) => index < window)
        .map(([value]) => value)
        .sort(),
    };
  }
  return { ...ledger, dimensions };
}
