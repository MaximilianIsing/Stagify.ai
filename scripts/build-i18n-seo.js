// Build step for the localized-URL SEO layer. Run after changing lib/i18n/locales.js
// (the language or page set) or a page's canonical:
//
//   node scripts/build-i18n-seo.js
//
// It does six things, all derived from config modules so they can't drift:
//   0. Regenerates lib/i18n/blog-i18n-manifest.js from the translation packs on disk
//      under public/blog/i18n/ — which blog article exists in which language. Steps 3
//      and 4 read it, so when it changes the script re-execs itself once (see below).
//   1. Bakes the full hreflang cluster into every indexable ENGLISH page (the
//      localized pages get theirs at render time; English pages are static files).
//   2. Bakes the English og:locale + og:locale:alternate block into the same pages,
//      for the ones that carry an Open Graph card at all (anchored to og:url).
//   3. Regenerates public/sitemap.xml with a <url> per language + xhtml alternates.
//   4. Regenerates public/scripts/locale-data.js — the browser's copy of the
//      language set, which the frontend cannot import from lib/ directly.
//   5. Bakes the canonical Organization (and, on the homepage, WebSite) JSON-LD from
//      lib/seo/organization.js into every indexable page, between generated markers.
//      That block is the site's entity identity — see that module for why four
//      unrelated "Stagify" products make it load-bearing rather than decorative.
//
// Idempotent: re-running removes the previously-injected cluster and rewrites it,
// so it's safe to run any time. A test (test/i18n/i18n.test.js) asserts the committed
// sitemap and the English hreflang blocks match this output, so CI catches a
// forgotten rebuild.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BLOG_HUB, ENGLISH, LOCALIZED_ARTICLES, LOCALIZED_PAGES, buildHreflangCluster, buildOgLocaleBlock } from '../lib/i18n/locales.js';
import { buildSitemap } from '../lib/i18n/sitemap.js';
import { buildLocaleDataModule } from '../lib/i18n/locale-data.js';
import { articleLocales, buildBlogManifestModule } from '../lib/i18n/blog-packs.js';
import { ORGANIZATION_ID, renderOrganizationBlock } from '../lib/seo/organization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

// Full-line removals (CRLF- or LF-aware): drop the stale "single URL … hreflang"
// comment and any existing alternate links along with their whole line and any
// blank lines that follow, so refreshing never leaves orphaned blank lines behind.
const STALE_HREFLANG_COMMENT = /[ \t]*<!--(?:(?!-->)[\s\S])*?hreflang(?:(?!-->)[\s\S])*?-->[ \t]*\r?\n(?:[ \t]*\r?\n)*/gi;
const EXISTING_ALTERNATE = /[ \t]*<link\s+rel="alternate"\s+hreflang="[^"]*"[^>]*>[ \t]*\r?\n(?:[ \t]*\r?\n)*/gi;

/**
 * Inject (or refresh) the hreflang cluster in one English page, right after its
 * canonical <link>. Idempotent, and preserves the file's line ending. Returns the
 * new HTML.
 * @param {string} html
 * @param {string} pagePath
 * @param {import('../lib/i18n/locales.js').Locale[]} [locales]  the variants that exist;
 *   defaults to all eleven, which is right for every LOCALIZED_PAGES entry. Blog articles
 *   pass their own subset through injectArticleHreflang below.
 */
export function injectHreflang(html, pagePath, locales) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const out = html.replace(STALE_HREFLANG_COMMENT, '').replace(EXISTING_ALTERNATE, '');
  const cluster = buildHreflangCluster(pagePath, '    ', locales).split('\n').join(eol);
  return out.replace(/([ \t]*<link\s+rel="canonical"[^>]*>)/i, (m) => `${m}${eol}${cluster}`);
}

