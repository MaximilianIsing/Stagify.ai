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

import fs from 'fs';
import path from 'path';

const STATE_VERSION = 1;
export const INTERVAL_MS = 60 * 1000; // heartbeat cadence
export const GAP_THRESHOLD_MS = 3 * INTERVAL_MS; // gap over this on boot = downtime
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // keep 90 days of incidents
const MAX_INCIDENTS = 1000; // hard cap so the file can never grow unbounded
const COALESCE_GAP_MS = 2 * INTERVAL_MS; // merge incidents closer than this

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
  const incidents = mergeIncidents(state.incidents || []);
  const monitoringStart = state.monitoringStart ?? null;
  const lastBeat = state.lastBeat ?? null;
  // Are we mid-outage right now? Only if the last heartbeat is stale — which, for
  // a response we are actively serving, it isn't. Kept for completeness/clarity.
  const stale = lastBeat != null && now - lastBeat > GAP_THRESHOLD_MS;

  const windows = {};
  for (const [key, ms] of Object.entries(WINDOWS)) {
    windows[key] = computeWindow(incidents, monitoringStart, now, ms);
  }
  const buckets = {};
  for (const [key, count] of Object.entries(BUCKETS)) {
    buckets[key] = computeBuckets(incidents, monitoringStart, now, WINDOWS[key], count);
  }

  const recentIncidents = incidents
    .slice(-25)
    .reverse()
    .map((i) => ({ start: i.start, end: i.end, durationMs: i.end - i.start, cause: i.cause }));

  return {
    generatedAt: now,
    status: stale ? 'degraded' : 'operational',
    currentState: stale ? 'down' : 'up',
    monitoringSince: monitoringStart,
    lastBeat,
    lastCheckedMsAgo: lastBeat == null ? null : Math.max(0, now - lastBeat),
    bootCount: state.bootCount || 0,
    intervalMs,
    windows,
    buckets,
    incidents: recentIncidents,
    totalIncidents: incidents.length,
  };
}

function defaultState() {
  return { version: STATE_VERSION, monitoringStart: null, lastBeat: null, bootCount: 0, incidents: [] };
}

function resolveStorePath(baseDir) {
  const dir = process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(baseDir, 'data');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return path.join(baseDir, 'uptime.json');
    }
  }
  return path.join(dir, 'uptime.json');
}

/**
 * Create the uptime monitor. Construction only reads existing state (no writes,
 * no timers) so it is safe to instantiate anywhere; call start() to begin the
 * heartbeat loop and record any downtime gap since the last run.
 */
export function createUptimeMonitor(baseDir, options = {}) {
  const intervalMs = options.intervalMs || INTERVAL_MS;
  const gapThresholdMs = options.gapThresholdMs || GAP_THRESHOLD_MS;
  const filePath = options.filePath || resolveStorePath(baseDir);
  let state = load();
  let timer = null;

  function load() {
    try {
      if (!fs.existsSync(filePath)) return defaultState();
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
      };
    } catch {
      return defaultState();
    }
  }

  function save() {
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      // Never let a status-tracking write take the server down.
      console.error('[uptime] Failed to persist state:', err.message);
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

  function getSnapshot(now = Date.now()) {
    return buildSnapshot(state, now, { intervalMs });
  }

  const api = { start, stop, beat, getSnapshot, getStateFilePath: () => filePath, _getState: () => state };
  return api;
}
