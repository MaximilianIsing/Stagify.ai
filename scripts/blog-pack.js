// Finalize and verify a blog translation pack.
//
//   node scripts/blog-pack.js extract <slug>            → the English strings to translate
//   node scripts/blog-pack.js add <slug> <lang> <file>  → validate + stamp + write a pack
//   node scripts/blog-pack.js check [slug]              → re-verify packs already on disk
//
// WHY THIS EXISTS. The translations are produced by a model, and a model asked to return
// JSON will occasionally merge two paragraphs, localize an href, drop a list item, or
// helpfully "improve" a heading level. None of that is visible in a language you cannot
// read — it surfaces months later as a Spanish page with a dead link. So nothing reaches
// public/blog/i18n/ without passing lib/content/article-extract.js's structural checks
// against the English original.
//
// It also owns `_meta`. The fingerprint must be computed HERE, from the English article,
// never supplied by whoever did the translating: a self-reported hash is a staleness check
// that can only ever agree with itself. Same for `reviewed`, which is written false and is
// not the translator's to set.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  articleSourceHash,
  extractArticleStrings,
  currencyWarnings,
  extractHubStrings,
  hubSourceHash,
  normalizeCurrency,
  missingHubSlots,
  missingSlots,
  validateTranslatedBody,
} from '../lib/content/article-extract.js';
import {
  ARTICLES_BY_SLUG, BLOG_HUB, LOCALES, LOCALIZED_ARTICLES, localeByPrefix, localeByLang,
} from '../lib/i18n/locales.js';
import { HUB_PACK_DIR, PACK_ROOT } from '../lib/i18n/blog-packs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

/**
 * The five articles that describe United States practice. Their translations carry one
 * added callout telling the reader the rules are US-specific — see the prompt guidance in
 * docs/guides/i18n.md. Everything else must reproduce the English structure exactly.
 * @type {Set<string>}
 */
export const US_SPECIFIC = new Set([
  'virtual-staging-disclosure-laws-by-state',
  'is-virtual-staging-allowed-on-the-mls',
  'fsbo-listing-photos',
  'dorm-room-design-ai-college-freshmen',
  'prepare-your-listing-for-the-fall-market',
]);

/** @param {string} slug */
function articleOrDie(slug) {
  const article = ARTICLES_BY_SLUG.get(slug);
  if (!article) {
    throw new Error(`unknown slug '${slug}'. Known: ${[...ARTICLES_BY_SLUG.keys()].join(', ')}`);
  }
  return article;
}

/** @param {string} slug */
function englishHtml(slug) {
  return fs.readFileSync(path.join(PUBLIC, ...articleOrDie(slug).file.split('/')), 'utf8');
}

/** Resolve 'es' or 'spanish' to a locale. @param {string} token */
function localeOrDie(token) {
  const locale = localeByPrefix(token) || localeByLang(token);
  if (!locale || !locale.prefix) {
    throw new Error(`unknown language '${token}'. Use a prefix (${LOCALES.map((l) => l.prefix).join(', ')}) or a pack name`);
  }
  return locale;
}

/** @param {string} slug @param {string} lang */
function packPath(slug, lang) {
  return path.join(PUBLIC, ...PACK_ROOT.split('/'), slug, `${lang}.json`);
}

/**
 * UI labels an article quotes verbatim, as English text → the key holding that label in
 * public/languages/<lang>.json.
 *
 * When an article says "tick Label as virtually staged", the translation has to name the
 * control the app ACTUALLY shows in that language, not a fresh translation of the English
 * words. Otherwise the Italian article tells the reader to look for "Segnala come home
 * staging virtuale" and the product says "Contrassegna come arredato virtualmente" — the
 * reader hunts for a checkbox that does not exist. It is the same failure the glossary's
 * never-translate list prevents for product names, one level down.
 * @type {Record<string, string>}
 */
const QUOTED_UI_STRINGS = {
  'Label as virtually staged': 'modal.staging.labelVirtuallyStaged',
};

