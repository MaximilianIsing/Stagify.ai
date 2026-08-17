// Self-hosted uptime monitor.
//
// The server records a heartbeat every INTERVAL_MS to a small JSON file on the
// persistent disk (data/uptime.json, or /data/uptime.json on Render). While the
// process runs it is — by definition — up (it is the thing answering requests),
// so uptime is measured the honest way for a single-instance app: on each boot
// we compare "now" against the last persisted heartbeat. A gap larger than
// GAP_THRESHOLD_MS means the process was NOT running for that stretch (a crash,
// a redeploy, or a host outage), and that stretch is recorded as a downtime
// incident. Everything else is counted as up.
//
// Limitation (documented on the page): a server cannot report its own downtime
// while it is down — the outage surfaces on the next boot via the gap. For an
// independently-verified signal, point an external monitor (UptimeRobot, Better
// Stack, Pingdom, …) at GET /health as well.
//
// The pure functions (overlapMs, mergeIncidents, computeWindow, computeBuckets,
// buildSnapshot) take state + a `now` and return a result with no I/O or timers,
// so they are unit-tested deterministically in test/uptime.test.js.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb, closeDb } from './db.js';
import { resolveDataDir } from './data-dir.js';
import { logger } from '../logger.js';

const STATE_VERSION = 1;
export const INTERVAL_MS = 60 * 1000; // heartbeat cadence
export const GAP_THRESHOLD_MS = 3 * INTERVAL_MS; // gap over this on boot = downtime
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // keep 90 days of incidents
const MAX_INCIDENTS = 1000; // hard cap so the file can never grow unbounded
const COALESCE_GAP_MS = 2 * INTERVAL_MS; // merge incidents closer than this

// Operator-written entries (state.manual). Far fewer than heartbeat gaps — these
// are typed by a human — so the cap is small and the retention generous.
const MAX_MANUAL = 200;
const MANUAL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const MANUAL_TITLE_MAX = 200;
// How far either side of now an entry may be dated. Backfilling last week's outage
// and posting next week's maintenance are both real; a typo'd year is not.
const MANUAL_DATE_SLACK_MS = 365 * 24 * 60 * 60 * 1000;

// Windows we report percentages for, and how many bars each graph draws.
export const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
const BUCKETS = { '24h': 48, '7d': 56 }; // graphs shown on the page

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// Milliseconds the interval [aStart,aEnd) shares with [bStart,bEnd).
export function overlapMs(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

// Sort by start and coalesce overlapping / near-adjacent incidents so a burst of
// missed heartbeats reads as one outage rather than many fragments.
export function mergeIncidents(incidents) {
  const valid = (incidents || [])
    .filter((i) => i && Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end, cause: i.cause || 'downtime' }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const inc of valid) {
    const last = out[out.length - 1];
    if (last && inc.start <= last.end + COALESCE_GAP_MS) {
      last.end = Math.max(last.end, inc.end);
    } else {
      out.push({ ...inc });
    }
  }
  return out;
}

// Drop incidents that ended before the retention horizon, then keep only the
// most recent MAX_INCIDENTS.
export function pruneIncidents(incidents, now, retentionMs = RETENTION_MS, maxCount = MAX_INCIDENTS) {
  const horizon = now - retentionMs;
  const kept = mergeIncidents(incidents).filter((i) => i.end >= horizon);
  return kept.length > maxCount ? kept.slice(kept.length - maxCount) : kept;
}

// ── Operator-written incidents ────────────────────────────────────────────
//
// Kept in their own array rather than pushed into `state.incidents`, because that
// array is coalesced: mergeIncidents merges anything within COALESCE_GAP_MS and
// keeps one `cause`, which is right for a burst of missed heartbeats and fatal for
// a sentence someone typed. Separate arrays mean auto-detected downtime still reads
// as one outage while every written entry survives verbatim.
//
// `end: null` means ONGOING — the single most useful thing a status page can say —
// and is why almost everything below takes a `now`.

