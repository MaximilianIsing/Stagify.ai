// Operator-written incidents — the half of the status page a heartbeat cannot see.
//
// WHY THIS EXISTS. The monitor infers downtime from missed heartbeats, so it only
// ever learns that the PROCESS died. An outage the process survived — a dead
// upstream model, a bad deploy, an expired key — is invisible to it, and the page
// happily reports 100% through the whole thing. Manual entries are how that gets
// told, which makes them load-bearing for the one number the page exists to publish.
//
// The three things most likely to break, and the reason each is here:
//   - manual entries must NOT go through mergeIncidents. That function coalesces
//     anything within two heartbeats and keeps a single `cause`, which is correct
//     for a burst of missed beats and destroys a sentence someone typed,
//   - an entry flagged `affectsUptime` must move the percentages, and must not
//     double-count when it overlaps a gap the heartbeat already recorded,
//   - `end: null` means ongoing, and ongoing has to survive the arithmetic — a
//     zero-length or null-ended interval silently drops out of every window.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUptimeMonitor, buildSnapshot, downtimeIntervals, mergeFeeds,
  validateManualIncident, pruneManual, MANUAL_TITLE_MAX,
} from '../../lib/data/uptime-monitor.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const tempDirs = [];
const openMonitors = [];
function newDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-uptime-inc-'));
  tempDirs.push(dir);
  return dir;
}
function monitor() {
  const mon = createUptimeMonitor(newDir());
  openMonitors.push(mon);
  return mon;
}
afterEach(() => {
  while (openMonitors.length) {
    try { openMonitors.pop().close(); } catch { /* already closed */ }
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// ---- Validation ------------------------------------------------------------

test('a title is required, trimmed, and length-capped', () => {
  const now = Date.now();
  assert.equal(validateManualIncident({ title: '   ' }, now).ok, false);
  assert.equal(validateManualIncident({}, now).ok, false);
  assert.equal(validateManualIncident({ title: 'x'.repeat(MANUAL_TITLE_MAX + 1) }, now).ok, false);

  const ok = validateManualIncident({ title: '  Renders   failing  ' }, now);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.title, 'Renders failing', 'whitespace runs collapse, so the list stays tidy');
});

test('an omitted start means now, and an omitted end means ongoing', () => {
  const now = 1_800_000_000_000;
  const { value } = validateManualIncident({ title: 'Upstream outage' }, now);
  assert.equal(value.start, now);
  assert.equal(value.end, null, 'no end is ONGOING, not "ended at the same instant"');
  assert.equal(value.affectsUptime, false, 'and it does not silently count as downtime');
});

test('an end before its start is refused, with a message for the person typing it', () => {
  const now = Date.now();
  const bad = validateManualIncident({ title: 'Outage', start: now, end: now - HOUR }, now);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /after the start/i);
});

test('a date more than a year out is refused — that is a typo, not a backfill', () => {
  const now = Date.now();
  assert.equal(validateManualIncident({ title: 'x', start: now - 400 * DAY }, now).ok, false);
  assert.equal(validateManualIncident({ title: 'x', start: now + 400 * DAY }, now).ok, false);
  // Both directions inside the window are legitimate: backfilling last week's
  // outage, and posting next week's maintenance.
  assert.equal(validateManualIncident({ title: 'x', start: now - 7 * DAY }, now).ok, true);
  assert.equal(validateManualIncident({ title: 'x', start: now + 7 * DAY }, now).ok, true);
});

test('a non-numeric date is refused rather than becoming NaN downstream', () => {
  const now = Date.now();
  assert.equal(validateManualIncident({ title: 'x', start: 'tomorrow' }, now).ok, false);
  assert.equal(validateManualIncident({ title: 'x', end: 'later' }, now).ok, false);
});

// ---- The uptime maths ------------------------------------------------------

test('an entry flagged affectsUptime subtracts from the percentage; a notice does not', () => {
  const now = 1_800_000_000_000;
  const base = { incidents: [], monitoringStart: now - 10 * DAY, lastBeat: now };

  const withNotice = buildSnapshot({
    ...base,
    manual: [{ id: 'a', title: 'Scheduled maintenance', start: now - 2 * HOUR, end: now - HOUR, affectsUptime: false }],
  }, now);
  assert.equal(withNotice.windows['24h'].uptimePct, 100, 'a notice must not dent the figure');
  assert.equal(withNotice.windows['24h'].downMs, 0);

  const withOutage = buildSnapshot({
    ...base,
    manual: [{ id: 'a', title: 'Upstream outage', start: now - 2 * HOUR, end: now - HOUR, affectsUptime: true }],
  }, now);
  assert.equal(withOutage.windows['24h'].downMs, HOUR);
  assert.ok(withOutage.windows['24h'].uptimePct < 96, 'an hour out of 24 is a visible dent');
});

test('an ongoing outage counts up to now, and flips the page to a disruption', () => {
  const now = 1_800_000_000_000;
  const snap = buildSnapshot({
    incidents: [], monitoringStart: now - 10 * DAY, lastBeat: now,
    manual: [{ id: 'a', title: 'Investigating slow renders', start: now - 30 * 60 * 1000, end: null, affectsUptime: true }],
  }, now);

  assert.equal(snap.windows['24h'].downMs, 30 * 60 * 1000, 'an ongoing incident counts up to now');
  assert.equal(snap.currentState, 'down');
  assert.equal(snap.status, 'degraded',
    'the public banner reads currentState — an unresolved outage must not say "operational"');
});

test('an ongoing NOTICE does not flip the banner', () => {
  const now = 1_800_000_000_000;
  const snap = buildSnapshot({
    incidents: [], monitoringStart: now - 10 * DAY, lastBeat: now,
    manual: [{ id: 'a', title: 'Maintenance window tonight', start: now - HOUR, end: null, affectsUptime: false }],
  }, now);
  assert.equal(snap.currentState, 'up', 'a notice is information, not an outage');
});

test('an incident opened this instant still registers, rather than being zero-length', () => {
  const now = 1_800_000_000_000;
  const state = {
    incidents: [], monitoringStart: now - DAY, lastBeat: now,
    manual: [{ id: 'a', title: 'Just started', start: now, end: null, affectsUptime: true }],
  };
  assert.equal(downtimeIntervals(state, now).length, 1,
    'mergeIncidents drops zero-length intervals, so a brand-new incident needs its floor');
});

test('an overlap with a detected gap is not counted twice', () => {
  const now = 1_800_000_000_000;
  // The heartbeat caught an hour of it; the operator logged two hours covering it.
  const snap = buildSnapshot({
    incidents: [{ start: now - 3 * HOUR, end: now - 2 * HOUR, cause: 'downtime detected on restart (missed heartbeats)' }],
    monitoringStart: now - 10 * DAY,
    lastBeat: now,
    manual: [{ id: 'a', title: 'Deploy gone wrong', start: now - 3 * HOUR, end: now - HOUR, affectsUptime: true }],
  }, now);

  assert.equal(snap.windows['24h'].downMs, 2 * HOUR,
    'the union is two hours; adding the lists instead of merging them would report three');
});

// ---- The feed --------------------------------------------------------------

test('a written title is never coalesced away by the heartbeat merger', () => {
  const now = 1_800_000_000_000;
  // Two entries a minute apart: mergeIncidents would fuse these into one and keep a
  // single cause. They are separate rows in the feed because they never go through it.
  const snap = buildSnapshot({
    incidents: [], monitoringStart: now - DAY, lastBeat: now,
    manual: [
      { id: 'a', title: 'First thing', start: now - 3 * HOUR, end: now - 2.9 * HOUR, affectsUptime: true },
      { id: 'b', title: 'Second thing', start: now - 2.89 * HOUR, end: now - 2.8 * HOUR, affectsUptime: true },
    ],
  }, now);

  const titles = snap.incidents.map((i) => i.cause);
  assert.ok(titles.includes('First thing') && titles.includes('Second thing'),
    'both sentences must survive; coalescing them would silently delete one');
});

test('the feed carries what the public page needs to render an entry unchanged', () => {
  const now = 1_800_000_000_000;
  const snap = buildSnapshot({
    incidents: [], monitoringStart: now - DAY, lastBeat: now,
    manual: [{ id: 'a', title: 'Upstream outage', start: now - HOUR, end: null, affectsUptime: true }],
  }, now);

  const [entry] = snap.incidents;
  // `cause` specifically: status.js already renders that field for auto entries, so
  // reusing the name is what lets a posted incident display with no client change.
  assert.equal(entry.cause, 'Upstream outage');
  assert.equal(entry.ongoing, true);
  assert.equal(entry.source, 'manual');
  assert.equal(entry.durationMs, HOUR, 'an ongoing entry reports elapsed-so-far, never NaN');
});

test('the feed puts ongoing entries first, then newest by start', () => {
  const now = 1_800_000_000_000;
  const feed = mergeFeeds(
    [{ start: now - HOUR, end: now - 30 * 60 * 1000, cause: 'detected' }],
    [
      { id: 'old', title: 'Old news', start: now - 5 * DAY, end: now - 5 * DAY + HOUR, affectsUptime: true },
      { id: 'live', title: 'Happening now', start: now - 2 * DAY, end: null, affectsUptime: true },
    ],
    now,
  );
  assert.equal(feed[0].cause, 'Happening now', 'the live one leads, whatever its start');
  assert.deepEqual(feed.slice(1).map((f) => f.cause), ['detected', 'Old news']);
});

test('pruning keeps ongoing entries forever and drops stale resolved ones', () => {
  const now = Date.now();
  const kept = pruneManual([
    { id: 'a', title: 'Ancient but unresolved', start: now - 800 * DAY, end: null },
    { id: 'b', title: 'Ancient and resolved', start: now - 800 * DAY, end: now - 799 * DAY },
    { id: 'c', title: 'Recent', start: now - DAY, end: now },
  ], now);

  assert.deepEqual(kept.map((k) => k.id), ['a', 'c'],
    'an unresolved incident has no end to age out on — dropping it would hide a live outage');
});

// ---- The store -------------------------------------------------------------

test('add → resolve → delete, persisted across a reload of the state', () => {
  const mon = monitor();
  mon.start();

  const added = mon.addIncident({ title: 'Renders failing', affectsUptime: true });
  assert.equal(added.ok, true);
  assert.match(added.incident.id, /^[0-9a-f]{16}$/);
  assert.equal(added.incident.end, null);

  let snap = mon.getAdminSnapshot();
  assert.equal(snap.currentState, 'down', 'an unresolved outage shows on the status immediately');
  assert.equal(snap.manual.length, 1);

  mon.resolveIncident(added.incident.id);
  snap = mon.getAdminSnapshot();
  assert.equal(snap.manual[0].ongoing, false);
  assert.equal(snap.currentState, 'up', 'resolving it clears the disruption');

  assert.equal(mon.deleteIncident(added.incident.id).ok, true);
  assert.equal(mon.getAdminSnapshot().manual.length, 0);
});

test('resolving or deleting something that is not there is a 404, not a crash', () => {
  const mon = monitor();
  mon.start();
  assert.equal(mon.resolveIncident('nope').ok, false);
  assert.equal(mon.deleteIncident('nope').ok, false);
});

test('a rejected post writes nothing', () => {
  const mon = monitor();
  mon.start();
  const bad = mon.addIncident({ title: '' });
  assert.equal(bad.ok, false);
  assert.equal(mon.getAdminSnapshot().manual.length, 0);
});

test('reset() clears posted incidents too — the button says it wipes everything', () => {
  const mon = monitor();
  mon.start();
  mon.addIncident({ title: 'Something happened', affectsUptime: true });
  assert.equal(mon.getAdminSnapshot().manual.length, 1);

  mon.reset();
  assert.equal(mon.getAdminSnapshot().manual.length, 0,
    'leaving posted entries behind would contradict the confirm dialog');
});

test('a state row written before manual entries existed reads back clean', () => {
  const mon = monitor();
  mon.start();
  // Exactly what an older build persisted: no `manual` key at all.
  const state = mon._getState();
  delete state.manual;
  assert.doesNotThrow(() => mon.getAdminSnapshot());
  assert.deepEqual(mon.getAdminSnapshot().manual, []);
});

test('the admin snapshot carries the depth the public one deliberately does not', () => {
  const mon = monitor();
  mon.start();

  const pub = mon.getSnapshot();
  const adm = mon.getAdminSnapshot();

  assert.equal(pub.buckets['30d'], undefined, 'the public payload stays at two graphs');
  assert.ok(Array.isArray(adm.buckets['30d']), 'the admin one adds the third window');
  assert.equal(adm.buckets['30d'].length, 60);
  assert.ok(adm.config.intervalMs > 0);
  assert.ok(adm.config.gapThresholdMs > adm.config.intervalMs);
  assert.ok(adm.config.storePath, 'where the state lives is an operator question');
  assert.ok(Array.isArray(adm.autoIncidents), 'and the two feeds are also available apart');
});