// Existing og:locale / og:locale:alternate lines, removed whole-line so a refresh
// leaves no ragged indentation. Deliberately does NOT swallow following blank lines
// (unlike EXISTING_ALTERNATE): the og block sits inside a hand-authored Open Graph
// section whose blank-line separator before the Twitter card block is worth keeping.
const EXISTING_OG_LOCALE = /[ \t]*<meta\s+property="og:locale(?::alternate)?"\s+content="[^"]*"[^>]*>[ \t]*\r?\n/gi;

/**
 * Inject (or refresh) the ENGLISH og:locale block in one page, right after its
 * <meta property="og:url">. Idempotent, and preserves the file's line ending.
 *
 * Anchored to og:url rather than the canonical because this block only means
 * anything as part of an Open Graph card: a page with no og:* card at all (privacy,
 * terms) is left untouched, since a lone og:locale on a card-less page tells
 * Facebook nothing. Returns the new HTML, unchanged when there is no anchor.
 * @param {string} html
 * @param {import('../lib/i18n/locales.js').Locale[]} [locales]  the variants that exist
 */
export function injectOgLocale(html, locales) {
  if (!/<meta\s+property="og:url"/i.test(html)) return html;
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const out = html.replace(EXISTING_OG_LOCALE, '');
  return out.replace(
    /([ \t]*)<meta\s+property="og:url"\s+content="[^"]*"[^>]*>/i,
    (m, indent) => `${m}${eol}${buildOgLocaleBlock(ENGLISH, indent, locales).split('\n').join(eol)}`,
  );
}

/**
 * Bake the hreflang cluster and og:locale block into one English BLOG page, over only the
 * locales that have a translation pack for it.
 *
 * Split from the LOCALIZED_PAGES loop rather than folded into it because the two differ in
 * the one way that matters: a marketing page is translated into all eleven languages or it
 * is not in the set, so its cluster is a constant. An article's is a function of which
 * packs exist, so it changes whenever one lands — which is why `node
 * scripts/build-i18n-seo.js` has to be rerun after translating, and why
 * test/i18n/blog-i18n.test.js compares every baked cluster against the manifest.
 *
 * An article with no packs gets a one-locale cluster: itself, plus x-default. That is a
 * complete and correct cluster, not a degenerate one — it says "this page exists in
 * English", which is true.
 *
 * @param {string} html
 * @param {string} pagePath
 * @param {import('../lib/i18n/locales.js').Locale[]} locales
 * @returns {string}
 */
export function injectArticleHreflang(html, pagePath, locales) {
  return injectOgLocale(injectHreflang(html, pagePath, locales), locales);
}

// The previously-generated identity region, removed whole so a refresh never nests one
// inside another. Non-greedy to the FIRST end marker, because index.html carries the
// region once and a greedy match would swallow the FAQ block that follows it.
const EXISTING_ORGANIZATION = /[ \t]*<!-- BEGIN ORGANIZATION JSON-LD[\s\S]*?<!-- END ORGANIZATION JSON-LD -->[ \t]*\r?\n?/g;

/** Any JSON-LD script element, used to find where a page's structured data already sits. */
const LD_JSON_BLOCK = /[ \t]*<script type="application\/ld\+json"[\s\S]*?<\/script>/g;

/**
 * Inject (or refresh) the canonical Organization block in one page. Idempotent, and
 * preserves the file's line ending.
 *
 * Placed after the page's LAST existing JSON-LD block rather than at a fixed spot in
 * <head>, for two reasons. index.html keeps its structured data at the end of <body> on
 * purpose (~19 KB that used to sit between the stylesheets and the hero markup, delaying
 * the LCP element), while every other page keeps it in <head> — one hard-coded anchor
 * would be wrong on one of the two. And landing it beside the existing blocks keeps a
 * page's structured data in one place to read.
 *
 * A page with no JSON-LD at all falls back to just before </head>.
 * @param {string} html
 * @param {{ press?: boolean, website?: boolean }} [opts]
 * @returns {string}
 */