/**
 * Validate and normalize operator input. Returns `{ ok: false, error }` rather than
 * throwing: every field here is typed by a human into a form, so a bad value is an
 * expected outcome with a message, not an exception.
 *
 * @param {{title?: unknown, start?: unknown, end?: unknown, affectsUptime?: unknown}} input
 * @param {number} now
 * @returns {{ok: true, value: {title: string, start: number, end: number|null, affectsUptime: boolean}} | {ok: false, error: string}}
 */
export function validateManualIncident(input, now = Date.now()) {
  const title = String((input && input.title) || '').trim().replace(/\s+/g, ' ');
  if (!title) return { ok: false, error: 'A title is required.' };
  if (title.length > MANUAL_TITLE_MAX) return { ok: false, error: `Keep the title under ${MANUAL_TITLE_MAX} characters.` };

  const start = input.start == null || input.start === '' ? now : Number(input.start);
  if (!Number.isFinite(start)) return { ok: false, error: 'Start time is not a valid date.' };
  if (Math.abs(start - now) > MANUAL_DATE_SLACK_MS) return { ok: false, error: 'Start time is more than a year from now — check the date.' };

  const rawEnd = input.end == null || input.end === '' ? null : Number(input.end);
  if (rawEnd !== null && !Number.isFinite(rawEnd)) return { ok: false, error: 'End time is not a valid date.' };
  if (rawEnd !== null && rawEnd <= start) return { ok: false, error: 'End time must be after the start time.' };
  if (rawEnd !== null && Math.abs(rawEnd - now) > MANUAL_DATE_SLACK_MS) return { ok: false, error: 'End time is more than a year from now — check the date.' };

  return { ok: true, value: { title, start, end: rawEnd, affectsUptime: !!input.affectsUptime } };
}

/**
 * Every interval that counts as downtime: the auto-detected gaps plus the manual
 * entries flagged `affectsUptime`, merged together.
 *
 * Merging the two lists is what stops double counting when someone logs an outage
 * the heartbeat also caught. An ongoing entry is clamped to `now`, and to at least a
 * millisecond long — mergeIncidents drops zero-length intervals, so an incident
 * opened this instant would otherwise vanish from the maths until a minute passed.
 *
 * @param {{incidents?: any[], manual?: any[]}} state
 * @param {number} now
 */
export function downtimeIntervals(state, now) {
  const manual = (state.manual || [])
    .filter((m) => m && m.affectsUptime)
    .map((m) => ({ start: m.start, end: Math.max(m.end == null ? now : m.end, m.start + 1), cause: m.title }));
  return mergeIncidents([...(state.incidents || []), ...manual]);
}

/** Drop manual entries past retention, keeping the newest. Ongoing ones never expire. */
export function pruneManual(manual, now, retentionMs = MANUAL_RETENTION_MS, maxCount = MAX_MANUAL) {
  const horizon = now - retentionMs;
  const kept = (manual || []).filter((m) => m && (m.end == null || m.end >= horizon));
  return kept.length > maxCount ? kept.slice(kept.length - maxCount) : kept;
}

// Uptime over the trailing `windowMs`. Percentages are computed over the portion
// of the window we actually monitored (from monitoringStart onward), so a fresh
// monitor doesn't claim 100% for days it never observed. `uptimePct` is null when
// there is no coverage yet.
export function computeWindow(incidents, monitoringStart, now, windowMs) {
  const windowStart = now - windowMs;
  const monStart = monitoringStart == null ? null : Math.max(windowStart, monitoringStart);
  const monitoredMs = monStart == null ? 0 : Math.max(0, now - monStart);
  let downMs = 0;
  let touched = 0;
  if (monStart != null) {
    for (const inc of incidents) {
      const o = overlapMs(inc.start, inc.end, monStart, now);
      if (o > 0) {
        downMs += o;
        touched += 1;
      }
    }
  }
  downMs = Math.min(downMs, monitoredMs);
  const uptimePct = monitoredMs > 0 ? round(100 * (1 - downMs / monitoredMs), 3) : null;
  return {
    uptimePct,
    downMs,
    monitoredMs,
    coverage: round(windowMs > 0 ? monitoredMs / windowMs : 0, 4),
    incidents: touched,
  };
}

