// Drift guards for pages that are deliberately NOT localized — terms.html and
// privacy.html today, whatever else leaves LOCALIZED_PAGES tomorrow.
//
// The trap these exist to catch: scripts/build-i18n-seo.js bakes the hreflang cluster
// into the English pages by iterating LOCALIZED_PAGES. The moment a page leaves that
// array the build script stops visiting it — so the cluster already committed to the
// file is FROZEN there, advertising /de/terms.html and friends to Google forever,
// while the routes that used to serve those URLs are gone. Re-running the build fixes
// nothing, because the build cannot see the page any more. Nothing else in the suite
// looks at a page the config no longer mentions, so without this file the stale
// cluster ships green.
//
// See the LOCALIZED_PAGES comment in lib/i18n/locales.js for why the legal pages are
// English-only rather than translated.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.js';
import { LOCALES, LOCALIZED_PAGES } from '../../lib/i18n/locales.js';
import { buildSitemap } from '../../lib/i18n/sitemap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', '..', 'public');

/** The English paths routes/i18n.js 301s back from every locale prefix. */
const RETIRED = ['/terms.html', '/privacy.html'];

/** Every .html file under public/, as a path relative to public/ with / separators. */
function everyHtmlFile(dir = PUBLIC, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...everyHtmlFile(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

test('a page outside LOCALIZED_PAGES carries no hreflang alternates', () => {
  // Keyed on `file` (what the build script writes to), not `path` — a page can be
  // served at a clean URL that differs from its filename (status.html → /status).
  const localizedFiles = new Set(LOCALIZED_PAGES.map((p) => p.file.replace(/\\/g, '/')));
  const offenders = [];

  for (const file of everyHtmlFile()) {
    if (localizedFiles.has(file)) continue;
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    const alternates = html.match(/<link\s+rel="alternate"\s+hreflang="[^"]*"[^>]*>/gi) || [];
    if (alternates.length) offenders.push(`${file} (${alternates.length})`);
  }

  assert.deepEqual(offenders, [],
    'these pages are not in LOCALIZED_PAGES but still advertise localized variants. '
    + 'scripts/build-i18n-seo.js only visits pages IN that array, so it can neither have '
    + 'written these nor strip them — delete the <link rel="alternate" hreflang=…> lines '
    + 'by hand, keeping the self-referential canonical');
});

test('the retired legal pages are in the sitemap exactly once, with no localized variants', () => {
  const map = buildSitemap();

  for (const retired of RETIRED) {
    const locs = (map.match(new RegExp(`<loc>[^<]*${retired}</loc>`, 'g')) || []);
    assert.equal(locs.length, 1,
      `${retired} should appear as exactly one English <loc> — it is English-only, but it `
      + 'must not vanish from the sitemap either (that is what ENGLISH_ONLY_ENTRIES in '
      + 'lib/i18n/sitemap.js is for)');
    assert.equal(locs[0], `<loc>https://stagify.ai${retired}</loc>`, `${retired}: not the English URL`);
  }

  // The 22 URLs the de-localization removed must be gone from every form the sitemap
  // uses — <loc> AND the <xhtml:link> alternate annotations on other pages' entries.
  const prefixes = LOCALES.map((l) => l.prefix).join('|');
  const stale = map.match(new RegExp(`/(${prefixes})(${RETIRED.join('|').replace(/\./g, '\\.')})`, 'g')) || [];
  assert.deepEqual(stale, [], 'sitemap still lists localized URLs for a de-localized page');
});

// ── Live routes ─────────────────────────────────────────────────────────────

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());
const get = (p, opts) => fetch(`${server.baseUrl}${p}`, opts);

test('every retired localized URL 301s to its English page', async () => {
  // Every locale, not a sampled one: the redirects are emitted in a loop over LOCALES,
  // and a loop that silently covers nine of ten is exactly what a spot-check misses.
  for (const locale of LOCALES) {
    for (const retired of RETIRED) {
      const res = await get(`/${locale.prefix}${retired}`, { redirect: 'manual' });
      assert.equal(res.status, 301, `/${locale.prefix}${retired} should 301, not ${res.status}`);
      assert.equal(res.headers.get('location'), retired, `/${locale.prefix}${retired} redirects to the wrong place`);
    }
  }
});

test('the English legal pages still serve, without advertising localized variants', async () => {
  for (const retired of RETIRED) {
    const res = await get(retired);
    assert.equal(res.status, 200, `${retired} should still be served`);
    const html = await res.text();
    assert.ok(html.includes(`<link rel="canonical" href="https://stagify.ai${retired}">`),
      `${retired}: the self-referential canonical must survive de-localization`);
    assert.ok(!/rel="alternate"\s+hreflang/i.test(html), `${retired}: still advertises hreflang alternates`);
  }
});

test('the ToS grants the user a license to use the Service', () => {
  // Section 9 asserts what Stagify owns; without a matching grant the contract never
  // actually gives the user the right to use the thing they are paying for. This is
  // the clause a EULA would otherwise have carried — the product ships no software,
  // so it belongs here or nowhere.
  const terms = fs.readFileSync(path.join(PUBLIC, 'terms.html'), 'utf8');
  assert.match(terms, /2\.5 Your right to use the Service/,
    'the §2.5 license grant is gone from terms.html');
  assert.match(terms, /non-exclusive, non-transferable, non-sublicensable right to access and use the Service/,
    '§2.5 no longer states the scope of the grant');
  assert.match(terms, /limited to the license granted in Section 2\.5/,
    '§9 no longer points at the grant in §2.5 — the IP section reads as ownership with no counterpart');
});
