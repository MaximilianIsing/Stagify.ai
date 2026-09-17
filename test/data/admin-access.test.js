// Tier: unit (real SQLite in a temp dir) — lib/data/admin-access.js.
//
// WHAT THIS COVERS
// The audit trail behind the console's Access tab. Every assertion here is a
// claim the operator will act on — "a stranger tried the door" is not a number to
// get subtly wrong:
//   - the three outcomes, and the reason ladder that distinguishes a wrong key
//     from a dead session from no credential at all;
//   - BURST COLLAPSE, which is the load-bearing piece: /admin is on the public
//     internet, so a scanner or one Refresh on an expired token arrives as a
//     flood. Ten rows would be ten lies. The window is also a boundary, so the
//     far side of it is asserted too;
//   - RETENTION IS FOREVER. There is no time horizon, only a row cap. A decade-old
//     row must survive — this is the requirement most likely to be "helpfully"
//     regressed by someone pattern-matching on blog-views.js, which does prune by
//     age, for the opposite reason (it counts strangers; this counts key-holders);
//   - the UA ladder, which is a pile of historical lies (Edge and Opera claim
//     Chrome, Chrome claims Safari) and therefore order-dependent;
//   - the geo cache: resolved once, never re-fetched, never called for a private
//     address, never throwing when the network is gone, and OFF unless asked;
//   - a fixed number of prepared statements regardless of row count, the same
//     guard test/data/blog-views.test.js keeps, for the same reason: this feeds an
//     endpoint pointed at the production database.
//
// Runs against a throwaway data dir, so no real data is touched. `enabled: true`
// is passed explicitly everywhere because the store defaults to OFF under
// NODE_ENV=test — see the note on that default in the module.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminAccess, parseUserAgent, isPrivateAddress } from '../../lib/data/admin-access.js';
import { closeDb, getDb } from '../../lib/data/db.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const MINUTE = 60 * 1000;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const dirs = [];