export function injectOrganization(html, opts = {}) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const out = html.replace(EXISTING_ORGANIZATION, '');

  const blocks = [...out.matchAll(LD_JSON_BLOCK)];
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    // `/^[ \t]*/` cannot fail to match, but it is typed as nullable; default rather than
    // assert, so a future edit to the pattern degrades to the standard indent.
    const indent = (/^[ \t]*/.exec(last[0]) || ['    '])[0];
    const block = renderOrganizationBlock({ ...opts, indent }).split('\n').join(eol);
    const at = (last.index ?? 0) + last[0].length;
    return `${out.slice(0, at)}${eol}${block}${out.slice(at)}`;
  }

  const block = renderOrganizationBlock({ ...opts, indent: '    ' }).split('\n').join(eol);
  return out.replace(/([ \t]*<\/head>)/i, (m) => `${block}${eol}${m}`);
}

/**
 * Every indexable page that carries the identity block: the localized marketing set, the
 * two English-only legal pages, and the whole blog.
 *
 * The blog is in deliberately, and is the reason this list is not just LOCALIZED_PAGES.
 * Articles are the most-scraped surface on the site — they are what an assistant actually
 * lands on when it is researching virtual staging — so a reader arriving there with no
 * idea which Stagify wrote it is the exact confusion this whole change exists to fix.
 *
 * Noindex pages (admin, gallery, reset-password, getpro, plus-welcome, the MSA) are out:
 * no crawler sees them, so the bytes would be pure weight.
 * @returns {{ file: string, press?: boolean, website?: boolean }[]}
 */
export function identityPages() {
  return [
    // The homepage is the entity's home: it gets the press corroboration and the one
    // WebSite node. /about gets the press too — it is the page that argues the identity.
    ...LOCALIZED_PAGES.map((p) => ({
      file: p.file,
      press: p.file === 'index.html' || p.file === 'about.html',
      website: p.file === 'index.html',
    })),
    { file: 'privacy.html' },
    { file: 'terms.html' },
    { file: BLOG_HUB.file },
    ...LOCALIZED_ARTICLES.map((a) => ({ file: a.file })),
  ];
}

/**
 * Point a blog post's anonymous author/publisher Organizations at the canonical @id.
 *
 * Every article declares `{"@type": "Organization", "name": "Stagify.ai"}` inline with no
 * id, so a crawler sees a fresh nameless company per article instead of fifteen articles
 * published by one entity — the identity block above would sit on the same page as a
 * duplicate of itself. Adding the id merges them. Idempotent: an object that already
 * carries an @id is left alone.
 * @param {string} html
 * @returns {string}
 */
