// A page's visible breadcrumb trail and its BreadcrumbList JSON-LD must say the same
// thing.
//
// Google's breadcrumb guidance is that the structured data reflects the trail actually
// on the page; a trail that disagrees is at best ignored and at worst read as markup
// describing content the visitor cannot see. Every article shipped disagreeing:
//
//     visible:  Home › Blog › Real Estate
//     JSON-LD:  Home › Blog › Curb Appeal
//
// The visible third segment was the article's *category* — already shown a line below
// in `.article-eyebrow`, and not a link, because there are no category pages. The
// JSON-LD's was the article. Nothing caught it: both halves are individually valid, and
// nothing in the build reads the two together. This test is the thing that reads them
// together.
//
// The comparison is by text, so it also catches the quieter version — someone editing
// one half of a trail and not the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

function htmlPages(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlPages(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const relative = (file) => path.relative(PUBLIC, file).replace(/\\/g, '/');

/** Decode the handful of entities the trails actually use, so text compares to JSON. */
const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

// The blog is the only place with a visible trail, so this is the only class to match.
const CRUMB_NAV = /<nav[^>]*class="[^"]*\bblog-crumbs\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/i;

// The separator span. `[^>]*` rather than a bare `<span>` so an added attribute (an
// aria-hidden, say) does not silently stop the trail from splitting — which would make
// every comparison below pass on a one-segment trail.
const CRUMB_SEP = /<span[^>]*>\s*›\s*<\/span>/;

/**
 * The visible trail's segments, in order: the text of each crumb with the `›`
 * separators and any markup stripped. Returns null when the page has no visible trail.
 */
function visibleTrail(html) {
  const nav = CRUMB_NAV.exec(html);
  if (!nav) return null;
  return nav[1]
    .split(CRUMB_SEP)
    .map((part) => decode(part.replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean);
}

/** The BreadcrumbList's item names, in position order, or null when there is none. */
function jsonLdTrail(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    if (data['@type'] !== 'BreadcrumbList') continue;
    return [...data.itemListElement]
      .sort((a, b) => a.position - b.position)
      .map((i) => i.name);
  }
  return null;
}

const PAGES = htmlPages(PUBLIC).map((file) => ({ rel: relative(file), html: fs.readFileSync(file, 'utf8') }));
const ARTICLES = PAGES.filter((p) => p.rel.startsWith('blog/') && p.rel !== 'blog/index.html');

test('the scan finds the blog and its trails', () => {
  // A broken walk or a renamed class makes every assertion below vacuous.
  assert.ok(ARTICLES.length >= 8, `expected the articles, found ${ARTICLES.length}`);
  const withTrails = PAGES.filter((p) => visibleTrail(p.html));
  assert.ok(withTrails.length >= 9, `expected the visible trails, found ${withTrails.length}`);
});

test('every visible trail matches its BreadcrumbList, segment for segment', () => {
  const mismatched = [];
  for (const page of PAGES) {
    const visible = visibleTrail(page.html);
    if (!visible) continue;
    const structured = jsonLdTrail(page.html);
    assert.ok(structured, `${page.rel} shows a breadcrumb trail but publishes no BreadcrumbList`);
    if (visible.length !== structured.length || visible.some((seg, i) => seg !== structured[i])) {
      mismatched.push({ page: page.rel, visible, structured });
    }
  }
  assert.deepEqual(
    mismatched, [],
    'the JSON-LD must describe the trail the visitor sees — Google discards a '
      + 'BreadcrumbList that names crumbs the page does not show',
  );
});

test('every blog article publishes both halves of a trail', () => {
  // The articles are the deepest crawlable pages on the site and the ones a breadcrumb
  // rich result actually helps; neither half is optional there.
  const missing = ARTICLES
    .map((p) => ({ page: p.rel, visible: !!visibleTrail(p.html), structured: !!jsonLdTrail(p.html) }))
    .filter((r) => !r.visible || !r.structured);
  assert.deepEqual(missing, []);
});

test('an article trail is Home › Blog › the article', () => {
  // Pins the shape, so a future article cannot reintroduce the category-as-crumb form:
  // a category is not a place on this site, and there is no page to click through to.
  for (const page of ARTICLES) {
    const trail = visibleTrail(page.html);
    assert.equal(trail.length, 3, `${page.rel}: expected three crumbs, got ${trail.join(' › ')}`);
    assert.deepEqual(trail.slice(0, 2), ['Home', 'Blog'], `${page.rel}: unexpected parent chain`);
    assert.ok(trail[2], `${page.rel}: the last crumb is empty`);
  }
});

// The rest of this file only checks trails that already exist, so a page shipping with
// NO breadcrumb at all was invisible to it. That is how four indexable pages went
// untrailed while the suite stayed green. The sweep below is the half that reads
// absence.
//
// WHERE THE PAGE LIST COMES FROM. This used to iterate LOCALIZED_PAGES, which cannot
// see an English-only page — and privacy.html and terms.html are English-only by
// decision, self-canonical, `index, follow`, and in the sitemap. So the one class of
// page the guard could not see was exactly the class that was missing, and any future
// English-only page inherited the same silence. The list is therefore derived from the
// files on disk: a page is in scope unless it says it does not want to be indexed.
//
// Not the sitemap either, tempting as it looks. A page missing from the sitemap is its
// own bug; sourcing this guard from the sitemap would let that bug hide this one.
//
// Only the JSON-LD half is required here. The marketing, studio and legal pages
// deliberately show no on-page trail: they are one level below the root, so a visible
// "Home › X" buys a visitor nothing the header's Home link does not already give them,
// and on the studios it would compete with a full-viewport tool. The BreadcrumbList
// still earns the hierarchy line in search results.

/** Does the page ask search engines not to index it? Then it owes no trail. */
const isNoindex = (html) => /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(html);

/**
 * Is the page a meta-refresh redirect stub? faq.html and pro.html are ~15-line shells
 * that canonical at another page; a trail on one would describe a page nobody lands on.
 */
const isRedirectStub = (html) => /<meta[^>]+http-equiv=["']refresh["']/i.test(html);

const INDEXABLE = PAGES.filter((p) => !isNoindex(p.html) && !isRedirectStub(p.html));

// Indexable pages that correctly publish no trail, and why. Anything else in scope must
// publish one.
const UNTRAILED = new Map([
  ['index.html', 'the root of every trail — a one-crumb breadcrumb is not a trail'],
  ['status.html', 'an operational readout, not a page in the content hierarchy'],
]);

test('the indexable sweep has the shape it should', () => {
  // A filter bug that empties (or floods) this set would make the coverage test below
  // pass vacuously — the exact failure mode this whole sweep exists to end.
  assert.ok(
    INDEXABLE.length >= 19,
    `expected the indexable pages, found ${INDEXABLE.length}: ${INDEXABLE.map((p) => p.rel)}`,
  );
  const rels = new Set(INDEXABLE.map((p) => p.rel));
  for (const name of ['index.html', 'privacy.html', 'terms.html', 'guides.html', 'blog/index.html']) {
    assert.ok(rels.has(name), `${name} must be in the indexable sweep`);
  }
  // The two filters are load-bearing; pin one page each so neither can quietly stop
  // matching and drag noindex app pages or redirect shells into scope.
  assert.ok(!rels.has('admin.html'), 'the noindex filter must exclude admin.html');
  assert.ok(!rels.has('faq.html'), 'the redirect-stub filter must exclude faq.html');
});

test('every indexable page below the root publishes a BreadcrumbList', () => {
  const missing = [];
  for (const page of INDEXABLE) {
    if (UNTRAILED.has(page.rel)) continue;
    if (!jsonLdTrail(page.html)) missing.push(page.rel);
  }
  assert.deepEqual(
    missing, [],
    'these indexable pages publish no breadcrumb structured data. Add the page to '
      + 'UNTRAILED if it genuinely sits outside the content hierarchy.',
  );
});

test('the exemptions are real pages, not stale paths', () => {
  // An UNTRAILED entry that no longer matches a page silently stops exempting anything
  // — and would let the page it was named for regress unnoticed if it came back.
  const rels = new Set(INDEXABLE.map((p) => p.rel));
  for (const exempt of UNTRAILED.keys()) {
    assert.ok(rels.has(exempt), `UNTRAILED lists ${exempt}, which is not an indexable page`);
  }
});

test('the last crumb is plain text, not a link to the page you are on', () => {
  // A self-link is the classic breadcrumb slip; it also makes the trail read as one more
  // navigation choice rather than a position indicator.
  for (const page of PAGES) {
    if (!visibleTrail(page.html)) continue;
    const nav = CRUMB_NAV.exec(page.html)[1];
    const lastSeparator = nav.lastIndexOf('›');
    assert.doesNotMatch(
      nav.slice(lastSeparator),
      /<a\b/i,
      `${page.rel}: the current page must not be a link in its own trail`,
    );
  }
});
