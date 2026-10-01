// The blog catalog — slug, title and publication date for every article under
// public/blog/.
//
// WHY THIS IS READ FROM THE FILES rather than listed here as data. The articles
// already write their own metadata down (the `<h1>`, the `article:published_time`
// meta), and routes/public.js already maps one clean URL per file. A fourth
// hand-maintained copy of the list would be a fourth thing to forget on the next
// post — and the failure mode would be silent: the Blog tab would simply stop
// showing an article that is being read. Scanning the directory cannot drift.
//
// The scan is done ONCE per process and cached. These files are static and only
// change on deploy, and the only caller is an admin endpoint that would otherwise
// re-read ~15 files on every poll.

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { errorMessage } from '../errors.js';

/** `public/blog/index.html` is the hub, not an article. */
const NOT_A_POST = new Set(['index.html']);

/**
 * Strip HTML comments so commented-out markup can't be mistaken for the real thing.
 * @param {string} html @returns {string}
 */
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/**
 * Collapse entities and whitespace in a scraped title.
 * @param {unknown} raw @returns {string}
 */
function cleanTitle(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the display title and publication date out of one article's markup.
 *
 * The `<h1>` is preferred over `<title>` because the `<title>` carries the
 * " | Stagify.ai" suffix written for search results, which is noise in a table of
 * fifteen rows that are all Stagify articles.
 *
 * @param {string} html
 * @returns {{ title: string, publishedAt: string | null }}
 */
export function parsePostMeta(html) {
  const src = stripComments(String(html || ''));
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = cleanTitle(h1 ? h1[1] : (titleTag ? titleTag[1].replace(/\s*\|\s*Stagify\.ai\s*$/i, '') : ''));
  const published = /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(src);
  return { title, publishedAt: published ? published[1] : null };
}

/** @type {{ baseDir: string, posts: any[] } | null} */
let cache = null;

/**
 * Every article, newest first (undated ones last, then alphabetical by slug).
 *
 * A directory that cannot be read yields an empty list rather than throwing: the
 * Blog tab showing no posts is a better failure than the admin dashboard 500ing.
 *
 * @param {string} baseDir - Repo root (the folder containing public/).
 * @param {{ fresh?: boolean }} [opts] - `fresh` bypasses the cache (tests).
 * @returns {Array<{ slug: string, title: string, path: string, publishedAt: string | null }>}
 */
export function listBlogPosts(baseDir, { fresh = false } = {}) {
  if (!fresh && cache && cache.baseDir === baseDir) return cache.posts;
  const dir = path.join(baseDir, 'public', 'blog');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    logger.warn('[blog] could not read public/blog:', errorMessage(err));
    return [];
  }
  const posts = names
    .filter((n) => n.toLowerCase().endsWith('.html') && !NOT_A_POST.has(n.toLowerCase()))
    .map((name) => {
      const slug = name.replace(/\.html$/i, '');
      /** @type {{ title: string, publishedAt: string | null }} */
      let meta = { title: '', publishedAt: null };
      try {
        meta = parsePostMeta(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (err) {
        logger.warn('[blog] could not read', name, '-', errorMessage(err));
      }
      return { slug, title: meta.title || slug, path: '/blog/' + slug, publishedAt: meta.publishedAt };
    })
    .sort((a, b) => {
      if (a.publishedAt && b.publishedAt && a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
      if (a.publishedAt && !b.publishedAt) return -1;
      if (!a.publishedAt && b.publishedAt) return 1;
      return a.slug < b.slug ? -1 : 1;
    });
  cache = { baseDir, posts };
  return posts;
}

/** Drop the cached scan. Only needed by tests that write fixture files. */
export function clearBlogPostCache() {
  cache = null;
}
