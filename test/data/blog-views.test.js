// Tier: unit (real SQLite in a temp dir) — lib/data/blog-views.js.
//
// WHAT THIS COVERS
// The counter behind the admin dashboard's Blog tab. The surface is small, but
// every part of it is a number an operator will make a decision on:
//   - bot flagging, which is the difference between "40 people read the post" and
//     "40 crawlers fetched it" — a blog URL is unfurled and indexed before a human
//     ever opens it, so this is the majority of raw hits, not an edge case;
//   - the privacy promise: the referrer is stored as host + path with the query
//     string dropped, and nothing else about the reader is stored at all;
//   - the RANKING, which is by reads inside the selected window rather than
//     lifetime, since "which posts are doing best" is a question about now;
//   - the daily series, including the empty days a chart needs;
//   - posts with no reads staying in the list (they are the actionable rows) and
//     reads for a deleted article surviving as a retired row;
//   - a fixed number of prepared statements regardless of how many articles or
//     rows exist — this endpoint gets pointed at the production database, so an
//     accidental per-post query would be an outage, not a slow page. Same guard
//     test/analytics/admin-metrics.test.js keeps over its own snapshot.
//
// Runs against a throwaway data dir, so no real data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBlogViews } from '../../lib/data/blog-views.js';
import { closeDb, getDb } from '../../lib/data/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

const dirs = [];

/** A store on a fresh data dir. */
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-blog-'));
  dirs.push(dir);
  return { dir, views: createBlogViews(dir) };
}

/** The catalog shape lib/content/blog-posts.js produces. */
const POSTS = [
  { slug: 'home-staging-cost', title: 'Staging bills', path: '/blog/home-staging-cost', publishedAt: '2026-09-09' },
  { slug: 'fsbo-listing-photos', title: 'FSBO photos', path: '/blog/fsbo-listing-photos', publishedAt: '2026-08-14' },
];

/** Record `n` human reads of `slug`, `daysAgo` before NOW. */
function reads(views, slug, n, daysAgo = 0, over = {}) {
  for (let i = 0; i < n; i += 1) {
    views.recordView({ slug, userAgent: CHROME, now: NOW - daysAgo * DAY_MS, ...over });
  }
}

/** The row for one slug out of a summary. */
function rowFor(summary, slug) {
  return summary.posts.find((p) => p.slug === slug);
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Counting --------------------------------------------------------------

test('a human read is counted; a crawler hit is recorded but excluded', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 3);
  views.recordView({ slug: 'home-staging-cost', userAgent: 'GPTBot/1.0', now: NOW });
  views.recordView({ slug: 'home-staging-cost', userAgent: 'facebookexternalhit/1.1', now: NOW });

  const row = rowFor(views.summary({ posts: POSTS, now: NOW }), 'home-staging-cost');
  assert.equal(row.views, 3);
  assert.equal(row.botHits, 2, 'bot hits are kept, so a quiet post is distinguishable from a crawled one');
  // All five rows are on disk — the filtering is at read time, not write time.
  assert.equal(views.countAll(), 5);
});

test('a request with no user-agent counts as automated', () => {
  const { views } = store();
  views.recordView({ slug: 'home-staging-cost', now: NOW });
  const row = rowFor(views.summary({ posts: POSTS, now: NOW }), 'home-staging-cost');
  assert.equal(row.views, 0);
  assert.equal(row.botHits, 1);
});

test('a malformed slug is refused rather than stored', () => {
  const { views } = store();
  const result = views.recordView({ slug: '../../etc/passwd', userAgent: CHROME, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-slug');
  assert.equal(views.countAll(), 0);
});

// ---- Privacy ---------------------------------------------------------------

test('a referrer is stored as host + path, with the query string dropped', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 1, 0, { referer: 'https://News.YCombinator.com/item?id=12345&utm_source=x' });

  const row = rowFor(views.summary({ posts: POSTS, now: NOW }), 'home-staging-cost');
  assert.deepEqual(row.referrers, [{ source: 'news.ycombinator.com/item', value: 1 }]);
});

test('traffic sources are ranked, and a missing referrer is simply absent', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 1, 0, { referer: 'https://example.com/a' });
  reads(views, 'home-staging-cost', 3, 0, { referer: 'https://google.com/' });
  reads(views, 'home-staging-cost', 2); // typed URL / stripped referrer

  const row = rowFor(views.summary({ posts: POSTS, now: NOW }), 'home-staging-cost');
  assert.deepEqual(row.referrers.map((r) => r.source), ['google.com', 'example.com/a']);
  assert.equal(row.views, 6, 'a read with no referrer is still a read');
});

// ---- The dashboard payload -------------------------------------------------