/** A store on a fresh data dir, recording on and the network off. */
function store(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-access-'));
  dirs.push(dir);
  return { dir, access: createAdminAccess(dir, { enabled: true, geo: false, now: () => NOW, ...opts }) };
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Outcomes ----

test('records the three outcomes and reports them apart', () => {
  const { access } = store();
  access.record({ ip: '1.1.1.1', outcome: 'open', path: '/admin', userAgent: CHROME, now: NOW });
  access.record({ ip: '1.1.1.1', outcome: 'signin', path: '/admin', userAgent: CHROME, now: NOW });
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-key', path: '/promptlogs', userAgent: SAFARI, now: NOW });

  const { summary: s } = access.summary({});
  assert.equal(s.opens, 1);
  assert.equal(s.signins, 1);
  assert.equal(s.denied, 1);
  assert.equal(s.distinctIps, 2);
  assert.equal(s.deniedIps, 1, 'only the refused address counts as a denied visitor');
});

test('an unknown outcome is refused rather than stored as a fourth kind', () => {
  const { access } = store();
  const res = access.record({ ip: '1.1.1.1', outcome: 'sneaked-in', now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-outcome');
  assert.equal(access.countAll(), 0);
});

test('disabled is a real no-op, not a silent write', () => {
  const { access } = store({ enabled: false });
  assert.equal(access.record({ ip: '1.1.1.1', outcome: 'open', now: NOW }).reason, 'disabled');
  assert.equal(access.countAll(), 0);
});

// ---- Burst collapse ----

test('a burst from one client is one row with a count, not one row each', () => {
  const { access } = store();
  for (let i = 0; i < 10; i += 1) {
    access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-key', path: '/promptlogs', userAgent: CHROME, now: NOW + i * 100 });
  }
  assert.equal(access.countAll(), 1, 'ten refusals in a second are one event');

  const { rows, summary: s } = access.summary({});
  assert.equal(rows[0].hits, 10);
  assert.equal(rows[0].ts, NOW, 'ts stays pinned to the start of the burst');
  assert.equal(rows[0].lastTs, NOW + 900, 'last_ts follows the most recent hit');
  assert.equal(s.denied, 10, 'the TOTAL still counts every attempt');
});

test('past the burst window it is a new event again', () => {
  const { access } = store();
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-key', userAgent: CHROME, now: NOW });
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-key', userAgent: CHROME, now: NOW + MINUTE + 1 });
  assert.equal(access.countAll(), 2);
});

test('collapse ignores the path, so one dead session is one row not ten', () => {
  // The console fires ~10 requests at 10 different URLs per refresh. Keying the
  // collapse on path would let exactly that burst through as ten rows.
  const { access } = store();
  ['/authstore', '/promptlogs', '/chatlogs', '/masklogs'].forEach((p, i) => {
    access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-session', path: p, userAgent: CHROME, now: NOW + i });
  });
  assert.equal(access.countAll(), 1);
  assert.equal(access.summary({}).rows[0].path, '/authstore', 'the first path of the burst is kept');
});

test('a different device, address or reason is never folded together', () => {
  const { access } = store();
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-key', userAgent: CHROME, now: NOW });
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-key', userAgent: SAFARI, now: NOW });
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'bad-session', userAgent: CHROME, now: NOW });
  access.record({ ip: '8.8.8.8', outcome: 'denied', reason: 'bad-key', userAgent: CHROME, now: NOW });
  assert.equal(access.countAll(), 4);
});

// ---- Retention ----

test('retention is forever: an old row is never pruned by age', () => {
  const { access } = store();
  const TEN_YEARS_AGO = NOW - 10 * 365 * 24 * 60 * 60 * 1000;
  access.record({ ip: '1.1.1.1', outcome: 'signin', userAgent: CHROME, now: TEN_YEARS_AGO });
  access.prune();
  assert.equal(access.countAll(), 1, 'the whole point of an audit trail is the day you need it');
  assert.equal(access.summary({}).rows[0].ts, TEN_YEARS_AGO);
});

test('the row cap trims oldest-first as a safety valve', () => {
  const { dir, access } = store();
  // Reaching the real 250k cap in a test would be absurd; drive the statement the
  // cap uses directly to prove it keeps the NEWEST rows.
  for (let i = 0; i < 5; i += 1) {
    access.record({ ip: '10.0.0.' + i, outcome: 'denied', reason: 'bad-key', userAgent: CHROME, now: NOW + i * MINUTE * 2 });
  }
  assert.equal(access.countAll(), 5);
  getDb(dir)
    .prepare('DELETE FROM admin_access_events WHERE id NOT IN (SELECT id FROM admin_access_events ORDER BY id DESC LIMIT ?)')
    .run(2);
  const ips = access.summary({}).summary.visitors.map((v) => v.ip).sort();
  assert.deepEqual(ips, ['10.0.0.3', '10.0.0.4'], 'the newest survive');
});

// ---- Visitors and devices ----

test('a visitor row carries first seen, last seen and every device used', () => {
  const { access } = store();
  access.record({ ip: '1.1.1.1', outcome: 'open', userAgent: CHROME, now: NOW });
  access.record({ ip: '1.1.1.1', outcome: 'open', userAgent: SAFARI, now: NOW + MINUTE * 5 });

  const [v] = access.summary({}).summary.visitors;
  assert.equal(v.ip, '1.1.1.1');
  assert.equal(v.opens, 2);
  assert.equal(v.firstSeen, NOW);
  assert.equal(v.lastSeen, NOW + MINUTE * 5);
  assert.deepEqual(
    v.devices.map((d) => d.browser + '/' + d.os).sort(),
    ['Chrome 126/Windows', 'Safari 17/macOS'],
    'two machines behind one address must both be visible — that is the question the tab answers',
  );
});

test('a bot is flagged, never dropped', () => {
  // A scanner hammering /promptlogs is the single most interesting refused row on
  // the page, so it must survive the bot check rather than be filtered away.
  const { access } = store();
  access.record({ ip: '9.9.9.9', outcome: 'denied', reason: 'no-credential', userAgent: 'curl/8.4.0', now: NOW });
  const { rows } = access.summary({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isBot, true);
  assert.equal(rows[0].browser, 'curl');
});

test('the event feed is capped but the rollup is not', () => {
  const { access } = store();
  for (let i = 0; i < 6; i += 1) {
    access.record({ ip: '10.0.0.' + i, outcome: 'open', userAgent: CHROME, now: NOW + i * MINUTE * 2 });
  }
  const out = access.summary({ limit: 2 });
  assert.equal(out.rows.length, 2, 'the feed honours the limit');
  assert.equal(out.summary.visitors.length, 6, '"first seen" is a question about all of history');
  assert.equal(out.rows[0].ip, '10.0.0.5', 'newest first');
});

// ---- User agents ----

test('the UA ladder resolves the browsers that impersonate each other', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 'Edge 126', 'Windows'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 OPR/111.0', 'Opera 111', 'Windows'],
    [CHROME, 'Chrome 126', 'Windows'],
    [SAFARI, 'Safari 17', 'macOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox 127', 'Linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari 17', 'iOS'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'Chrome 126', 'Android'],
    ['curl/8.4.0', 'curl', ''],
  ];
  for (const [ua, browser, os2] of cases) {
    assert.deepEqual(parseUserAgent(ua), { browser, os: os2 }, ua);
  }
});

