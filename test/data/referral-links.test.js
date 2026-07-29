// Tier: unit (real SQLite in a temp dir) — lib/data/referral-links.js.
//
// WHAT THIS COVERS
// The campaign-link store behind /columbia-style URLs and the dashboard's Referrals
// tab. Links are operator-created data now, so the surface is CRUD plus the click
// ledger:
//   - creation validation, which is the difference between a working link and one
//     that silently never fires (a slug like `pro` or `es`),
//   - retire vs delete: retiring must stop the URL AND keep the history, since
//     that distinction is the whole reason there are two buttons,
//   - the one-time seed of the formerly-hardcoded /columbia link, which must not
//     resurrect it after the operator deletes it,
//   - the bot classifier, which is the difference between "42 people clicked" and
//     "42 link-preview crawlers fetched the URL once each",
//   - referer normalisation, where the privacy promise is kept (no query strings —
//     those routinely carry the sending site's tracking params),
//   - the daily series, including the empty days a chart needs,
//   - retention + the per-slug row cap, since referral_hits is written by
//     unauthenticated requests onto the volume auth-store.db lives on.
//
// Runs against a throwaway data dir, so no real referral data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReferralLinks,
  computeReservedSlugs,
  isBotUserAgent,
  normalizeReferer,
  buildDailySeries,
  RESERVED_ROUTE_ROOTS,
} from '../../lib/data/referral-links.js';
import { closeDb } from '../../lib/data/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', '..');

const dirs = [];

/**
 * A store on a fresh data dir. `seed:false` by default so tests start empty; the
 * seeding tests opt in. baseDir points at the REPO so the reserved-slug list is
 * computed from the real public/ folder — that is what production does.
 */
function store({ seed = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-ref-'));
  dirs.push(dir);
  // The data dir and the reserved-list dir are the same argument in production;
  // here the temp dir has no public/, so a link named after a real page would be
  // allowed. Copy in just enough to make the reserved list real.
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, 'public'))) {
    if (entry.endsWith('.html')) fs.writeFileSync(path.join(dir, 'public', entry), '');
  }
  return { dir, links: createReferralLinks(dir, { seed }) };
}