function bucketState(monitoredMs, downMs) {
  if (monitoredMs <= 0) return { state: 'nodata', uptimePct: null };
  const upFrac = 1 - downMs / monitoredMs;
  const uptimePct = round(100 * upFrac, 2);
  let state = 'partial';
  if (upFrac >= 0.9999) state = 'up';
  else if (upFrac <= 0.0001) state = 'down';
  return { state, uptimePct };
}

// Split the trailing `windowMs` into `bucketCount` equal bars, each classified
// up / partial / down / nodata for the status-page graph.
export function computeBuckets(incidents, monitoringStart, now, windowMs, bucketCount) {
  const windowStart = now - windowMs;
  const bucketMs = windowMs / bucketCount;
  const out = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const bStart = windowStart + i * bucketMs;
    const bEnd = bStart + bucketMs;
    const monStart = monitoringStart == null ? null : Math.max(bStart, monitoringStart);
    const monEnd = Math.min(bEnd, now);
    const monitoredMs = monStart == null ? 0 : Math.max(0, monEnd - monStart);
    let downMs = 0;
    if (monitoredMs > 0) {
      for (const inc of incidents) downMs += overlapMs(inc.start, inc.end, monStart, monEnd);
      downMs = Math.min(downMs, monitoredMs);
    }
    out.push({ start: bStart, end: bEnd, monitoredMs, downMs, ...bucketState(monitoredMs, downMs) });
  }
  return out;
}

// Compose the full object returned by GET /api/uptime. Pure given state + now.
export function buildSnapshot(state, now, opts = {}) {
  const intervalMs = opts.intervalMs || INTERVAL_MS;
  const auto = mergeIncidents(state.incidents || []);
  const manual = state.manual || [];
  // The percentages come from the MERGED set (auto + the manual entries flagged as
  // downtime); the list below reports the two separately, so an operator's wording
  // is never coalesced away and an overlap is never counted twice.
  const downs = downtimeIntervals(state, now);
  const monitoringStart = state.monitoringStart ?? null;
  const lastBeat = state.lastBeat ?? null;
  // Are we mid-outage right now? Either the last heartbeat is stale — which, for a
  // response we are actively serving, it isn't — or a human has said so and not yet
  // marked it resolved. The second is the only way this page can report an outage
  // the process itself survived: a dead upstream, a broken deploy, a bad key.
  const stale = lastBeat != null && now - lastBeat > GAP_THRESHOLD_MS;
  const liveOutage = manual.some((m) => m.end == null && m.affectsUptime);

  const windows = {};
  for (const [key, ms] of Object.entries(WINDOWS)) {
    windows[key] = computeWindow(downs, monitoringStart, now, ms);
  }
  const buckets = {};
  for (const [key, count] of Object.entries(BUCKETS)) {
    buckets[key] = computeBuckets(downs, monitoringStart, now, WINDOWS[key], count);
  }

  const recentIncidents = mergeFeeds(auto, manual, now).slice(0, 25);

  return {
    generatedAt: now,
    status: stale || liveOutage ? 'degraded' : 'operational',
    currentState: stale || liveOutage ? 'down' : 'up',
    monitoringSince: monitoringStart,
    lastBeat,
    lastCheckedMsAgo: lastBeat == null ? null : Math.max(0, now - lastBeat),
    bootCount: state.bootCount || 0,
    intervalMs,
    windows,
    buckets,
    incidents: recentIncidents,
    totalIncidents: auto.length + manual.length,
  };
}

/**
 * The public incident feed: both sources in one list, newest first.
 *
 * `cause` carries the operator's title for a manual entry, which is the whole reason
 * public/scripts/status.js needs no special case to display one — it already renders
 * `cause` for auto entries. `ongoing` and `source` are additive, so an older client
 * that ignores them still shows something correct.
 *
 * @param {{start: number, end: number, cause?: string}[]} auto
 * @param {any[]} manual
 * @param {number} now
 */
