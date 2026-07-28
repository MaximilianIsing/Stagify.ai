// Build step for the localized-URL SEO layer. Run after changing lib/i18n/locales.js
// (the language or page set) or a page's canonical:
//
//   node scripts/build-i18n-seo.js
//
// It does three things, all derived from lib/i18n/locales.js so they can't drift:
//   1. Bakes the full hreflang cluster into every indexable ENGLISH page (the
//      localized pages get theirs at render time; English pages are static files).
//   2. Regenerates public/sitemap.xml with a <url> per language + xhtml alternates.
//   3. Regenerates public/scripts/locale-data.js — the browser's copy of the
//      language set, which the frontend cannot import from lib/ directly.
//
// Idempotent: re-running removes the previously-injected cluster and rewrites it,
// so it's safe to run any time. A test (test/i18n/i18n.test.js) asserts the committed
// sitemap and the English hreflang blocks match this output, so CI catches a
// forgotten rebuild.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALIZED_PAGES, buildHreflangCluster } from '../lib/i18n/locales.js';
import { buildSitemap } from '../lib/i18n/sitemap.js';
import { buildLocaleDataModule } from '../lib/i18n/locale-data.js';

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
 */
export function injectHreflang(html, pagePath) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const out = html.replace(STALE_HREFLANG_COMMENT, '').replace(EXISTING_ALTERNATE, '');
  const cluster = buildHreflangCluster(pagePath).split('\n').join(eol);
  return out.replace(/([ \t]*<link\s+rel="canonical"[^>]*>)/i, (m) => `${m}${eol}${cluster}`);
}

function run() {
  let changed = 0;
  for (const page of LOCALIZED_PAGES) {
    const file = path.join(PUBLIC, page.file);
    const before = fs.readFileSync(file, 'utf8');
    if (!/<link\s+rel="canonical"/i.test(before)) {
      throw new Error(`${page.file}: no <link rel="canonical"> to anchor hreflang to`);
    }
    const after = injectHreflang(before, page.path);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed += 1;
      console.log(`hreflang → ${page.file}`);
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

  console.log(`Done. ${changed} English page(s) updated.`);
}

// Only build when run directly (`node scripts/build-i18n-seo.js`), so importing
// injectHreflang for tests has no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
