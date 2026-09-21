// Tests for public/llms.txt — the plain-text site summary an answer engine reads first.
//
// Two jobs here. The first is the ordinary generated-artefact drift gate: the committed
// file must equal what lib/seo/llms-txt.js produces, so a forgotten `node
// scripts/build-i18n-seo.js` fails the deploy instead of shipping a stale summary.
//
// The second is the one that matters more. A handful of figures in that file — the
// Stagify+ price, the trial length, the Enterprise per-generation rate, the free daily cap
// — have no constant anywhere in the codebase to import; they live in page markup and in
// translation packs. They are therefore literals in lib/seo/llms-txt.js, and these tests
// are what stops them becoming lies: each one is read back out of its real home and
// compared. Change a price on the pricing page and this file tells you the summary an
// assistant quotes still says the old one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOG_HUB, LOCALIZED_ARTICLES, LOCALIZED_PAGES, SITE_ORIGIN } from '../../lib/i18n/locales.js';
import { CREDIT_PACKS } from '../../lib/data/credit-packs.js';
import { SAME_AS } from '../../lib/seo/organization.js';
import { buildLlmsTxt } from '../../lib/seo/llms-txt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const committed = () => fs.readFileSync(path.join(PUBLIC, 'llms.txt'), 'utf8').replace(/\r\n/g, '\n');
const source = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/**
 * The committed file with every run of whitespace flattened to one space. The generator
 * folds prose at 92 columns, so a phrase like "$0.15 a generation" is regularly split
 * across two lines — searching the raw text for it finds nothing and reports the price
 * missing when it is merely wrapped.
 */
const flat = () => committed().replace(/\s+/g, ' ');

test('committed llms.txt matches the generator (rebuild if this fails)', () => {
  assert.equal(committed(), buildLlmsTxt(PUBLIC), 'llms.txt is stale — run: node scripts/build-i18n-seo.js');
});

test('every indexable URL the sitemap carries is also named in llms.txt', () => {
  // The point of generating this file is that the two never disagree about what the site
  // consists of. An article an assistant cannot find is one it answers about from a
  // competitor's page instead.
  const txt = flat();
  for (const page of LOCALIZED_PAGES) {
    assert.ok(txt.includes(`${SITE_ORIGIN}${page.path}`), `llms.txt does not link ${page.path}`);
  }
  for (const article of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    assert.ok(txt.includes(`${SITE_ORIGIN}${article.path}`), `llms.txt does not link ${article.path}`);
  }
  for (const extra of ['/privacy.html', '/terms.html', '/legal/subprocessors.html', '/.well-known/security.txt', '/brand']) {
    assert.ok(txt.includes(`${SITE_ORIGIN}${extra}`), `llms.txt does not link ${extra}`);
  }
});

test('llms.txt describes every /api/v1 endpoint that exists', () => {
  // Read out of the router rather than a list kept here, so a new endpoint fails this
  // test until someone has written the sentence that says what it does.
  const routes = source('routes', 'api-v1.js');
  const declared = new Set(
    [...routes.matchAll(/router\.(get|post)\(\s*'(\/api\/v1\/[^']*)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`),
  );
  assert.ok(declared.size >= 5, 'found no /api/v1 routes — did the router move?');
  const txt = flat();
  for (const route of declared) {
    assert.ok(txt.includes(route), `llms.txt does not document ${route}`);
  }
});

test('llms.txt quotes the credit packs that are actually sold', () => {
  const txt = flat();
  for (const pack of CREDIT_PACKS) {
    const line = `${pack.credits} credits $${(pack.amountCents / 100).toFixed(2)}`;
    assert.ok(txt.includes(line), `llms.txt does not quote the ${pack.id} pack as "${line}"`);
  }
});

test('llms.txt quotes the Stagify+ price the pricing page offers', () => {
  // The JSON-LD Offer on stagify-plus.html is the machine-readable price a crawler reads;
  // llms.txt is the other one. They are the same claim in two files.
  const html = source('public', 'stagify-plus.html');
  const offer = html.match(/"price"\s*:\s*"?([0-9]+\.[0-9]{2})"?/);
  assert.ok(offer, 'no JSON-LD offer price found in stagify-plus.html');
  assert.ok(
    flat().includes(`$${offer[1]} a month`),
    `llms.txt does not quote the $${offer[1]} price stagify-plus.html offers`,
  );
});

test('llms.txt quotes the Enterprise per-generation rate the Enterprise page does', () => {
  const html = source('public', 'enterprise.html');
  assert.ok(/0\.15/.test(html), 'enterprise.html no longer says 0.15 — update lib/seo/llms-txt.js');
  assert.ok(flat().includes('$0.15 a generation'), 'llms.txt does not quote the Enterprise rate');
});

test('llms.txt quotes the free plan cap the server actually enforces', () => {
  // FREE_DAILY_LIMIT is module-private in the auth store (it is exposed only on the store
  // instance), so it is read out of the source rather than imported — opening the store
  // here would open the SQLite database for a string comparison.
  const store = source('lib', 'data', 'auth-store.js');
  const limit = store.match(/const FREE_DAILY_LIMIT = (\d+);/);
  assert.ok(limit, 'FREE_DAILY_LIMIT not found in lib/data/auth-store.js');
  assert.ok(
    flat().includes(`${limit[1]} generations a day`),
    `llms.txt does not quote the ${limit[1]}/day free cap the server enforces`,
  );
});

test('every indexable page carries the llms.txt pointer', () => {
  // The file is only useful if it can be found from a page. identityPages() in the build
  // script decides the set; these are the two ends of it that matter most.
  for (const file of ['index.html', 'about.html', BLOG_HUB.file, LOCALIZED_ARTICLES[0].file]) {
    const html = fs.readFileSync(path.join(PUBLIC, ...file.split('/')), 'utf8');
    assert.ok(
      html.includes(`<link rel="alternate" type="text/plain" title="llms.txt" href="${SITE_ORIGIN}/llms.txt">`),
      `${file} is missing the llms.txt pointer — run: node scripts/build-i18n-seo.js`,
    );
  }
});

test('robots.txt points at llms.txt as well as the sitemap', () => {
  const robots = source('public', 'robots.txt');
  assert.ok(robots.includes(`${SITE_ORIGIN}/llms.txt`), 'robots.txt does not name llms.txt');
  assert.ok(robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`), 'robots.txt lost its Sitemap directive');
});

test('llms.txt still carries every owned profile', () => {
  // Overlaps test/seo/organization-jsonld.test.js deliberately: that one guards the
  // identity claims, this one guards them surviving the move to a generated file.
  const txt = flat();
  for (const url of SAME_AS) {
    assert.ok(txt.includes(url), `llms.txt is missing the profile ${url}`);
  }
});
