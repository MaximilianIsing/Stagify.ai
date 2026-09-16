// Tier: unit — lib/content/blog-posts.js.
//
// WHAT THIS COVERS
// The article catalog behind the admin dashboard's Blog tab. It is a SCAN of
// public/blog/ rather than a hand-written list, precisely so a new post cannot be
// forgotten — which makes the parsing the thing worth pinning down:
//   - the title comes from the article's own `<h1>`, not the `<title>`, because the
//     `<title>` carries the " | Stagify.ai" suffix written for search results;
//   - a commented-out heading must not be able to supply a title, matching the
//     rule test/seo/blog-dates.test.js enforces on the dates;
//   - the publication date is the `article:published_time` the articles already
//     carry, so the tab needs no fourth copy of it;
//   - index.html is the hub, not an article.
//
// The last test runs against the REAL public/blog folder: if an article stops
// yielding a readable title, the dashboard would quietly list it by its slug.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listBlogPosts, parsePostMeta, clearBlogPostCache } from '../../lib/content/blog-posts.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];

/** A throwaway base dir with the given `public/blog` files. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-posts-'));
  dirs.push(dir);
  const blog = path.join(dir, 'public', 'blog');
  fs.mkdirSync(blog, { recursive: true });
  for (const [name, html] of Object.entries(files)) fs.writeFileSync(path.join(blog, name), html);
  return dir;
}

afterEach(() => {
  clearBlogPostCache();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('the h1 wins over the title tag, and entities are resolved', () => {
  const meta = parsePostMeta(`
    <title>Something Longer | Stagify.ai</title>
    <meta property="article:published_time" content="2026-09-09">
    <h1 class="article-title">Staging Isn&rsquo;t Free &amp; Neither Is Waiting</h1>
  `);
  assert.equal(meta.title, 'Staging Isn’t Free & Neither Is Waiting');
  assert.equal(meta.publishedAt, '2026-09-09');
});

test('the title tag is the fallback, with the site suffix stripped', () => {
  const meta = parsePostMeta('<title>What Staging Costs | Stagify.ai</title>');
  assert.equal(meta.title, 'What Staging Costs');
  assert.equal(meta.publishedAt, null);
});

test('a commented-out heading cannot supply the title', () => {
  const meta = parsePostMeta('<!-- <h1>Draft headline</h1> --><title>Real One | Stagify.ai</title>');
  assert.equal(meta.title, 'Real One');
});

test('every article is listed, newest first, and the hub is not one', () => {
  const dir = fixture({
    'index.html': '<h1>Blog</h1>',
    'older.html': '<meta property="article:published_time" content="2026-01-02"><h1>Older</h1>',
    'newer.html': '<meta property="article:published_time" content="2026-05-02"><h1>Newer</h1>',
  });
  const posts = listBlogPosts(dir, { fresh: true });
  assert.deepEqual(posts.map((p) => p.slug), ['newer', 'older']);
  assert.equal(posts[0].path, '/blog/newer');
  assert.equal(posts[0].title, 'Newer');
});

test('an article with no readable title falls back to its slug rather than being dropped', () => {
  const dir = fixture({ 'mystery-post.html': '<p>no heading here</p>' });
  const posts = listBlogPosts(dir, { fresh: true });
  assert.deepEqual(posts.map((p) => p.slug), ['mystery-post']);
  assert.equal(posts[0].title, 'mystery-post');
});

test('a missing blog folder yields an empty list rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-posts-'));
  dirs.push(dir);
  assert.deepEqual(listBlogPosts(dir, { fresh: true }), []);
});

test('every real article yields a title and a publication date', () => {
  const posts = listBlogPosts(REPO_ROOT, { fresh: true });
  assert.ok(posts.length >= 14, `expected the real articles, got ${posts.length}`);
  for (const post of posts) {
    assert.notEqual(post.title, post.slug, `${post.slug} has no readable <h1> — the dashboard would list it by slug`);
    assert.match(post.publishedAt || '', /^\d{4}-\d{2}-\d{2}/, `${post.slug} has no article:published_time`);
  }
});