test('an absent or unrecognisable UA yields empty strings, not a guess', () => {
  assert.deepEqual(parseUserAgent(''), { browser: '', os: '' });
  assert.deepEqual(parseUserAgent(null), { browser: '', os: '' });
  assert.deepEqual(parseUserAgent('????'), { browser: '', os: '' });
});

// ---- Geo ----

test('private and loopback addresses are recognised and never looked up', async () => {
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.0.5', '172.20.4.4', 'unknown', '']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '203.0.113.9', '172.32.0.1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }

  let called = 0;
  const { access } = store({ geo: true, fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) }; } });
  access.record({ ip: '127.0.0.1', outcome: 'open', userAgent: CHROME, now: NOW });
  await access.resolvePendingGeo({ now: NOW });
  assert.equal(called, 0, 'asking a third party about a loopback address leaks the question and buys nothing');
});

test('a location is resolved once and then read from cache', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return { ok: true, json: async () => ({ success: true, city: 'Munich', region: 'Bavaria', country: 'Germany', country_code: 'DE' }) };
  };
  const { access } = store({ geo: true, fetchImpl });

  access.record({ ip: '203.0.113.9', outcome: 'denied', reason: 'bad-key', userAgent: CHROME, now: NOW });
  assert.equal(await access.resolvePendingGeo({ now: NOW }), 1);
  assert.deepEqual(access.summary({}).rows[0].geo, { city: 'Munich', region: 'Bavaria', country: 'Germany', countryCode: 'DE' });

  access.record({ ip: '203.0.113.9', outcome: 'open', userAgent: CHROME, now: NOW + MINUTE * 5 });
  await access.resolvePendingGeo({ now: NOW + MINUTE * 5 });
  assert.equal(called, 1, 'a resolved address is never looked up twice');
});

test('a failed lookup is survivable, cached, and leaves geo null', async () => {
  const { access } = store({ geo: true, fetchImpl: async () => { throw new Error('offline'); } });
  access.record({ ip: '203.0.113.9', outcome: 'open', userAgent: CHROME, now: NOW });

  assert.equal(await access.resolvePendingGeo({ now: NOW }), 0, 'never rejects — the operator still gets their log');
  const [row] = access.summary({}).rows;
  assert.equal(row.geo, null, 'unresolved is null, not an empty object: absent is not "located nowhere"');
});

test('geo off means the network is never touched at all', async () => {
  let called = 0;
  const { access } = store({ geo: false, fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) }; } });
  access.record({ ip: '203.0.113.9', outcome: 'open', userAgent: CHROME, now: NOW });
  assert.equal(await access.resolvePendingGeo({ now: NOW }), 0);
  assert.equal(called, 0);
});

// ---- Cost ----

test('reads prepare no statements, however many rows exist', () => {
  const { dir, access } = store();
  for (let i = 0; i < 40; i += 1) {
    access.record({ ip: '10.0.0.' + i, outcome: 'open', userAgent: CHROME, now: NOW + i * MINUTE * 2 });
  }

  const db = getDb(dir);
  const realPrepare = db.prepare.bind(db);
  let prepared = 0;
  db.prepare = (sql) => { prepared += 1; return realPrepare(sql); };
  try {
    access.summary({});
    access.summary({ limit: 500 });
  } finally {
    db.prepare = realPrepare;
  }
  assert.equal(prepared, 0, 'every statement is prepared once at factory time — this endpoint points at production');
});
