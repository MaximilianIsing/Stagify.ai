// Drift guard for the THREE places every blog article records its dates.
//
// Each article writes its dates down three times, and no runtime code reconciles them:
//   1. the visible `.article-meta` line ("By Stagify.ai · August 9, 2026 · 8 min read");
//   2. `datePublished` / `dateModified` in the BlogPosting JSON-LD;
//   3. `lastmod` in ENGLISH_ONLY_ENTRIES in lib/i18n/sitemap.js, which becomes
//      public/sitemap.xml.
//
// WHY THIS EXISTS. Two real failures, both invisible without comparing the copies:
//
//   * `dateModified` was a dead copy of `datePublished` on all ten articles — it had never
//     been updated on any edit, so no article had ever signalled a refresh.
//   * Refreshing the stale sitemap `lastmod`s then moved copy 3 for two articles without
//     moving copy 2, leaving the sitemap claiming a modification the schema denied.
//     Contradictory dates weaken the freshness signal rather than strengthening it.
//
// So the rule is: `dateModified` IS the sitemap `lastmod` — edit an article, and both move
// together. `datePublished` and the visible date are the publication date and must agree
// with each other (Google requires schema dates to mirror visible content), and neither
// moves on an edit.
//
// Comments are stripped before scanning so commented-out markup can't satisfy a check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const BLOG = path.join(ROOT, 'public', 'blog');

/** Strip HTML comments so commented-out markup can't satisfy the scan. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * `lastmod` per blog slug, read out of the sitemap config rather than the generated XML —
 * the config is what a human edits, so that is where a mistake gets made.
 * @returns {Map<string, string>}
 */
function sitemapLastmods() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'i18n', 'sitemap.js'), 'utf8');
  const out = new Map();
  const re = /\/blog\/([a-z0-9-]+)`,\s*lastmod:\s*'(\d{4}-\d{2}-\d{2})'/g;
  for (const m of src.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** The `BlogPosting` node on a page, or null. */
function blogPosting(html) {
  const clean = stripComments(html);
  for (const m of clean.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return { parseError: true };
    }
    for (const node of [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])]) {
      if (node && node['@type'] === 'BlogPosting') return node;
    }
  }
  return null;
}

/** The visible `.article-meta` date, as an ISO string, or null. */
function visibleDateIso(html) {
  const meta = stripComments(html).match(/<p class="article-meta">([\s\S]*?)<\/p>/i);
  if (!meta) return null;
  const text = meta[1].replace(/<[^>]*>/g, '');
  const m = text.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = months.indexOf(m[1]);
  if (idx < 0) return null;
  return `${m[3]}-${String(idx + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** Every article file (the hub, blog/index.html, is a `Blog` not a `BlogPosting`). */
const ARTICLES = fs.readdirSync(BLOG)
  .filter((f) => f.endsWith('.html') && f !== 'index.html')
  .sort();

test('the article inventory is non-empty', () => {
  // Without this, a bad readdir filter would make every assertion below vacuously pass.
  assert.ok(ARTICLES.length >= 10, `expected 10+ articles, found ${ARTICLES.length}`);
});

test('every article has a BlogPosting with both dates, and a visible date', () => {
  for (const file of ARTICLES) {
    const html = fs.readFileSync(path.join(BLOG, file), 'utf8');
    const post = blogPosting(html);
    assert.ok(post, `${file}: no BlogPosting JSON-LD found`);
    assert.ok(!post.parseError, `${file}: a JSON-LD block does not parse`);
    assert.match(post.datePublished || '', /^\d{4}-\d{2}-\d{2}$/, `${file}: datePublished missing/malformed`);
    assert.match(post.dateModified || '', /^\d{4}-\d{2}-\d{2}$/, `${file}: dateModified missing/malformed`);
    assert.ok(visibleDateIso(html), `${file}: no parseable date in the visible .article-meta line`);
  }
});

test('datePublished matches the visible date', () => {
  for (const file of ARTICLES) {
    const html = fs.readFileSync(path.join(BLOG, file), 'utf8');
    const post = blogPosting(html);
    assert.equal(
      post.datePublished, visibleDateIso(html),
      `${file}: datePublished disagrees with the visible .article-meta date. Google requires schema `
        + 'dates to mirror visible content. Neither should move when an article is merely edited — '
        + 'that is what dateModified is for.',
    );
  }
});

test('dateModified equals the sitemap lastmod for every article', () => {
  const lastmods = sitemapLastmods();
  assert.ok(lastmods.size >= 10, `expected 10+ blog lastmods in sitemap.js, parsed ${lastmods.size}`);

  for (const file of ARTICLES) {
    const slug = file.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(BLOG, file), 'utf8');
    const post = blogPosting(html);
    const lastmod = lastmods.get(slug);
    assert.ok(lastmod, `${slug}: no ENGLISH_ONLY_ENTRIES lastmod in lib/i18n/sitemap.js`);
    assert.equal(
      post.dateModified, lastmod,
      `${slug}: dateModified (${post.dateModified}) != sitemap lastmod (${lastmod}). These are two `
        + 'copies of one fact; a sitemap claiming a modification the schema denies is a weaker freshness '
        + 'signal than either alone. Edit an article and move BOTH, then rerun scripts/build-i18n-seo.js.',
    );
  }
});

test('dateModified is never earlier than datePublished', () => {
  for (const file of ARTICLES) {
    const post = blogPosting(fs.readFileSync(path.join(BLOG, file), 'utf8'));
    assert.ok(
      post.dateModified >= post.datePublished,
      `${file}: dateModified ${post.dateModified} precedes datePublished ${post.datePublished}.`,
    );
  }
});
