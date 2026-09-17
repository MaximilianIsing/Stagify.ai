// Pull the translatable strings out of a blog article, and fingerprint them.
//
// Shared by scripts/translate-blog.js (which sends these strings to be translated and
// records the fingerprint in the pack it writes) and test/content/blog-packs.test.js
// (which recomputes the fingerprint and fails the build when a pack no longer describes
// the English article it was made from). Both MUST use this one implementation — a
// translation pipeline whose staleness check disagrees with its extractor is a pipeline
// that silently serves last month's article in ten languages.
//
// WHY THE HASH IS OVER THE EXTRACT, NOT THE FILE. Hashing the raw HTML would mark all ten
// packs of an article stale on any edit that never reaches a reader: a footer typo, a new
// analytics tag, or `node scripts/build-i18n-seo.js` rewriting the baked hreflang cluster
// — which it does every time a pack is ADDED, so hashing the file would make every pack
// invalidate its own siblings. The fingerprint covers exactly the strings a translator
// was given, so it moves when, and only when, a retranslation is actually owed.
//
// The parsing is regex over a known, hand-authored document shape rather than a DOM parse,
// matching lib/i18n/render-page.js — the renderer that consumes these keys works the same
// way, so an article the extractor can read is an article the renderer can translate.

import crypto from 'crypto';
import { findMatchingClose } from '../i18n/render-page.js';
import { stripHtmlComments } from '../http/text-assets.js';

/**
 * Inner HTML of the first element carrying `class="<className>"`.
 * Nesting-aware via the renderer's own close-tag scan, so `.article-body` resolves past
 * the `div.article-callout`s inside it.
 * @param {string} html
 * @param {string} className
 * @param {string} [tagName]  restrict to one tag when a class is reused across tags
 * @returns {string | null}
 */
function innerByClass(html, className, tagName = '[a-zA-Z][\\w-]*') {
  const open = new RegExp(`<(${tagName})\\b[^>]*\\bclass="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const close = findMatchingClose(html, start, m[1]);
  if (close === -1) return null;
  return html.slice(start, close);
}

/**
 * Inner HTML of the first `<tagName …>` element, ignoring classes.
 * @param {string} html
 * @param {string} tagName
 * @returns {string | null}
 */
function innerByTag(html, tagName) {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const close = findMatchingClose(html, start, tagName);
  if (close === -1) return null;
  return html.slice(start, close);
}

/**
 * The value of one attribute on the first tag matching `openTagRe`.
 * @param {string} html
 * @param {RegExp} openTagRe
 * @param {string} attr
 * @returns {string | null}
 */
function attrOf(html, openTagRe, attr) {
  const m = openTagRe.exec(html);
  if (!m) return null;
  const a = new RegExp(`\\s${attr}="([^"]*)"`, 'i').exec(m[0]);
  return a ? a[1] : null;
}

/** Collapse runs of whitespace and trim — for one-line strings, never for `body`. */
function tidy(s) {
  return s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim();
}

/** Trim a multi-line HTML fragment without disturbing the newlines inside it. */
function tidyBlock(s) {
  return s === null || s === undefined ? null : String(s).trim();
}

/**
 * The translatable slots of one article.
 *
 * `body` is the whole inner HTML of `.article-body` as a single fragment, because that is
 * how the renderer puts it back: one `data-lang-html` on that div replaces its entire
 * contents. Keeping the body whole is also what lets a translator move a clause across a
 * sentence boundary, which per-paragraph keys would forbid.
 *
 * `disclaimer` is optional — masking-studio-and-ai-designer has no `.article-disclaimer`.
 * Every other slot is required; a null means the article's markup drifted from the shape
 * the renderer and the extractor both assume, which is a build failure, not a fallback.
 *
 * @param {string} rawHtml  the English article file as authored
 * @returns {{meta: {title: string, description: string}, title: string, eyebrow: string,
 *   byline: string, crumb: string, figureAlt: string, body: string,
 *   cta: {title: string, body: string, link: string}, disclaimer?: string}}
 */