/** The value of a dotted key in a language pack, or null. */
function uiString(lang, dotted) {
  try {
    const packs = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', `${lang}.json`), 'utf8'));
    let cur = packs;
    for (const part of dotted.split('.')) cur = cur === null || typeof cur !== 'object' ? undefined : cur[part];
    return typeof cur === 'string' ? cur : null;
  } catch {
    return null;
  }
}

/**
 * Notes for a pack — reported, never blocking. Money (see currencyWarnings) and quoted UI
 * labels.
 * @param {string} slug
 * @param {string} lang
 * @param {Record<string, any>} pack
 * @returns {string[]}
 */
export function packWarnings(slug, lang, pack) {
  const english = extractArticleStrings(englishHtml(slug));
  if (typeof pack.body !== 'string') return [];
  const out = currencyWarnings(english.body, pack.body);

  for (const [englishLabel, key] of Object.entries(QUOTED_UI_STRINGS)) {
    if (!english.body.includes(englishLabel)) continue;
    const shipped = lang ? uiString(lang, key) : null;
    if (shipped && !pack.body.includes(shipped)) {
      out.push(
        `ui-label: the article quotes the "${englishLabel}" control, but this translation `
        + `does not contain the label the app actually shows in ${lang} — "${shipped}" (${key}). `
        + 'A reader following the article would look for a checkbox that is not there.',
      );
    }
  }
  return out;
}

/**
 * Validate a candidate pack against the English article.
 * @param {string} slug
 * @param {Record<string, any>} pack  the translated slots, with or without _meta
 * @returns {string[]} problems; empty means it may be written
 */
export function verifyPack(slug, pack) {
  const english = extractArticleStrings(englishHtml(slug));
  /** @type {string[]} */
  const problems = [];

  const missing = missingSlots(pack);
  if (missing.length) problems.push(`missing or empty: ${missing.join(', ')}`);

  // The disclaimer is optional, but it is not optional PER LOCALE: an article that carries
  // one in English and not in Spanish drops a legal notice in exactly the markets least
  // able to check the original.
  if (english.disclaimer && !(typeof pack.disclaimer === 'string' && pack.disclaimer.trim())) {
    problems.push('the English article has a disclaimer; this translation drops it');
  }
  if (!english.disclaimer && pack.disclaimer) problems.push('disclaimer added where English has none');

  if (typeof pack.body === 'string') {
    problems.push(
      ...validateTranslatedBody(english.body, pack.body, { allowExtraCallout: US_SPECIFIC.has(slug) }),
    );
  }

  // A slot that came back identical to English is usually a slot the translator skipped.
  // Not fatal — "Blog" and a product name legitimately survive translation — so it is
  // reported for the untranslatable-by-accident case rather than enforced.
  const suspicious = ['title', 'eyebrow', 'crumb'].filter(
    (k) => typeof pack[k] === 'string' && pack[k].trim() === String(english[k]).trim(),
  );
  if (suspicious.length === 3) problems.push('every headline slot is byte-identical to English — untranslated?');

  return problems;
}

/**
 * Write a verified pack, stamping the metadata this module owns.
 * @param {string} slug
 * @param {string} langToken  'es' or 'spanish'
 * @param {Record<string, any>} translated
 * @returns {{ written: string }}
 */