/** Create a link and assert it worked — most tests need one to exist. */
function seeded(links, over = {}) {
  const result = links.createLink({ slug: 'columbia', label: 'Columbia University', note: 'Campus outreach', ...over });
  assert.equal(result.ok, true, `precondition: createLink failed — ${result.error || ''}`);
  return result.link;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Creating links --------------------------------------------------------

test('a created link is immediately live and listed', () => {
  const { links } = store();
  const link = seeded(links);
  assert.equal(link.slug, 'columbia');
  assert.equal(link.path, '/columbia');
  assert.equal(link.active, true);
  assert.equal(links.getActiveLink('columbia').slug, 'columbia', 'resolves for the redirect right away');
  assert.deepEqual(links.listLinks().map((l) => l.slug), ['columbia']);
});

test('slugs are normalised and matched case-insensitively', () => {
  const { links } = store();
  const link = seeded(links, { slug: '  Columbia  ' });
  assert.equal(link.slug, 'columbia', 'trimmed and lowercased on the way in');
  assert.equal(links.getActiveLink('COLUMBIA').slug, 'columbia', 'a visitor typing caps still lands');
});

test('a malformed slug is refused with a reason', () => {
  const { links } = store();
  for (const bad of ['', ' ', 'a', 'has space', 'UPPER!', 'trailing-', '-leading', 'x'.repeat(32), 'sub/path']) {
    const result = links.createLink({ slug: bad, label: 'X' });
    assert.equal(result.ok, false, `should refuse ${JSON.stringify(bad)}`);
    assert.ok(result.code && result.error, 'rejections carry a code and a message for the dashboard');
  }
  // A hyphen inside and digits are fine.
  assert.equal(links.createLink({ slug: 'nyu-fall-26', label: 'NYU' }).ok, true);
});

test('a link with no name is refused', () => {
  // The name is how you tell two campaigns apart three months later.
  const { links } = store();
  const result = links.createLink({ slug: 'nyu', label: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LABEL_REQUIRED');
});

test('a slug that would collide with the real site is refused', () => {
  // Not destructive — the resolver is mounted last, so such a link could never take
  // a page off the site. It is refused because it would silently never count.
  const { links } = store();
  for (const taken of ['pro', 'admin', 'api', 'es', 'fr', 'guides', 'contact', 'blog', 'status']) {
    const result = links.createLink({ slug: taken, label: 'X' });
    assert.equal(result.ok, false, `/${taken} should be refused`);
    assert.equal(result.code, 'SLUG_RESERVED', `/${taken} should be refused as reserved`);
  }
});

test('a duplicate slug is refused, including against a retired link', () => {
  const { links } = store();
  seeded(links);
  assert.equal(links.createLink({ slug: 'columbia', label: 'Again' }).code, 'SLUG_TAKEN');

  // A retired link still owns its URL — reusing the slug would silently attach the
  // new campaign's clicks to the old one's history.
  links.deactivateLink('columbia');
  assert.equal(links.createLink({ slug: 'columbia', label: 'Again' }).code, 'SLUG_TAKEN');
});

test('long labels and notes are clamped rather than rejected', () => {
  const { links } = store();
  const link = seeded(links, { slug: 'nyu', label: 'L'.repeat(200), note: 'N'.repeat(400) });
  assert.equal(link.label.length, 60);
  assert.equal(link.note.length, 120);
});

// ---- Retire vs delete ------------------------------------------------------

test('retiring stops the URL resolving but keeps the link and its clicks', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });

  const result = links.deactivateLink('columbia', now);
  assert.equal(result.ok, true);
  assert.equal(result.link.active, false);
  assert.equal(result.link.deactivatedAt, now);

  assert.equal(links.getActiveLink('columbia'), null, 'the URL is a 404 now');
  assert.equal(links.listLinks().length, 1, 'but it is still in the dashboard');
  assert.equal(links.summary({ now })[0].clicks, 2, 'with its history intact');
});

test('a retired link records nothing, even if something still calls it', () => {
  const { links } = store();
  seeded(links);
  links.deactivateLink('columbia');
  assert.deepEqual(links.recordHit({ slug: 'columbia', userAgent: CHROME }), { ok: false, reason: 'unknown-slug' });
  assert.equal(links.countAll(), 0, 'a stale cache or direct call cannot keep it accruing');
});

test('restoring puts a retired link back into service', () => {
  const { links } = store();
  seeded(links);
  links.deactivateLink('columbia');
  const result = links.activateLink('columbia');
  assert.equal(result.ok, true);
  assert.equal(result.link.active, true);
  assert.equal(result.link.deactivatedAt, null, 'the retirement stamp is cleared');
  assert.equal(links.recordHit({ slug: 'columbia', userAgent: CHROME }).ok, true);
});

test('deleting erases the link and every click it recorded', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);
  for (let i = 0; i < 3; i += 1) links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'columbia', userAgent: 'Slackbot-LinkExpanding 1.0', now });

  const result = links.deleteLink('columbia');
  assert.equal(result.ok, true);
  assert.equal(result.hitsDeleted, 4, 'bot rows go too — the count is reported so the UI can warn');
  assert.deepEqual(links.listLinks(), []);
  assert.equal(links.countAll(), 0, 'no orphan hit rows left behind');
});

test('acting on a link that no longer exists is a clean NOT_FOUND', () => {
  const { links } = store();
  for (const fn of ['deactivateLink', 'activateLink', 'deleteLink']) {
    const result = links[fn]('ghost');
    assert.equal(result.ok, false, `${fn} should refuse`);
    assert.equal(result.code, 'NOT_FOUND');
  }
});

// ---- The one-time seed -----------------------------------------------------

test('the formerly-hardcoded /columbia link is seeded once', () => {
  const { dir, links } = store({ seed: true });
  assert.deepEqual(links.listLinks().map((l) => l.slug), ['columbia'], 'the deployed URL survives the migration');

  // Reopening must not duplicate it (PRIMARY KEY would throw) …
  createReferralLinks(dir, { seed: true });
  assert.equal(links.listLinks().length, 1);
});