export function extractArticleStrings(rawHtml) {
  // CRLF is normalized FIRST, before anything reads the document, so a checkout on
  // Windows and one on Linux fingerprint the same article. Doing it per-slot instead let
  // the `body` fragment — the one slot that keeps its newlines — drift between the two.
  //
  // Comments go next, so a commented-out heading or a superseded CTA can never be picked
  // up as the live one. The renderer strips them too, just at the other end.
  const html = stripHtmlComments(String(rawHtml).replace(/\r\n/g, '\n'));

  const cta = innerByClass(html, 'article-cta', 'div');
  const crumbs = innerByClass(html, 'blog-crumbs', 'nav');

  /** @type {Record<string, any>} */
  const out = {
    meta: {
      title: tidy(innerByTag(html, 'title')),
      description: attrOf(html, /<meta\b[^>]*\bname="description"[^>]*>/i, 'content'),
    },
    title: tidy(innerByClass(html, 'article-title')),
    eyebrow: tidy(innerByClass(html, 'article-eyebrow')),
    // data-lang-html, not data-lang: the byline carries <strong>Stagify.ai</strong>.
    byline: tidy(innerByClass(html, 'article-meta', 'p')),
    // The trail's last crumb is bare text after the final separator, not an element.
    // Both spellings of the separator are accepted: the articles author it as a literal
    // '›' today, but the entity is the same character and an editor that swaps one for
    // the other must not silently turn the whole trail into the crumb.
    crumb: crumbs === null ? null : tidy((crumbs.split(/›|&rsaquo;/).pop() || '').replace(/<[^>]*>/g, '')),
    // Scoped to the cover figure: the FIRST <img> in the document is the topbar logo,
    // whose alt is chrome and already lives in the shared packs.
    figureAlt: attrOf(innerByClass(html, 'article-figure', 'figure') || '', /<img\b[^>]*>/i, 'alt'),
    body: tidyBlock(innerByClass(html, 'article-body', 'div')),
    cta:
      cta === null
        ? null
        : {
            title: tidy(innerByTag(cta, 'h2')),
            body: tidy(innerByTag(cta, 'p')),
            link: tidy(innerByTag(cta, 'a')),
          },
  };

  const disclaimer = innerByClass(html, 'article-disclaimer', 'p');
  if (disclaimer !== null) out.disclaimer = tidy(disclaimer);

  return /** @type {any} */ (out);
}

/**
 * Slots that must be present and non-empty on every article, as dotted paths.
 * `disclaimer` is deliberately absent — it is optional. @type {string[]}
 */
export const REQUIRED_SLOTS = [
  'meta.title',
  'meta.description',
  'title',
  'eyebrow',
  'byline',
  'crumb',
  'figureAlt',
  'body',
  'cta.title',
  'cta.body',
  'cta.link',
];

/**
 * The dotted paths that are missing or empty in an extract (or a translation pack).
 * @param {Record<string, any>} obj
 * @returns {string[]}
 */
export function missingSlots(obj) {
  return REQUIRED_SLOTS.filter((dotted) => {
    /** @type {any} */
    let cur = obj;
    for (const part of dotted.split('.')) {
      if (cur === null || typeof cur !== 'object') return true;
      cur = cur[part];
    }
    return typeof cur !== 'string' || cur.trim() === '';
  });
}

/** Stable JSON: keys sorted at every depth, so property order can't move the hash. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Fingerprint of an article's translatable content — what a pack records in
 * `_meta.sourceHash` and what the staleness test recomputes.
 * @param {string} rawHtml
 * @returns {string} 'sha256:<hex>'
 */