export function addPack(slug, langToken, translated) {
  const locale = localeOrDie(langToken);
  const pack = { ...translated };
  delete pack._meta; // never trust a supplied fingerprint — see the header

  // Put every US dollar amount back into US form before anything looks at it. Translators
  // localize `$1,500` to `1.500 $` or `$0,15` by reflex, which is the right instinct for a
  // local price and the wrong one for a figure describing the US market. Normalizing here
  // rather than rejecting means ten good translations are not thrown away over a comma —
  // and validateTranslatedBody still compares the amounts afterwards, so a price that
  // genuinely CHANGED is still refused.
  for (const key of ['body', 'disclaimer']) {
    if (typeof pack[key] === 'string') pack[key] = normalizeCurrency(pack[key]);
  }
  if (pack.cta && typeof pack.cta === 'object') {
    for (const key of ['title', 'body', 'link']) {
      if (typeof pack.cta[key] === 'string') pack.cta[key] = normalizeCurrency(pack.cta[key]);
    }
  }
  for (const key of ['title', 'eyebrow', 'crumb', 'figureAlt']) {
    if (typeof pack[key] === 'string') pack[key] = normalizeCurrency(pack[key]);
  }
  if (pack.meta && typeof pack.meta === 'object') {
    for (const key of ['title', 'description']) {
      if (typeof pack.meta[key] === 'string') pack.meta[key] = normalizeCurrency(pack.meta[key]);
    }
  }

  const problems = verifyPack(slug, pack);
  if (problems.length) {
    throw new Error(`${slug}/${locale.lang}: refused\n  - ${problems.join('\n  - ')}`);
  }

  const out = {
    _meta: {
      sourceHash: articleSourceHash(englishHtml(slug)),
      slug,
      lang: locale.lang,
      hreflang: locale.hreflang,
      translatedAt: new Date().toISOString().slice(0, 10),
      marketNote: US_SPECIFIC.has(slug),
      // Recorded, not enforced. test/content/blog-packs.test.js asserts the field exists
      // and is a boolean; flipping it into a gate is a one-line change there once someone
      // has actually read these.
      reviewed: false,
    },
    ...pack,
  };

  const file = packPath(slug, locale.lang);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return { written: path.relative(ROOT, file) };
}

/**
 * Re-verify packs on disk: structure, and whether the English has moved since.
 * @param {string} [onlySlug]
 * @returns {{ ok: string[], stale: string[], broken: string[], warnings: string[] }}
 */
export function checkPacks(onlySlug) {
  /** @type {{ ok: string[], stale: string[], broken: string[], warnings: string[] }} */
  const report = { ok: [], stale: [], broken: [], warnings: [] };
  const slugs = onlySlug ? [onlySlug] : [...ARTICLES_BY_SLUG.keys()];
  for (const slug of slugs) {
    const dir = path.join(PUBLIC, ...PACK_ROOT.split('/'), slug);
    if (!fs.existsSync(dir)) continue;
    const hash = articleSourceHash(englishHtml(slug));
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const id = `${slug}/${name}`;
      let pack;
      try {
        pack = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (err) {
        report.broken.push(`${id}: unparseable JSON (${err.message})`);
        continue;
      }
      const problems = verifyPack(slug, pack);
      if (problems.length) report.broken.push(`${id}: ${problems.join('; ')}`);
      else if (pack._meta?.sourceHash !== hash) report.stale.push(id);
      else {
        report.ok.push(id);
        const lang = name.slice(0, -'.json'.length);
        for (const w of packWarnings(slug, lang, pack)) report.warnings.push(`${id}: ${w}`);
      }
    }
  }
  return report;
}

// --- the hub -------------------------------------------------------------------------

/** The hub's English HTML. */
function hubHtml() {
  return fs.readFileSync(path.join(PUBLIC, ...BLOG_HUB.file.split('/')), 'utf8');
}

/**
 * Validate a candidate hub pack.
 *
 * A hub pack must carry a card for EVERY article, not just the ones this locale has
 * translated: which cards survive is decided per request by lib/i18n/blog-hub.js from the
 * manifest, so a pack missing a card would leave that card in English the day its article
 * is translated — a gap nobody would think to look for.
 * @param {Record<string, any>} pack
 * @returns {string[]}
 */
