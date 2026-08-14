#!/usr/bin/env node
// Research cache. Node decides what is stale, the agent does the searching, Node persists.
//
//   node instagram/bin/research.js --plan              which keys need refreshing today
//   node instagram/bin/research.js --write market findings.json
//   node instagram/bin/research.js --read              everything still fresh, merged
//
// The TTLs are the reason a daily run is not slow. Trend data does not change between
// Tuesday and Wednesday, so most days --plan returns nothing and research is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = path.join(REPO_ROOT, 'instagram', 'research', 'cache');

export const RESEARCH_KEYS = {
  market: {
    ttlDays: 7,
    queries: ['housing market days on market trend', 'home buyer behaviour listing photos'],
    about: 'Market conditions a seller or agent would recognise this week.',
  },
  platform: {
    ttlDays: 30,
    queries: ['instagram carousel vs reels reach', 'instagram algorithm changes'],
    about: 'How Instagram is currently distributing formats.',
  },
  seasonal: {
    ttlDays: 30,
    keyed: 'month',
    queries: ['seasonal home staging angles', 'real estate seasonality'],
    about: 'What is timely for the current month specifically.',
  },
  competitors: {
    ttlDays: 14,
    queries: ['virtual staging companies social media', 'home staging instagram accounts'],
    about: 'What adjacent accounts are posting and which formats they use.',
  },
  policy: {
    ttlDays: 90,
    queries: ['MLS virtual staging disclosure rules', 'NAR virtually staged photo requirements'],
    about: 'Disclosure obligations. Rarely changes, expensive to get wrong.',
  },
};

function fileFor(key, now) {
  const spec = RESEARCH_KEYS[key];
  if (!spec) throw new Error(`Unknown research key "${key}". Known: ${Object.keys(RESEARCH_KEYS).join(', ')}`);
  const suffix = spec.keyed === 'month' ? `-${now.toISOString().slice(0, 7)}` : '';
  return path.join(CACHE_DIR, `${key}${suffix}.json`);
}

function ageDays(entry, now) {
  if (!entry?.fetchedAt) return Infinity;
  return (now.getTime() - new Date(entry.fetchedAt).getTime()) / 86_400_000;
}

function readKey(key, now) {
  const file = fileFor(key, now);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function plan(now = new Date()) {
  return Object.entries(RESEARCH_KEYS)
    .map(([key, spec]) => {
      const entry = readKey(key, now);
      const age = ageDays(entry, now);
      return {
        key, ...spec,
        file: path.relative(REPO_ROOT, fileFor(key, now)),
        ageDays: Number.isFinite(age) ? Number(age.toFixed(1)) : null,
        stale: age > spec.ttlDays,
      };
    })
    .filter((entry) => entry.stale);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: 'boolean', default: false },
    read: { type: 'boolean', default: false },
    write: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const now = new Date();

if (values.write) {
  const [source] = positionals;
  if (!source) {
    console.error('Usage: --write <key> <findings.json>');
    process.exit(1);
  }
  const findings = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, source), 'utf8'));
  const list = Array.isArray(findings) ? findings : findings.findings;
  if (!Array.isArray(list)) throw new Error('Findings must be an array, or an object with a findings array.');

  const missing = list.filter((f) => !f.sourceUrl);
  if (missing.length) {
    // A claim without a URL is a claim the tool cannot stand behind three weeks later.
    throw new Error(`${missing.length} finding(s) have no sourceUrl. Every claim needs one.`);
  }

  const file = fileFor(values.write, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    key: values.write,
    fetchedAt: now.toISOString(),
    ttlDays: RESEARCH_KEYS[values.write].ttlDays,
    queries: RESEARCH_KEYS[values.write].queries,
    findings: list,
  }, null, 2)}\n`);
  console.log(`Wrote ${list.length} findings to ${path.relative(REPO_ROOT, file)}`);
  process.exit(0);
}

if (values.read) {
  const merged = {};
  for (const key of Object.keys(RESEARCH_KEYS)) {
    const entry = readKey(key, now);
    if (entry && ageDays(entry, now) <= RESEARCH_KEYS[key].ttlDays) merged[key] = entry;
  }
  console.log(JSON.stringify(merged, null, 2));
  process.exit(0);
}

const stale = plan(now);
if (values.json) {
  console.log(JSON.stringify(stale, null, 2));
} else if (!stale.length) {
  console.log('Research is current. Nothing to refresh today.');
} else {
  console.log(`${stale.length} key(s) need refreshing:\n`);
  for (const entry of stale) {
    const age = entry.ageDays === null ? 'never fetched' : `${entry.ageDays} days old`;
    console.log(`  ${entry.key}  (ttl ${entry.ttlDays}d, ${age})`);
    console.log(`    ${entry.about}`);
    console.log(`    suggested queries: ${entry.queries.join(' | ')}`);
    console.log(`    write with: node instagram/bin/research.js --write ${entry.key} <findings.json>\n`);
  }
}
