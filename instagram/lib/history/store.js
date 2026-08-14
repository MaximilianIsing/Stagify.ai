// JSONL history I/O.
//
// Append-only, one JSON object per line. Chosen over a JSON array because a run's diff is
// then exactly `+1 line` instead of a reindented blob, and over SQLite because the whole
// point of committing history is that a human can read it in a pull request. At one post a
// day the query-performance argument for a database never arrives.
//
// Measurements live in their own file rather than inside the post record. Numbers arrive
// days or weeks after a post ships, and folding them back in would mean rewriting a line
// that is supposed to be immutable.
import fs from 'node:fs';
import path from 'node:path';
import { buildLedger } from './cooldown.js';

export function historyDir(repoRoot) {
  return path.join(repoRoot, 'instagram', 'history');
}

export function loadConfig(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'instagram', 'config.json'), 'utf8'));
}

/**
 * How many distinct values each cooldown dimension can actually offer.
 *
 * Feeds buildLedger's window clamp. Templates are counted from disk rather than config,
 * because the library grows and a window wider than the number of templates that exist
 * would block every one of them.
 */
export function vocabularySizes(repoRoot, config) {
  const templateDir = path.join(repoRoot, 'instagram', 'templates');
  const templates = fs.existsSync(templateDir)
    ? fs.readdirSync(templateDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_')).length
    : 0;

  return {
    template: templates,
    layoutFamily: Object.keys(config.layoutFamilies).filter((k) => !k.startsWith('_')).length,
    featureShown: Object.keys(config.features).filter((k) => !k.startsWith('_')).length,
    hookArchetype: config.hookArchetypes.length,
    audience: Object.keys(config.audiences).length,
    roomType: config.roomTypes.valid.length,
    style: config.styles.valid.length,
    ctaStyle: config.ctaStyles.length,
    // palette is free text with no fixed vocabulary, so it is deliberately absent and
    // its window is left exactly as configured.
  };
}

/**
 * Fill in each candidate's layoutFamily from the template it names.
 *
 * Derived rather than declared, deliberately. Asking the ideation step to state both a
 * template and its family invites the two to disagree, and the family is not a creative
 * choice: it is a property of the template that was already picked.
 *
 * @param {object[]} candidates
 * @param {Array<{ meta: object }>} templates from loadTemplates()
 */
export function withLayoutFamily(candidates, templates) {
  const familyByTemplate = new Map(templates.map((t) => [t.meta.id, t.meta.layoutFamily]));
  return candidates.map((candidate) => {
    if (candidate.layoutFamily) return candidate; // already known, e.g. a backfilled record
    const family = familyByTemplate.get(candidate.template);
    if (!family) {
      throw new Error(
        `Cannot derive layoutFamily: no template "${candidate.template}". `
        + `Known: ${[...familyByTemplate.keys()].join(', ')}`,
      );
    }
    return { ...candidate, layoutFamily: family };
  });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path.basename(file)} line ${i + 1} is not valid JSON: ${error.message}`);
      }
    });
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // One line, no pretty printing. A wrapped record would break the format on the next read.
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** @returns {object[]} oldest first, which is the order they were appended. */
export function readPosts(repoRoot) {
  return readJsonl(path.join(historyDir(repoRoot), 'posts.jsonl'));
}

export function appendPost(repoRoot, record) {
  if (!record?.id) throw new Error('A post record needs an id.');
  const existing = readPosts(repoRoot);
  if (existing.some((p) => p.id === record.id)) {
    throw new Error(`Post ${record.id} is already in history. Ids are unique.`);
  }
  appendJsonl(path.join(historyDir(repoRoot), 'posts.jsonl'), record);
  refreshLedger(repoRoot);
  return record;
}

export function readMetrics(repoRoot) {
  return readJsonl(path.join(historyDir(repoRoot), 'metrics.jsonl'));
}

export function appendMetric(repoRoot, row) {
  if (!row?.postId) throw new Error('A metrics row needs a postId.');
  appendJsonl(path.join(historyDir(repoRoot), 'metrics.jsonl'), row);
}

/**
 * Regenerate history/ledger.json from posts.jsonl.
 *
 * The ledger is fully derived, and is committed anyway: the ideation step reads it, and so
 * does a human wanting to know "what am I currently blocked from" without running anything.
 */
export function refreshLedger(repoRoot) {
  const config = loadConfig(repoRoot);
  const posts = readPosts(repoRoot);
  const ledger = buildLedger(posts, config, { vocabulary: vocabularySizes(repoRoot, config) });
  const file = path.join(historyDir(repoRoot), 'ledger.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    derivedFrom: 'posts.jsonl',
    note: 'Generated by lib/history/store.js. Do not hand edit; edit posts.jsonl and rerun.',
    ...ledger,
  }, null, 2)}\n`, 'utf8');
  return ledger;
}

/**
 * What the ideation step is allowed to choose from, phrased positively.
 * A blocked list tells an agent what to avoid; an available list tells it what to do, and
 * the second produces better ideas.
 */
export function availableDimensions(ledger, config) {
  const universe = {
    template: null, // filled by the caller from the template registry
    layoutFamily: Object.keys(config.layoutFamilies).filter((k) => !k.startsWith('_')),
    featureShown: Object.keys(config.features).filter((k) => !k.startsWith('_')),
    hookArchetype: config.hookArchetypes,
    audience: Object.keys(config.audiences),
    roomType: config.roomTypes.valid,
    style: config.styles.valid,
    ctaStyle: config.ctaStyles,
  };

  const out = {};
  for (const [dimension, values] of Object.entries(universe)) {
    if (!values) continue;
    const blocked = new Set(ledger.dimensions[dimension]?.blocked ?? []);
    out[dimension] = {
      available: values.filter((v) => !blocked.has(v)),
      blocked: values.filter((v) => blocked.has(v)),
    };
  }
  return out;
}