export function verifyHubPack(pack) {
  const slugs = LOCALIZED_ARTICLES.map((a) => a.slug);
  const problems = missingHubSlots(pack, slugs).map((p) => `missing or empty: ${p}`);
  const extra = Object.keys(pack.cards || {}).filter((slug) => !ARTICLES_BY_SLUG.has(slug));
  if (extra.length) problems.push(`cards for articles that do not exist: ${extra.join(', ')}`);
  // The hub's strings are plain text. Markup here would land raw in the grid via
  // data-lang (which escapes) or, worse, be silently visible as tags.
  for (const [slug, card] of Object.entries(pack.cards || {})) {
    for (const [field, value] of Object.entries(card)) {
      if (typeof value === 'string' && /<[a-z/]/i.test(value)) {
        problems.push(`cards.${slug}.${field} contains markup; hub strings are plain text`);
      }
    }
  }
  return problems;
}

/**
 * Write a verified hub pack.
 * @param {string} langToken
 * @param {Record<string, any>} translated
 * @returns {{ written: string }}
 */
export function addHubPack(langToken, translated) {
  const locale = localeOrDie(langToken);
  const pack = { ...translated };
  delete pack._meta;

  const problems = verifyHubPack(pack);
  if (problems.length) throw new Error(`hub/${locale.lang}: refused\n  - ${problems.join('\n  - ')}`);

  const out = {
    _meta: {
      sourceHash: hubSourceHash(hubHtml()),
      slug: null,
      lang: locale.lang,
      hreflang: locale.hreflang,
      translatedAt: new Date().toISOString().slice(0, 10),
      reviewed: false,
    },
    ...pack,
  };
  const file = path.join(PUBLIC, ...HUB_PACK_DIR.split('/'), `${locale.lang}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}
`);
  return { written: path.relative(ROOT, file) };
}

// --- CLI -----------------------------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === 'extract') {
    const [slug, out] = rest;
    if (!slug || !out) throw new Error('usage: extract <slug> <out.json>');
    // Written to a file rather than stdout on purpose: lib/config/runtime-flags.js is the
    // bootstrap layer that runs beneath the logger and legitimately prints to stdout as it
    // loads, so anything importing the app's modules cannot promise a clean pipe.
    const english = extractArticleStrings(englishHtml(slug));
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ slug, marketNote: US_SPECIFIC.has(slug), english }, null, 2)}\n`);
    process.stdout.write(`wrote ${out}\n`);
    return 0;
  }

  if (cmd === 'extract-hub') {
    const [out] = rest;
    if (!out) throw new Error('usage: extract-hub <out.json>');
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ hub: extractHubStrings(hubHtml()) }, null, 2)}
`);
    process.stdout.write(`wrote ${out}
`);
    return 0;
  }

  if (cmd === 'add-hub') {
    const [lang, file] = rest;
    if (!lang || !file) throw new Error('usage: add-hub <lang> <translated.json>');
    const { written } = addHubPack(lang, JSON.parse(fs.readFileSync(file, 'utf8')));
    process.stdout.write(`wrote ${written}
`);
    return 0;
  }

  if (cmd === 'add') {
    const [slug, lang, file] = rest;
    if (!slug || !lang || !file) throw new Error('usage: add <slug> <lang> <translated.json>');
    const translated = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { written } = addPack(slug, lang, translated);
    process.stdout.write(`wrote ${written}\n`);
    return 0;
  }

  if (cmd === 'check') {
    const report = checkPacks(rest[0]);
    for (const line of report.broken) process.stdout.write(`BROKEN  ${line}\n`);
    for (const line of report.stale) process.stdout.write(`STALE   ${line}\n`);
    // Warnings print but never change the exit code: they are judgement calls for a human,
    // not build breakers. See currencyWarnings() for why money cannot be a hard rule.
    for (const line of report.warnings) process.stdout.write(`WARN    ${line}\n`);
    process.stdout.write(
      `${report.ok.length} ok, ${report.stale.length} stale, ${report.broken.length} broken, `
      + `${report.warnings.length} warning(s)\n`,
    );
    return report.broken.length || report.stale.length ? 1 : 0;
  }

  process.stdout.write('usage: blog-pack.js extract <slug> <out.json> | add <slug> <lang> <file> | check [slug]\n');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