test('posts are ranked by reads in the window, not by lifetime reads', () => {
  const { views } = store();
  // An old article with a big back catalogue of reads, all outside the window…
  reads(views, 'fsbo-listing-photos', 50, 200);
  // …and a new one doing well right now.
  reads(views, 'home-staging-cost', 5, 1);

  const summary = views.summary({ posts: POSTS, now: NOW, days: 30 });
  assert.equal(summary.posts[0].slug, 'home-staging-cost', 'the window is what "doing best" means');
  assert.equal(summary.posts[1].views, 50, 'lifetime reads are still reported');
  assert.equal(summary.posts[1].windowViews, 0);
});

test('an article nobody has opened is still a row, and is counted as unread', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 2);

  const summary = views.summary({ posts: POSTS, now: NOW });
  assert.equal(summary.posts.length, 2);
  assert.equal(rowFor(summary, 'fsbo-listing-photos').views, 0);
  assert.equal(summary.totals.unread, 1);
});

test('reads for an article that no longer exists are reported as retired', () => {
  const { views } = store();
  reads(views, 'dorm-room-design-ai-college-freshmen', 4);

  const summary = views.summary({ posts: POSTS, now: NOW });
  const gone = rowFor(summary, 'dorm-room-design-ai-college-freshmen');
  assert.ok(gone, 'a deleted article does not erase the fact that it was read');
  assert.equal(gone.retired, true);
  assert.equal(gone.views, 4);
  assert.equal(rowFor(summary, 'home-staging-cost').retired, false);
});

test('the daily series covers every day in the window, including the empty ones', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 2, 0);
  reads(views, 'home-staging-cost', 1, 3);

  const row = rowFor(views.summary({ posts: POSTS, now: NOW, days: 7 }), 'home-staging-cost');
  assert.equal(row.series.length, 7);
  assert.equal(row.series[row.series.length - 1].value, 2, 'today');
  assert.equal(row.series[row.series.length - 4].value, 1, 'three days ago');
  assert.equal(row.series[0].value, 0, 'an empty day is a zero, not a gap');
  assert.equal(row.last7, 3);
});

test('totals add the posts up and carry a combined series', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 3);
  reads(views, 'fsbo-listing-photos', 2);
  views.recordView({ slug: 'home-staging-cost', userAgent: 'curl/8.0', now: NOW });

  const summary = views.summary({ posts: POSTS, now: NOW, days: 30 });
  assert.equal(summary.totals.views, 5);
  assert.equal(summary.totals.windowViews, 5);
  assert.equal(summary.totals.botHits, 1);
  assert.equal(summary.totals.posts, 2);
  assert.equal(summary.totals.series.length, 30);
  assert.equal(summary.totals.series[29].value, 5);
});

test('first and last read stamps track human reads only', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 1, 5);
  reads(views, 'home-staging-cost', 1, 1);
  // A crawler hitting the page after the last human must not move "last read".
  views.recordView({ slug: 'home-staging-cost', userAgent: 'AhrefsBot/7.0', now: NOW });

  const row = rowFor(views.summary({ posts: POSTS, now: NOW }), 'home-staging-cost');
  assert.equal(row.firstViewAt, NOW - 5 * DAY_MS);
  assert.equal(row.lastViewAt, NOW - 1 * DAY_MS);
});

// ---- Retention -------------------------------------------------------------

test('prune drops views past the retention horizon and keeps the rest', () => {
  const { views } = store();
  reads(views, 'home-staging-cost', 3, 500); // beyond the 400-day horizon
  reads(views, 'home-staging-cost', 2, 10);

  const removed = views.prune(NOW);
  assert.equal(removed, 3);
  assert.equal(views.countAll(), 2);
});

// ---- Cost ------------------------------------------------------------------

test('the snapshot prepares no statements per post and none per row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-blog-'));
  dirs.push(dir);
  const views = createBlogViews(dir);

  // Counting starts AFTER the factory has built its statements: the contract is
  // that reading costs nothing to prepare, however many articles or rows exist.
  const shared = getDb(dir);
  const original = shared.prepare.bind(shared);
  let prepared = 0;
  shared.prepare = (sql) => { prepared += 1; return original(sql); };

  try {
    for (let i = 0; i < 40; i += 1) reads(views, 'home-staging-cost', 1, i % 30);
    for (let i = 0; i < 40; i += 1) reads(views, 'fsbo-listing-photos', 1, i % 30);
    views.summary({ posts: POSTS, now: NOW });
    views.summary({ posts: [...POSTS, { slug: 'a', title: 'a', path: '/blog/a', publishedAt: null }], now: NOW });
    assert.equal(prepared, 0, 'every statement is prepared once, at factory time');
  } finally {
    shared.prepare = original;
  }
});