export function articleSourceHash(rawHtml) {
  const json = stableStringify(extractArticleStrings(rawHtml));
  return `sha256:${crypto.createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Body-shape checks. Used by scripts/translate-blog.js to refuse a bad translation
// before it reaches disk, and re-asserted by test/content/blog-packs.test.js so a pack
// hand-edited after the fact is caught too.
// ---------------------------------------------------------------------------

/** HTML elements with no closing tag, which must not be pushed onto the balance stack. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * The opening-tag names of a fragment, in document order.
 *
 * A translation must reproduce this sequence exactly. It is a stricter check than
 * "same number of paragraphs" and a much cheaper one than diffing trees: a model that
 * merges two `<p>`s, drops a `<li>`, or helpfully upgrades an `<h3>` to an `<h2>` changes
 * this array, and the whole class of structural drift is caught by one comparison.
 * @param {string} fragment
 * @returns {string[]}
 */
export function openTagSequence(fragment) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b[^>]*>/g;
  let m;
  while ((m = re.exec(String(fragment))) !== null) out.push(m[1].toLowerCase());
  return out;
}

/**
 * Every URL-bearing attribute value in a fragment, sorted.
 *
 * Compared as a multiset rather than a sequence so a translator may reorder list items,
 * but may not retarget, invent or drop a link. `src` is in here because one article
 * (curb-appeal-real-estate-photos) carries an inline `<figure>` inside its body, and a
 * translated image path would 404 as surely as a translated href.
 * @param {string} fragment
 * @returns {string[]}
 */
export function urlAttrValues(fragment) {
  const out = [];
  const re = /\s(?:href|src|srcset)="([^"]*)"/gi;
  let m;
  while ((m = re.exec(String(fragment))) !== null) out.push(m[1]);
  return out.sort();
}

/** Markup a translated body may never contain, whatever the target language. */
const FORBIDDEN = [
  { re: /<script\b/i, why: 'contains a <script> tag' },
  { re: /<iframe\b/i, why: 'contains an <iframe> tag' },
  { re: /<object\b/i, why: 'contains an <object> tag' },
  { re: /\son[a-z]+\s*=/i, why: 'contains an inline event handler (onclick=, onerror=, …)' },
  { re: /javascript:/i, why: 'contains a javascript: URL' },
];

/**
 * Are a fragment's tags balanced? A malformed body does more than render badly: it breaks
 * findMatchingClose for the element that ENCLOSES it, so one bad translation can swallow
 * the rest of the page.
 * @param {string} fragment
 * @returns {string | null} an error message, or null when balanced
 */
export function unbalancedTag(fragment) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(String(fragment))) !== null) {
    const [, closing, rawName, selfClosing] = m;
    const name = rawName.toLowerCase();
    if (VOID_TAGS.has(name) || selfClosing === '/') continue;
    if (closing === '/') {
      if (stack.length === 0) return `stray closing </${name}>`;
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open}>`;
    } else {
      stack.push(name);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

/**
 * Validate a translated body against the English one.
 *
 * `allowExtraCallout` is for the five US-specific articles, where the translation prompt
 * asks for exactly one added `div.article-callout` telling the reader the article
 * describes US practice. That is the ONLY element a translation may introduce, and it is
 * allowed only where it was asked for.
 *
 * @param {string} englishBody
 * @param {string} translatedBody
 * @param {{ allowExtraCallout?: boolean }} [opts]
 * @returns {string[]} problems; empty means the body is safe to write
 */
export function validateTranslatedBody(englishBody, translatedBody, { allowExtraCallout = false } = {}) {
  /** @type {string[]} */
  const problems = [];

  for (const { re, why } of FORBIDDEN) {
    if (re.test(translatedBody)) problems.push(why);
  }

  const imbalance = unbalancedTag(translatedBody);
  if (imbalance) problems.push(`markup is unbalanced: ${imbalance}`);

  const want = openTagSequence(englishBody);
  const got = openTagSequence(translatedBody);
  const expected = allowExtraCallout ? insertOneDiv(want, got) : want;
  if (got.join(',') !== expected.join(',')) {
    const at = got.findIndex((t, i) => t !== expected[i]);
    problems.push(
      `tag sequence differs from the English body (${expected.length} tags expected, ${got.length} found` +
        (at === -1 ? '' : `; first difference at position ${at}: expected <${expected[at] || 'nothing'}>, found <${got[at] || 'nothing'}>`) +
        ')',
    );
  }

  const wantUrls = urlAttrValues(englishBody).join('\n');
  const gotUrls = urlAttrValues(translatedBody).join('\n');
  if (wantUrls !== gotUrls) problems.push('href/src values differ from the English body — links must be copied verbatim');

  return problems;
}

/**
 * Money differences between an English body and its translation, as WARNINGS.
 *
 * Deliberately not a refusal, unlike everything in validateTranslatedBody above. A tag
 * sequence or an href set has exactly one correct translation, so a difference there is
 * always a defect. A price does not: "$4M" is legitimately "4 Mio. $", "4 millones de
 * dólares" or "400万ドル", and "$10,000" is "10,000美元" — all correct, none of them a
 * `$`-prefixed token. Refusing those would throw away ten good translations for writing
 * their own language properly, and loosening the rule until they all pass would leave it
 * catching nothing.
 *
 * So the plain amounts are normalized into US form on the way in (normalizeCurrency) and
 * anything still unmatched is reported here for a human to glance at. That is the honest
 * split: the machine fixes what is mechanical, and flags what needs judgement.
 *
 * @param {string} englishBody
 * @param {string} translatedBody
 * @returns {string[]} warnings; empty when every plain amount matched
 */
export function currencyWarnings(englishBody, translatedBody) {
  // Compared as SETS, not multisets. How many times a figure is repeated is a writing
  // choice: English states a price in a comparison table and again in the prose, and a
  // language that carries it once reads better for doing so. Counting those as defects
  // buried the real signal — a figure that vanished, or one that appeared from nowhere —
  // under a wall of noise nobody would read twice.
  const want = [...new Set(currencyAmounts(englishBody))].sort();
  const got = [...new Set(currencyAmounts(translatedBody))].sort();
  if (want.join('|') === got.join('|')) return [];

  const missing = want.filter((a) => !got.includes(a));
  const extra = got.filter((a) => !want.includes(a));
  if (missing.length === 0 && extra.length === 0) return [];
  return [
    'money: '
    + (missing.length ? `not found as written: ${missing.join(' ')}. ` : '')
    + (extra.length ? `present but not in the English: ${extra.join(' ')}. ` : '')
    + 'Usually a magnitude spelled out in words ($4M → "4 Mio.") or a symbol the language '
    + 'writes after the number in a form we do not recognize — check it reads correctly.',
  ];
}

/**
 * The English tag sequence with one `div` spliced in where the translation added one, so
 * the market-note callout can be allowed without also allowing a `<div>` anywhere else.
 * Returns the sequence unchanged when the difference is not exactly one added `div`,
 * which then fails the comparison with a useful message.
 * @param {string[]} want
 * @param {string[]} got
 * @returns {string[]}
 */
function insertOneDiv(want, got) {
  if (got.length !== want.length + 1) return want;
  const at = got.findIndex((t, i) => t !== want[i]);
  if (at === -1 || got[at] !== 'div') return want;
  const spliced = want.slice();
  spliced.splice(at, 0, 'div');
  return spliced;
}

// ---------------------------------------------------------------------------
// The blog hub (public/blog/index.html).
//
// Its cards carry copy written for the GRID — a card title and a one-sentence excerpt,
// not the article's <h1> and meta description — so they cannot be derived from the
// article packs and get their own keys, namespaced by slug. Namespaced by slug rather
// than by position because lib/i18n/blog-hub.js removes the cards of articles a locale
// has no translation for, and a positional key would silently shift every card after
// the gap onto the wrong copy.
// ---------------------------------------------------------------------------

/**
 * The translatable strings of the blog hub.
 * @param {string} rawHtml
 * @returns {{meta: {title: string, description: string}, hero: {title: string, body: string},
 *   cards: Record<string, {tag: string, title: string, excerpt: string, meta: string, alt: string}>}}
 */
export function extractHubStrings(rawHtml) {
  const html = stripHtmlComments(String(rawHtml).replace(/\r\n/g, '\n'));
  const hero = innerByClass(html, 'blog-hero', 'div') || '';

  /** @type {Record<string, any>} */
  const cards = {};
  const open = /<a class="blog-card" href="\/blog\/([a-z0-9-]+)"[^>]*>/g;
  let m;
  while ((m = open.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const close = findMatchingClose(html, start, 'a');
    if (close === -1) continue;
    const card = html.slice(start, close);
    cards[m[1]] = {
      tag: tidy(innerByClass(card, 'blog-card__tag')),
      title: tidy(innerByClass(card, 'blog-card__title')),
      excerpt: tidy(innerByClass(card, 'blog-card__excerpt')),
      meta: tidy(innerByClass(card, 'blog-card__meta')),
      alt: attrOf(card, /<img\b[^>]*>/i, 'alt'),
    };
    open.lastIndex = close;
  }

  return /** @type {any} */ ({
    meta: {
      title: tidy(innerByTag(html, 'title')),
      description: attrOf(html, /<meta\b[^>]*\bname="description"[^>]*>/i, 'content'),
    },
    hero: { title: tidy(innerByTag(hero, 'h1')), body: tidy(innerByTag(hero, 'p')) },
    cards,
  });
}

/**
 * Fingerprint of the hub's translatable content, for the same staleness check the
 * articles get: edit a card's excerpt and every hub pack goes stale until it is redone.
 * @param {string} rawHtml
 * @returns {string} 'sha256:<hex>'
 */
export function hubSourceHash(rawHtml) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(extractHubStrings(rawHtml)), 'utf8').digest('hex')}`;
}

/**
 * Dotted paths missing or empty in a hub extract or pack, given the slugs it should cover.
 * @param {Record<string, any>} obj
 * @param {string[]} slugs
 * @returns {string[]}
 */
export function missingHubSlots(obj, slugs) {
  const out = [];
  for (const p of ['meta.title', 'meta.description', 'hero.title', 'hero.body']) {
    let cur = /** @type {any} */ (obj);
    for (const part of p.split('.')) cur = cur === null || typeof cur !== 'object' ? undefined : cur[part];
    if (typeof cur !== 'string' || !cur.trim()) out.push(p);
  }
  for (const slug of slugs) {
    const card = obj?.cards?.[slug];
    if (!card) { out.push(`cards.${slug}`); continue; }
    for (const field of ['tag', 'title', 'excerpt', 'meta', 'alt']) {
      if (typeof card[field] !== 'string' || !card[field].trim()) out.push(`cards.${slug}.${field}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Currency.