export function linkBlogPublisher(html) {
  return html.replace(
    /\{\s*"@type": "Organization",\s*"name": "Stagify\.ai"/g,
    (m) => m.replace('"@type": "Organization",', `"@type": "Organization", "@id": "${ORGANIZATION_ID}",`),
  );
}

/**
 * Rewrite lib/i18n/blog-i18n-manifest.js from the packs on disk.
 *
 * Returns true when the file CHANGED, which is a problem the rest of this run cannot
 * solve: ESM evaluates every import before run() is called, so buildSitemap() is already
 * holding the old manifest in memory. Rather than thread a manifest argument through
 * three pure functions to work around a once-per-translation event, the caller re-execs
 * the script, and the second pass sees the new file as an ordinary import.
 * @returns {boolean} whether the manifest on disk changed
 */
function regenerateBlogManifest() {
  const file = path.join(__dirname, '..', 'lib', 'i18n', 'blog-i18n-manifest.js');
  const prior = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = prior.includes('\r\n') ? '\r\n' : '\n';
  const next = buildBlogManifestModule(PUBLIC).split('\n').join(eol);
  if (next === prior) return false;
  fs.writeFileSync(file, next);
  console.log('lib/i18n/blog-i18n-manifest.js regenerated');
  return true;
}

function run() {
  let changed = 0;
  const noOgCard = [];
  for (const page of LOCALIZED_PAGES) {
    const file = path.join(PUBLIC, page.file);
    const before = fs.readFileSync(file, 'utf8');
    if (!/<link\s+rel="canonical"/i.test(before)) {
      throw new Error(`${page.file}: no <link rel="canonical"> to anchor hreflang to`);
    }
    if (!/<meta\s+property="og:url"/i.test(before)) noOgCard.push(page.file);
    const after = injectOgLocale(injectHreflang(before, page.path));
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed += 1;
      console.log(`seo head → ${page.file}`);
    }
  }
  // Say what was skipped rather than quietly covering 9 of 11 — a page that grows an
  // Open Graph card later should start getting the block on the next rebuild, and
  // this line is what makes that visible.
  if (noOgCard.length) {
    console.log(`og:locale skipped (no og:url card): ${noOgCard.join(', ')}`);
  }

  // The blog, over the subset of locales each article has been translated into.
  let blogChanged = 0;
  for (const article of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    const file = path.join(PUBLIC, ...article.file.split('/'));
    const before = fs.readFileSync(file, 'utf8');
    if (!/<link\s+rel="canonical"/i.test(before)) {
      throw new Error(`${article.file}: no <link rel="canonical"> to anchor hreflang to`);
    }
    const after = injectArticleHreflang(before, article.path, articleLocales(article.slug));
    if (after !== before) {
      fs.writeFileSync(file, after);
      blogChanged += 1;
      console.log(`seo head → ${article.file}`);
    }
  }

  const sitemap = buildSitemap();
  fs.writeFileSync(path.join(PUBLIC, 'sitemap.xml'), sitemap);
  console.log(`sitemap.xml regenerated (${(sitemap.match(/<loc>/g) || []).length} URLs)`);

  // Match the existing file's line endings, like the hreflang injector above: on a
  // CRLF checkout an unconditional LF write would show up as a whole-file diff on
  // every rebuild, with no content change behind it.
  const localeDataPath = path.join(PUBLIC, 'scripts', 'locale-data.js');
  const priorLocaleData = fs.existsSync(localeDataPath) ? fs.readFileSync(localeDataPath, 'utf8') : '';
  const localeDataEol = priorLocaleData.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(localeDataPath, buildLocaleDataModule().split('\n').join(localeDataEol));
  console.log('scripts/locale-data.js regenerated');

  // Step 5 — the entity identity. Separate loop from the hreflang pass above because it
  // covers a WIDER set of files (the blog and the legal pages are not in LOCALIZED_PAGES)
  // and because a page missing a canonical is a hard error there but irrelevant here.
  let identity = 0;
  for (const page of identityPages()) {
    const file = path.join(PUBLIC, page.file);
    const before = fs.readFileSync(file, 'utf8');
    const after = injectOrganization(linkBlogPublisher(before), page);
    if (after !== before) {
      fs.writeFileSync(file, after);
      identity += 1;
      console.log(`organization json-ld → ${page.file}`);
    }
  }

  console.log(`Done. ${changed} English page(s) + ${blogChanged} blog page(s) updated, ${identity} identity block(s) written.`);
}

// Only build when run directly (`node scripts/build-i18n-seo.js`), so importing
// injectHreflang for tests has no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The manifest feeds the sitemap and the blog pages' hreflang clusters, but ESM has
  // already imported the old copy by the time we get here. When it moves, hand the rest
  // of the build to a fresh process that imports the new one. RELOADED guards the loop:
  // the second pass writes the same bytes, so it never re-execs again.
  if (!process.env.STAGIFY_I18N_MANIFEST_RELOADED && regenerateBlogManifest()) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: { ...process.env, STAGIFY_I18N_MANIFEST_RELOADED: '1' },
    });
    process.exit(res.status === null ? 1 : res.status);
  }
  run();
}
