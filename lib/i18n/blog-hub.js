// Prune the blog hub to the articles a locale actually has.
//
// The hub is one hand-authored grid of fifteen cards, and every locale renders that same
// file. But an article is localized per language (lib/i18n/blog-packs.js), so the Korean
// hub must not show a card for an article that exists only in English — following it
// would land the reader on a 404, because routes/i18n.js registers a localized article URL
// only when its translation pack exists.
//
// Removing the card rather than linking out to the English copy is deliberate. A grid of
// fifteen promises, ten of which change language when clicked, is a worse experience than
// a grid of five that all work; and a localized hub linking into the English tree would
// undercut the hreflang cluster it sits inside.
//
// This is a post-render string transform rather than a render step: it removes markup
// rather than translating it, and it needs to run after the anchors have been rewritten
// into the locale tree. lib/i18n/page-renderer.js calls it through `postProcess`, inside
// the memo, so it costs one pass per (locale, page) for the process lifetime.

import { logger } from '../logger.js';
import { findMatchingClose } from './render-page.js';

/**
 * Remove every `<a class="blog-card">` whose slug is not in `available`, and drop the
 * matching entries from the `Blog` JSON-LD's `blogPost` array so the structured data
 * describes the grid the reader is actually looking at.
 *
 * Returns the HTML unchanged when nothing needs removing, which is the English case and
 * the case of a locale that has every article.
 *
 * @param {string} html   the rendered hub
 * @param {Set<string>} available  slugs this locale has a translation pack for
 * @param {string} [prefix]  this locale's URL prefix; '' leaves URLs in the English tree
 * @returns {string}
 */
export function pruneHubForLocale(html, available, prefix = '') {
  let out = pruneCards(html, available);
  out = pruneBlogPosts(out, available, prefix);
  return out;
}

/**
 * Drop the card anchors for unavailable slugs.
 *
 * The anchor is found by its own opening tag and closed with the renderer's nesting-aware
 * scan, because a card wraps an inner `<div>` — a lazy `[\s\S]*?</a>` would stop at the
 * first `</a>` inside a card that ever grows one.
 * @param {string} html
 * @param {Set<string>} available
 * @returns {string}
 */
function pruneCards(html, available) {
  const open = /<a class="blog-card" href="(?:\/[a-z-]{2,5})?\/blog\/([a-z0-9-]+)"[^>]*>/gi;
  let out = '';
  let cursor = 0;
  let removed = 0;
  let m;
  while ((m = open.exec(html)) !== null) {
    const slug = m[1];
    if (available.has(slug)) continue;
    const bodyStart = m.index + m[0].length;
    const closeIdx = findMatchingClose(html, bodyStart, 'a');
    if (closeIdx === -1) {
      // Unbalanced markup: leave the card rather than swallow the rest of the document.
      logger.warn('[blog-hub] no balanced </a> for card', slug, '- leaving it in place');
      continue;
    }
    const end = closeIdx + '</a>'.length;
    // Take the card's leading whitespace with it so the grid keeps its indentation.
    let start = m.index;
    while (start > 0 && (html[start - 1] === ' ' || html[start - 1] === '\t')) start -= 1;
    out += html.slice(cursor, start);
    cursor = end;
    // …and the blank line it left behind.
    while (html[cursor] === '\r' || html[cursor] === '\n') cursor += 1;
    removed += 1;
    open.lastIndex = end;
  }
  if (removed === 0) return html;
  return out + html.slice(cursor);
}

/**
 * Drop the unavailable articles from the `Blog` block's `blogPost` list, and point the
 * survivors at this locale's copies.
 *
 * Both halves matter. Structured data listing posts the page does not link to is a
 * mismatch between the markup and the schema; structured data listing them at their
 * ENGLISH URLs is worse — the Spanish hub would tell Google its posts live in the English
 * tree, contradicting the hreflang cluster in its own head and the hrefs in its own grid.
 * The article trails get the same treatment from localizeBreadcrumbs(), for the same
 * reason.
 * @param {string} html
 * @param {Set<string>} available
 * @param {string} prefix
 * @returns {string}
 */
function pruneBlogPosts(html, available, prefix) {
  return html.replace(
    /(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (all, open, body, close) => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return all; // malformed — leave exactly as authored
      }
      if (data?.['@type'] !== 'Blog' || !Array.isArray(data.blogPost)) return all;

      let changed = false;
      const kept = [];
      for (const post of data.blogPost) {
        const slug = slugOf(post);
        if (slug && !available.has(slug)) {
          changed = true;
          continue;
        }
        if (slug && prefix) changed = localizePostUrls(post, prefix) || changed;
        kept.push(post);
      }
      if (!changed) return all;
      data.blogPost = kept;
      return `${open}${JSON.stringify(data)}${close}`;
    },
  );
}

/** The blog slug a `BlogPosting` entry points at, or null. @param {any} post */
function slugOf(post) {
  const url = typeof post?.url === 'string' ? post.url : post?.mainEntityOfPage?.['@id'];
  if (typeof url !== 'string') return null;
  const m = /\/blog\/([a-z0-9-]+)/.exec(url);
  return m ? m[1] : null;
}

/**
 * Rewrite a `BlogPosting` entry's URLs into the locale tree. Idempotent: a URL already
 * carrying the prefix is left alone.
 * @param {any} post
 * @param {string} prefix
 * @returns {boolean} whether anything moved
 */
function localizePostUrls(post, prefix) {
  let changed = false;
  /** @param {unknown} url */
  const move = (url) => {
    if (typeof url !== 'string') return url;
    const next = url.replace(/^(https?:\/\/[^/]+)\/blog\//, `$1/${prefix}/blog/`);
    if (next !== url) changed = true;
    return next;
  };
  if (typeof post.url === 'string') post.url = move(post.url);
  if (post.mainEntityOfPage && typeof post.mainEntityOfPage['@id'] === 'string') {
    post.mainEntityOfPage['@id'] = move(post.mainEntityOfPage['@id']);
  }
  return changed;
}

/**
 * Add a `readTime` to each hub card, taken from the part of `meta` after the separator.
 *
 * The home page's blog teaser shows the same six articles as the hub, and needs three of the
 * four strings a hub card already carries — tag, title and the thumbnail's alt text. The
 * fourth is the odd one: the hub's card reads "September 9, 2026 · 10 min read" while the
 * teaser shows only "10 min read".
 *
 * Deriving it here rather than storing it is deliberate. The alternative is a `readTime` key
 * in all ten hub packs saying, in each language, the second half of a string sitting three
 * lines above it — two places to edit and one to forget, for a value that is never anything
 * else. All 150 translated cards use the same "·" separator, and a card that somehow lacks
 * one simply gets no `readTime`, so the English markup shows through as it does for any
 * unresolved key.
 *
 * @param {Record<string, any>} hub  a parsed blog/i18n/_hub/<lang>.json
 * @returns {Record<string, any>} a copy; the loader's cached object is never mutated
 */
export function withCardReadTimes(hub) {
  if (!hub || !hub.cards) return hub;
  /** @type {Record<string, unknown>} */
  const cards = {};
  for (const [slug, card] of Object.entries(hub.cards)) {
    const parts = typeof card?.meta === 'string' ? card.meta.split('·') : [];
    cards[slug] = parts.length > 1 ? { ...card, readTime: parts[parts.length - 1].trim() } : card;
  }
  return { ...hub, cards };
}