test('a seeded link the operator deletes does not come back on the next boot', () => {
  // The meta guard is the point: without it, every restart would resurrect a
  // campaign that was deliberately retired.
  const { dir, links } = store({ seed: true });
  links.deleteLink('columbia');
  const reopened = createReferralLinks(dir, { seed: true });
  assert.deepEqual(reopened.listLinks(), []);
});

test('state survives a reopen of the same data dir', () => {
  const { dir, links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });

  const reopened = createReferralLinks(dir, { seed: false });
  assert.equal(reopened.listLinks().length, 1);
  assert.equal(reopened.summary({ now })[0].clicks, 2);
});

// ---- Reserved-slug computation --------------------------------------------

test('the reserved set covers routes, locale prefixes and static pages', () => {
  const reserved = computeReservedSlugs(REPO_ROOT);
  for (const root of RESERVED_ROUTE_ROOTS) assert.ok(reserved.has(root), `missing route root: ${root}`);
  for (const prefix of ['es', 'fr', 'de']) assert.ok(reserved.has(prefix), `missing locale prefix: ${prefix}`);
  // Static pages, both with and without the extension.
  assert.ok(reserved.has('pro.html') && reserved.has('pro'), 'a page is reserved with and without .html');
  assert.ok(reserved.has('index.html') && reserved.has('index'));
  // And it does not swallow everything.
  assert.equal(reserved.has('columbia'), false);
  assert.equal(reserved.has('nyu'), false);
});

// ---- Bot classification ---------------------------------------------------

test('real browser user agents are not treated as bots', () => {
  const humans = [
    CHROME,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 Edg/125.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    // A real handset whose model name embeds the letters "bot". A bare 'bot'
    // substring check files this student's phone as a crawler.
    'Mozilla/5.0 (Linux; Android 12; CUBOT_NOTE_20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
  ];
  for (const ua of humans) {
    assert.equal(isBotUserAgent(ua), false, `should be human: ${ua.slice(0, 48)}…`);
  }
});

test('link-preview crawlers and scripted clients are treated as bots', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0 A',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  ];
  for (const ua of bots) {
    assert.equal(isBotUserAgent(ua), true, `should be a bot: ${ua.slice(0, 48)}…`);
  }
});

test('a missing user agent counts as a bot', () => {
  // Every real browser sends one; an absent header is a script, never a visitor.
  assert.equal(isBotUserAgent(''), true);
  assert.equal(isBotUserAgent(undefined), true);
  assert.equal(isBotUserAgent(null), true);
  assert.equal(isBotUserAgent('   '), true);
});

// ---- Referer normalisation ------------------------------------------------

test('the referer is reduced to host + path, dropping the query string', () => {
  // The dropped query is the point: a referring page's URL routinely carries that
  // site's own tracking parameters, and occasionally a session id.
  assert.equal(
    normalizeReferer('https://www.Columbia.edu/Housing/?utm_source=email&sid=abc123'),
    'www.columbia.edu/housing',
  );
  assert.equal(normalizeReferer('https://example.com/'), 'example.com');
  assert.equal(normalizeReferer('http://example.com:8080/a/b/'), 'example.com:8080/a/b');
  assert.equal(normalizeReferer('https://example.com/page#section'), 'example.com/page');
});

test('non-http referers and junk yield nothing to store', () => {
  for (const raw of ['', '   ', undefined, null, 'not a url', 'javascript:alert(1)', 'data:text/html,x', 'android-app://com.example']) {
    assert.equal(normalizeReferer(raw), '', `should be dropped: ${String(raw)}`);
  }
});

// ---- Daily series ---------------------------------------------------------

test('the daily series includes the days with no clicks', () => {
  const start = Date.UTC(2026, 6, 1); // 2026-07-01
  const series = buildDailySeries(
    [start + 3600_000, start + 7200_000, start + 2 * DAY_MS],
    start,
    4,
  );
  assert.deepEqual(series, [
    { date: '2026-07-01', value: 2 },
    { date: '2026-07-02', value: 0 }, // a hole here would read as missing data
    { date: '2026-07-03', value: 1 },
    { date: '2026-07-04', value: 0 },
  ]);
});