//
// Every price in these articles is a US dollar amount describing the US market. Left to
// its own judgement a translator localizes the FORMAT — `1.500 $`, `1 500 $`, `$0,15` —
// which is the usual right instinct and the wrong one here: a localized separator makes a
// US figure read as a local price in a local currency, and `$0,15` reads as fifteen
// cents to some audiences and as a hundred and fifty dollars to others.
//
// So the amounts are normalized back to US form on the way in, and then checked: the
// multiset of amounts in a translation must equal the English's exactly. Normalizing
// without checking would let a genuinely changed number through; checking without
// normalizing would reject ten good translations over a comma.
// ---------------------------------------------------------------------------

/**
 * A money token: `$1,500`, `1.500 $`, `$0,15`, `1 500 $`, `425 000 $`.
 *
 * The digit grammar is explicit \u2014 one to three digits, then whole thousands groups, then
 * an optional one-or-two-digit decimal \u2014 rather than a loose run of digits and separators.
 * A loose run reads `$425,000, 40%` as the single amount `$42,500,040`, because the comma
 * and the space that separate the price from the next statistic are both inside the class.
 * That produced phantom amounts and false mismatches on perfectly good translations.
 */
const MONEY_DIGITS = '\\d{1,3}(?:[.,\\u00a0\\u202f ]\\d{3})*(?:[.,]\\d{1,2})?';
const CURRENCY_TOKEN = new RegExp(`\\$\\s?${MONEY_DIGITS}|${MONEY_DIGITS}\\s?\\$`, 'g');

