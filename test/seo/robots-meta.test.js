// Drift guard for the `<meta name="robots">` directive across every served HTML page.
//
// Why this exists. The directive had drifted into SIX distinct strings: four indexable
// variants (bare `index, follow`; +max-image-preview; +max-snippet; +max-video-preview)
// and two noindex flavours. `public/ai-designer.html` carried TWO robots tags at once —
// a bare `index, follow` near the top and the rich one further down — which is undefined
// behaviour, and a crawler honouring the restrictive tag silently drops
// `max-image-preview:large`. That directive is what earns the large image thumbnail in
// mobile SERPs and Discover, which for an image-heavy staging product is the whole point.
//
// So this test pins three things a reviewer cannot eyeball across 32 files:
//   1. exactly ONE robots tag per page (never two);
//   2. every indexable page carries the SAME directive string, byte for byte;
//   3. the noindex set stays noindex, with its per-page follow/nofollow intact.
//
// Comments are stripped before scanning, so commented-out markup (and the note left in
// ai-designer.html explaining the removed duplicate) cannot produce a false hit — the
// same trap that made an earlier source-scan guard pass for the wrong reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/**
 * The single directive string every indexable page must carry. `max-image-preview:large`
 * is the load-bearing part; the two `-1`s lift Google's snippet/video-preview caps.
 * Changing this is a deliberate, site-wide decision — update it here and nowhere else.
 */
const INDEXABLE = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

/**
 * Pages deliberately kept out of the index, with the exact directive each must carry.
 * `follow` vs `nofollow` differs on purpose: 404 and the legal MSA still pass link
 * equity through to real pages, while the app/auth pages are dead ends.
 * Every entry here is also reflected in public/robots.txt.
 * @type {Record<string, string>}
 */
const NOINDEX = {
  '404.html': 'noindex, follow',
  'legal/enterprise-msa.html': 'noindex, follow',
  'admin.html': 'noindex, nofollow',
  'api-keys.html': 'noindex, nofollow',
  'gallery.html': 'noindex, nofollow',
  'getpro.html': 'noindex, nofollow',
  'listing-share.html': 'noindex, nofollow',
  'plus-welcome.html': 'noindex, nofollow',
  'reset-password.html': 'noindex, nofollow',
};

/**
 * Legacy redirect stubs. They carry NO robots tag on purpose: each is a meta-refresh
 * plus a `rel=canonical` that folds the old URL into its replacement, and robots.txt
 * deliberately leaves them crawlable so the canonical can actually be read. A noindex
 * here would stop the canonical being honoured, which is the opposite of the intent.
 * @type {string[]}
 */
const REDIRECT_STUBS = ['faq.html', 'pro.html'];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** Strip HTML comments so commented-out markup can't satisfy the scan. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Every robots directive on the page, in document order. Attribute order is not assumed:
 * a future edit writing `content=` before `name=` must still be seen, or the guard would
 * silently stop counting a tag it is meant to catch.
 * @param {string} html
 * @returns {string[]}
 */
function robotsDirectives(html) {
  const found = [];
  for (const tag of stripComments(html).match(/<meta\b[^>]*>/gi) || []) {
    if (!/\bname\s*=\s*["']robots["']/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    found.push(content ? content[1].trim() : '');
  }
  return found;
}

/** Every served HTML page, as a repo-relative POSIX path under public/. */
const PAGES = walk(PUBLIC).map((p) => path.relative(PUBLIC, p).split(path.sep).join('/')).sort();

test('the page inventory is non-empty and covers the known blog set', () => {
  // Cheap tripwire: if walk() silently returned nothing (a moved public/ dir, a bad
  // filter), every assertion below would vacuously pass.
  assert.ok(PAGES.length >= 30, `expected 30+ HTML pages, found ${PAGES.length}`);
  assert.ok(PAGES.includes('index.html'));
  assert.ok(PAGES.filter((p) => p.startsWith('blog/')).length >= 11);
});

test('no page carries more than one <meta name="robots"> tag', () => {
  for (const page of PAGES) {
    const directives = robotsDirectives(fs.readFileSync(path.join(PUBLIC, page), 'utf8'));
    assert.ok(
      directives.length <= 1,
      `${page} has ${directives.length} robots tags (${JSON.stringify(directives)}). `
        + 'Two robots tags on one page is undefined behaviour and the restrictive one may win. Keep exactly one.',
    );
  }
});

test('every indexable page carries the identical robots directive', () => {
  const indexable = PAGES.filter((p) => !(p in NOINDEX) && !REDIRECT_STUBS.includes(p));
  assert.ok(indexable.length >= 20, `expected 20+ indexable pages, found ${indexable.length}`);

  for (const page of indexable) {
    const directives = robotsDirectives(fs.readFileSync(path.join(PUBLIC, page), 'utf8'));
    assert.equal(
      directives.length, 1,
      `${page} is indexable but has ${directives.length} robots tags; expected exactly 1.`,
    );
    assert.equal(
      directives[0], INDEXABLE,
      `${page} has a drifted robots directive. Every indexable page must carry the identical string `
        + '— that is what keeps max-image-preview:large from being dropped on a subset of pages.',
    );
  }
});

test('the noindex set stays noindex, with follow/nofollow intact', () => {
  for (const [page, expected] of Object.entries(NOINDEX)) {
    assert.ok(PAGES.includes(page), `${page} is in the NOINDEX map but no longer exists — update the map.`);
    const directives = robotsDirectives(fs.readFileSync(path.join(PUBLIC, page), 'utf8'));
    assert.deepEqual(
      directives, [expected],
      `${page} must carry exactly "${expected}". This page is also Disallow-ed or noindex-ed by design; `
        + 'flipping it to indexable would expose an app/auth surface to search.',
    );
  }
});

test('legacy redirect stubs carry no robots tag and canonicalize to a real page', () => {
  for (const page of REDIRECT_STUBS) {
    assert.ok(PAGES.includes(page), `${page} is expected to exist as a redirect stub.`);
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    assert.deepEqual(
      robotsDirectives(html), [],
      `${page} must NOT carry a robots tag: a noindex would stop the crawler reading the rel=canonical `
        + 'that folds this retired URL into its replacement.',
    );

    const canonical = stripComments(html).match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
    assert.ok(canonical, `${page} must carry a rel=canonical — it is the only thing consolidating this URL.`);
    const href = canonical[0].match(/\bhref\s*=\s*["']([^"']*)["']/i);
    assert.ok(href, `${page} rel=canonical has no href.`);
    assert.ok(
      !href[1].includes('#'),
      `${page} canonical "${href[1]}" contains a fragment. Crawlers discard the fragment, so this `
        + 'resolves to the bare path — which was how faq.html ended up canonicalizing to /index.html, '
        + 'itself a non-canonical URL. Point it at the final canonical directly.',
    );
    assert.ok(
      !/\/index\.html$/.test(href[1]),
      `${page} canonical "${href[1]}" targets /index.html, which itself canonicalizes to the bare origin. `
        + 'That is a canonical chain — point straight at https://stagify.ai/.',
    );
  }
});