// ---- Recording + rollup ---------------------------------------------------

test('human hits count as clicks and bot hits are recorded separately', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);

  assert.deepEqual(links.recordHit({ slug: 'columbia', userAgent: CHROME, now }), { ok: true, isBot: false });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'columbia', userAgent: 'Slackbot-LinkExpanding 1.0', now });

  const [row] = links.summary({ now, days: 30 });
  assert.equal(row.slug, 'columbia');
  assert.equal(row.clicks, 2, 'only the humans are clicks');
  assert.equal(row.botHits, 1, 'the crawler is reported, not silently dropped');
  assert.equal(row.lastClickAt, now);
  assert.equal(links.countAll(), 3, 'but every hit is on disk');
});

test('a hit for a slug that was never created is refused', () => {
  const { links } = store();
  assert.deepEqual(links.recordHit({ slug: 'not-a-campaign', userAgent: CHROME }), { ok: false, reason: 'unknown-slug' });
  assert.equal(links.countAll(), 0);
});

test('the summary window scopes the chart but not the lifetime total', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);

  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 40 * DAY_MS }); // outside 30d
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 10 * DAY_MS });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 2 * DAY_MS });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });

  const [row] = links.summary({ now, days: 30 });
  assert.equal(row.clicks, 4, 'all time ignores the window');
  assert.equal(row.windowClicks, 3, 'the 40-day-old click is outside the window');
  assert.equal(row.last7, 2, 'only the 2-day-old and today ones are in the last 7 days');
  assert.equal(row.series.length, 30);
  assert.equal(row.series[row.series.length - 1].value, 1, 'today is the last bucket');
  assert.equal(row.firstClickAt, now - 40 * DAY_MS);
});

test('each link is counted separately', () => {
  const { links } = store();
  seeded(links);
  seeded(links, { slug: 'nyu', label: 'NYU', note: 'Instagram' });
  const now = Date.UTC(2026, 6, 28, 12);

  for (let i = 0; i < 5; i += 1) links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'nyu', userAgent: CHROME, now });

  const bySlug = Object.fromEntries(links.summary({ now }).map((l) => [l.slug, l.clicks]));
  assert.deepEqual(bySlug, { columbia: 5, nyu: 1 });
});

test('referrers are grouped by host+path, most-clicked first, bots excluded', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);

  links.recordHit({ slug: 'columbia', userAgent: CHROME, referer: 'https://columbia.edu/housing?utm=a', now });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, referer: 'https://columbia.edu/housing?utm=b', now });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, referer: 'https://reddit.com/r/columbia', now });
  links.recordHit({ slug: 'columbia', userAgent: 'facebookexternalhit/1.1', referer: 'https://facebook.com/x', now });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now }); // direct — no referer

  const [row] = links.summary({ now, days: 30 });
  assert.deepEqual(row.referrers, [
    { source: 'columbia.edu/housing', value: 2 },
    { source: 'reddit.com/r/columbia', value: 1 },
  ]);
});

test('a link with no hits still reports a full, zeroed series', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);
  const [row] = links.summary({ now, days: 14 });
  assert.equal(row.clicks, 0);
  assert.equal(row.botHits, 0);
  assert.equal(row.lastClickAt, null);
  assert.equal(row.series.length, 14);
  assert.ok(row.series.every((p) => p.value === 0));
});

// ---- Retention + cap ------------------------------------------------------

test('prune drops rows past the retention horizon and keeps the rest', () => {
  const { links } = store();
  seeded(links);
  const now = Date.UTC(2026, 6, 28, 12);

  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 500 * DAY_MS });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 401 * DAY_MS });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 100 * DAY_MS });
  assert.equal(links.countAll(), 3);

  assert.equal(links.prune(now), 2, 'both rows older than 400 days go');
  assert.equal(links.countAll(), 1);
  assert.equal(links.summary({ now, days: 365 })[0].clicks, 1);
});