export function mergeFeeds(auto, manual, now) {
  const fromAuto = auto.map((i) => ({
    source: 'auto',
    start: i.start,
    end: i.end,
    durationMs: i.end - i.start,
    cause: i.cause,
    ongoing: false,
    affectsUptime: true,
  }));
  const fromManual = (manual || []).map((m) => ({
    id: m.id,
    source: 'manual',
    start: m.start,
    end: m.end,
    // An ongoing incident's duration is "so far", which is what a reader wants from
    // it — and what stops the UI printing NaN against a null end.
    durationMs: Math.max(0, (m.end == null ? now : m.end) - m.start),
    cause: m.title,
    ongoing: m.end == null,
    affectsUptime: !!m.affectsUptime,
    createdAt: m.createdAt,
  }));
  // Ongoing first (it is the live news), then newest by start.
  return [...fromAuto, ...fromManual].sort((a, b) => {
    if (a.ongoing !== b.ongoing) return a.ongoing ? -1 : 1;
    return b.start - a.start;
  });
}

function defaultState() {
  return { version: STATE_VERSION, monitoringStart: null, lastBeat: null, bootCount: 0, incidents: [], manual: [] };
}

// resolveDataDir already falls back to baseDir if it cannot create data/, so the
// join below covers the old explicit fallback too.
function resolveStorePath(baseDir) {
  return path.join(resolveDataDir(baseDir), 'uptime.json');
}

/**
 * Create the uptime monitor. Construction only reads existing state (no writes,
 * no timers) so it is safe to instantiate anywhere; call start() to begin the
 * heartbeat loop and record any downtime gap since the last run.
 */
