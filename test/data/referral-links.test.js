// Tier: unit (real SQLite in a temp dir) — lib/data/referral-links.js.
//
// WHAT THIS COVERS
// The campaign-link click store behind /columbia and the dashboard's Referrals tab:
//   - the bot classifier, which is the difference between "42 people clicked" and
//     "42 link-preview crawlers fetched the URL once each",
//   - referer normalisation, which is where the privacy promise is kept (no query
//     strings — those routinely carry the sending site's tracking params),
//   - the daily series, including the empty days a chart needs,
//   - retention + the per-slug row cap, since this table is written by
//     unauthenticated requests onto the volume auth-store.db lives on,
//   - the registry itself: slugs must be single lowercase segments and must not
//     collide with a real page.
//
// Runs against a throwaway data dir, so no real referral data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReferralLinks,
  isBotUserAgent,
  normalizeReferer,
  buildDailySeries,
  REFERRAL_LINKS,
  SLUG_PATTERN,
} from '../../lib/data/referral-links.js';
import { closeDb } from '../../lib/data/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LINKS = [{ slug: 'columbia', label: 'Columbia University', note: 'Campus outreach' }];

const dirs = [];
function store(links = LINKS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-ref-'));
  dirs.push(dir);
  return { dir, links: createReferralLinks(dir, { links }) };
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const now = Date.UTC(2026, 6, 28, 12);

  assert.deepEqual(links.recordHit({ slug: 'columbia', userAgent: CHROME, now }), { ok: true, isBot: false });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'columbia', userAgent: 'Slackbot-LinkExpanding 1.0', now });

  const [row] = links.summary({ now, days: 30 });
  assert.equal(row.slug, 'columbia');
  assert.equal(row.path, '/columbia');
  assert.equal(row.clicks, 2, 'only the humans are clicks');
  assert.equal(row.botHits, 1, 'the crawler is reported, not silently dropped');
  assert.equal(row.lastClickAt, now);
  assert.equal(links.countAll(), 3, 'but every hit is on disk');
});

test('an unknown slug is refused rather than recorded', () => {
  const { links } = store();
  const result = links.recordHit({ slug: 'not-a-campaign', userAgent: CHROME });
  assert.deepEqual(result, { ok: false, reason: 'unknown-slug' });
  assert.equal(links.countAll(), 0);
});

test('the summary window scopes the chart but not the lifetime total', () => {
  const { links } = store();
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

test('referrers are grouped by host+path, most-clicked first, bots excluded', () => {
  const { links } = store();
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
  const now = Date.UTC(2026, 6, 28, 12);

  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 500 * DAY_MS });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 401 * DAY_MS });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now: now - 100 * DAY_MS });
  assert.equal(links.countAll(), 3);

  assert.equal(links.prune(now), 2, 'both rows older than 400 days go');
  assert.equal(links.countAll(), 1);
  assert.equal(links.summary({ now, days: 365 })[0].clicks, 1);
});

test('the state survives a reopen of the same data dir', () => {
  const { dir, links } = store();
  const now = Date.UTC(2026, 6, 28, 12);
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });
  links.recordHit({ slug: 'columbia', userAgent: CHROME, now });

  // Same shared connection, but a fresh store object: the CREATE TABLE IF NOT
  // EXISTS path must not wipe or shadow what is already there.
  const reopened = createReferralLinks(dir, { links: LINKS });
  assert.equal(reopened.summary({ now, days: 30 })[0].clicks, 2);
});

// ---- The registry itself --------------------------------------------------

test('every configured slug is a single lowercase URL segment', () => {
  assert.ok(REFERRAL_LINKS.length > 0, 'the registry is populated — an empty one silently disables the feature');
  for (const link of REFERRAL_LINKS) {
    assert.match(link.slug, SLUG_PATTERN, `bad slug: ${link.slug}`);
    assert.ok(link.label && link.label.trim(), `${link.slug} needs a dashboard label`);
  }
  const slugs = REFERRAL_LINKS.map((l) => l.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slugs must be unique — the last route registered would win');
});