/**
 * Rewrite one money token into US form: `$` in front, comma thousands, period decimal.
 *
 * The separator is read by the LENGTH of the group after it, which is what makes this
 * decidable: three digits is a thousands group (`1.500` → `$1,500`), one or two is a
 * decimal (`11,99` → `$11.99`). Any token this cannot read confidently is returned
 * unchanged and caught by the comparison instead.
 * @param {string} token
 * @returns {string}
 */
export function normalizeCurrencyToken(token) {
  const digits = token.replace(/\$/g, '').replace(/[\u00a0\u202f]/g, ' ').trim();
  if (!/^\d[\d., ]*$/.test(digits)) return token;

  // Split off a decimal tail: a separator followed by exactly one or two digits at the end.
  const decimal = /^(.*?)([.,])(\d{1,2})$/.exec(digits);
  const whole = (decimal ? decimal[1] : digits).replace(/[., ]/g, '');
  if (!/^\d+$/.test(whole)) return token;

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${grouped}${decimal ? `.${decimal[3]}` : ''}`;
}

/**
 * Connectors that join the two halves of a price RANGE, in the eleven languages this site
 * serves. English writes `$16–$23` with the symbol on both halves; most other languages
 * write `16–23 $` with one trailing symbol, and a few spell the connector as a word.
 *
 * This list exists because a single-symbol range is the one construction the token-by-token
 * pass gets actively WRONG rather than merely leaving alone: it would rewrite `16–23 $` to
 * `16–$23`, stranding the first number without a currency and changing what the sentence
 * says. Anything this list misses is caught by validateTranslatedBody comparing the amounts
 * against the English, so a gap here is a refused pack, never a wrong price.
 */
const RANGE_CONNECTOR = '(?:\\s*[–—~〜～−-]\\s*|\\s*(?:bis|to|a|à|au|und|et|y|e|of|tot|hasta|fino a|до|или|から|まで|까지|到|至)\\s*)';
const CURRENCY_RANGE = new RegExp(
  `(${MONEY_DIGITS})(${RANGE_CONNECTOR})(${MONEY_DIGITS})\\s?\\$`,
  'gi',
);

/**
 * Normalize every money amount in a fragment to US form, leaving all other text alone.
 *
 * Ranges are handled first, because they are the case where the naive pass does damage
 * rather than nothing — see RANGE_CONNECTOR.
 * @param {string} fragment
 * @returns {string}
 */
export function normalizeCurrency(fragment) {
  return String(fragment)
    .replace(CURRENCY_RANGE, (_all, lo, sep, hi) =>
      `${normalizeCurrencyToken(`$${lo}`)}${sep}${normalizeCurrencyToken(`$${hi}`)}`)
    .replace(CURRENCY_TOKEN, (t) => normalizeCurrencyToken(t));
}

/**
 * The money amounts in a fragment, normalized and sorted — compared as a multiset so a
 * translation may reorder a sentence but may not change, drop or invent a price.
 * @param {string} fragment
 * @returns {string[]}
 */
export function currencyAmounts(fragment) {
  const text = String(fragment);
  /** @type {string[]} */
  const out = [];
  CURRENCY_TOKEN.lastIndex = 0;
  let m;
  while ((m = CURRENCY_TOKEN.exec(text)) !== null) {
    // Skip magnitude-suffixed amounts — `$4M`, `$2M`. The NUMBER is a price, but the
    // magnitude is a word, and every language writes it differently: "4 Mio.",
    // "4 millones", "400万". Comparing those as amounts would fail ten good translations
    // for saying "four million dollars" correctly. Plain amounts, which is nearly all of
    // them, are still compared exactly.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (/[A-Za-z一-鿿]/.test(after)) continue;
    out.push(normalizeCurrencyToken(m[0]));
  }
  return out.sort();
}