export function createUptimeMonitor(baseDir, options = {}) {
  const intervalMs = options.intervalMs || INTERVAL_MS;
  const gapThresholdMs = options.gapThresholdMs || GAP_THRESHOLD_MS;
  const legacyJsonPath = options.filePath || resolveStorePath(baseDir);
  const db = getDb(baseDir);
  db.exec('CREATE TABLE IF NOT EXISTS uptime_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
  const readRow = db.prepare('SELECT data FROM uptime_state WHERE id = 1');
  const writeRow = db.prepare(
    'INSERT INTO uptime_state (id, data) VALUES (1, @data) ON CONFLICT(id) DO UPDATE SET data = @data'
  );
  let state = load();
  let timer = null;

  function parseState(raw) {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
      // Absent in every row written before manual entries existed, so this is also
      // the migration: an old blob simply reads back with an empty list.
      manual: Array.isArray(parsed.manual) ? parsed.manual : [],
    };
  }

  // Load persisted state from the DB row. On first run (no row) fall back to
  // importing a legacy uptime.json if present; otherwise start fresh. Once a row
  // exists it is the sole source of truth (the JSON is never read again).
  function load() {
    try {
      const row = readRow.get();
      if (row && row.data) return parseState(row.data);
      if (fs.existsSync(legacyJsonPath)) {
        const raw = fs.readFileSync(legacyJsonPath, 'utf8').trim();
        if (raw) return parseState(raw);
      }
      return defaultState();
    } catch {
      return defaultState();
    }
  }

  function save() {
    try {
      writeRow.run({ data: JSON.stringify(state) });
    } catch (err) {
      // Never let a status-tracking write take the server down.
      logger.error('[uptime] Failed to persist state:', err.message);
    }
  }

  function start(now = Date.now()) {
    state = load();
    // A large gap since the last heartbeat means we were down in between.
    if (state.lastBeat != null && now - state.lastBeat > gapThresholdMs) {
      state.incidents.push({
        start: state.lastBeat,
        end: now,
        cause: 'downtime detected on restart (missed heartbeats)',
      });
    }
    if (state.monitoringStart == null) state.monitoringStart = now;
    state.bootCount = (state.bootCount || 0) + 1;
    state.lastBeat = now;
    state.incidents = pruneIncidents(state.incidents, now);
    save();

    if (timer) clearInterval(timer);
    timer = setInterval(beat, intervalMs);
    // Don't keep the process (or `node --test`) alive just for the heartbeat.
    timer.unref?.();
    return api;
  }

  function beat(now = Date.now()) {
    state.lastBeat = now;
    save();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Wipe all recorded history and start monitoring fresh from `now` (admin action).
  // The heartbeat timer, if running, keeps beating — monitoring simply restarts here.
  // This takes the operator-written entries with it, which is what "wipe all recorded
  // uptime history and incidents" says; the admin button's copy spells that out.
  function reset(now = Date.now()) {
    state = { version: STATE_VERSION, monitoringStart: now, lastBeat: now, bootCount: 1, incidents: [], manual: [] };
    save();
    return getSnapshot(now);
  }

  function getSnapshot(now = Date.now()) {
    return buildSnapshot(state, now, { intervalMs });
  }

  // ── Operator-written incidents ──

  /**
   * Post an incident. Returns the same `{ok, error}` shape the validator does, so a
   * route can hand the message straight to whoever typed it.
   * @param {{title?: unknown, start?: unknown, end?: unknown, affectsUptime?: unknown}} input
   */
  function addIncident(input, now = Date.now()) {
    const checked = validateManualIncident(input, now);
    if (!checked.ok) return checked;
    const entry = { id: crypto.randomBytes(8).toString('hex'), ...checked.value, createdAt: now };
    state.manual = pruneManual([...(state.manual || []), entry], now);
    save();
    return { ok: true, incident: entry };
  }

  /** Close an ongoing incident at `now`. Already-resolved ones are left alone. */
  function resolveIncident(id, now = Date.now()) {
    const entry = (state.manual || []).find((m) => m.id === id);
    if (!entry) return { ok: false, error: 'No such incident.' };
    if (entry.end != null) return { ok: true, incident: entry };
    // Guard the degenerate case: an incident opened and resolved inside the same
    // millisecond would otherwise be zero-length and drop out of the maths.
    entry.end = Math.max(now, entry.start + 1);
    save();
    return { ok: true, incident: entry };
  }

  function deleteIncident(id) {
    const before = (state.manual || []).length;
    state.manual = (state.manual || []).filter((m) => m.id !== id);
    if (state.manual.length === before) return { ok: false, error: 'No such incident.' };
    save();
    return { ok: true };
  }

  /**
   * Everything the public snapshot has, plus what only an operator needs: the 30-day
   * graph, the manual entries as their own list (the public feed interleaves them),
   * and the monitor's own configuration. The public payload is deliberately left
   * alone — it is fetched by every visitor to /status, on a timer.
   */
  function getAdminSnapshot(now = Date.now()) {
    const snapshot = getSnapshot(now);
    const downs = downtimeIntervals(state, now);
    return {
      ...snapshot,
      buckets: {
        ...snapshot.buckets,
        '30d': computeBuckets(downs, state.monitoringStart ?? null, now, WINDOWS['30d'], 60),
      },
      manual: mergeFeeds([], state.manual || [], now),
      autoIncidents: mergeIncidents(state.incidents || [])
        .slice(-100)
        .reverse()
        .map((i) => ({ start: i.start, end: i.end, durationMs: i.end - i.start, cause: i.cause })),
      config: {
        intervalMs,
        gapThresholdMs,
        retentionDays: Math.round(RETENTION_MS / (24 * 60 * 60 * 1000)),
        maxIncidents: MAX_INCIDENTS,
        titleMaxLength: MANUAL_TITLE_MAX,
        storePath: db.name,
      },
    };
  }

  const api = {
    start,
    stop,
    beat,
    reset,
    getSnapshot,
    getAdminSnapshot,
    addIncident,
    resolveIncident,
    deleteIncident,
    getStateFilePath: () => db.name,
    _getState: () => state,
    close: () => {
      stop();
      closeDb(baseDir);
    },
  };
  return api;
}
