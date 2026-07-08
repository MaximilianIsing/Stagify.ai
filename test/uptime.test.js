// Unit tests for the uptime monitor's pure math (no fs, no timers, no network).
// These guard the numbers the /uptime page shows: window percentages, coverage,
// graph-bucket classification, and incident coalescing/pruning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  overlapMs,
  mergeIncidents,
  pruneIncidents,
  computeWindow,
  computeBuckets,
  buildSnapshot,
  GAP_THRESHOLD_MS,
} from '../lib/data/uptime-monitor.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

test('overlapMs measures intersection length', () => {
  assert.equal(overlapMs(0, 100, 50, 200), 50); // partial
  assert.equal(overlapMs(0, 100, 200, 300), 0); // disjoint
  assert.equal(overlapMs(10, 90, 0, 100), 80); // contained
  assert.equal(overlapMs(0, 100, 100, 200), 0); // touching = no overlap
});

test('mergeIncidents coalesces overlapping and near-adjacent outages', () => {
  const merged = mergeIncidents([
    { start: NOW - 10 * HOUR, end: NOW - 9 * HOUR },
    { start: NOW - 9 * HOUR + 1000, end: NOW - 8 * HOUR }, // overlaps previous
    { start: NOW - 2 * HOUR, end: NOW - 1 * HOUR }, // far apart -> separate
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].start, NOW - 10 * HOUR);
  assert.equal(merged[0].end, NOW - 8 * HOUR);
});

test('mergeIncidents drops invalid entries', () => {
  const merged = mergeIncidents([
    { start: NOW, end: NOW - HOUR }, // end before start
    { start: NOW - HOUR }, // missing end
    null,
    { start: NOW - 3 * HOUR, end: NOW - 2 * HOUR }, // valid
  ]);
  assert.equal(merged.length, 1);
});

test('pruneIncidents keeps only incidents within retention', () => {
  const kept = pruneIncidents(
    [
      { start: NOW - 200 * DAY, end: NOW - 200 * DAY + HOUR }, // older than 90d
      { start: NOW - 5 * DAY, end: NOW - 5 * DAY + HOUR }, // recent
    ],
    NOW,
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].start, NOW - 5 * DAY);
});

test('computeWindow reports 100% with no incidents and full coverage', () => {
  const w = computeWindow([], NOW - 2 * DAY, NOW, DAY);
  assert.equal(w.uptimePct, 100);
  assert.equal(w.downMs, 0);
  assert.equal(w.monitoredMs, DAY);
  assert.equal(w.coverage, 1);
});

test('computeWindow subtracts a 1h outage from a 24h window', () => {
  const incidents = [{ start: NOW - 5 * HOUR, end: NOW - 4 * HOUR }];
  const w = computeWindow(incidents, NOW - 2 * DAY, NOW, DAY);
  assert.equal(w.downMs, HOUR);
  assert.equal(w.uptimePct, 95.833); // (24-1)/24 -> 95.8333, rounded to 3dp
  assert.equal(w.incidents, 1);
});

test('computeWindow only counts monitored time (partial coverage)', () => {
  // Monitoring started 12h ago; a 24h window is only half covered.
  const w = computeWindow([], NOW - 12 * HOUR, NOW, DAY);
  assert.equal(w.monitoredMs, 12 * HOUR);
  assert.equal(w.coverage, 0.5);
  assert.equal(w.uptimePct, 100); // over the covered half, no downtime
});

test('computeWindow returns null uptime when nothing was monitored', () => {
  const w = computeWindow([], null, NOW, DAY);
  assert.equal(w.uptimePct, null);
  assert.equal(w.monitoredMs, 0);
});

test('computeWindow clamps overlapping incidents to the monitored duration', () => {
  // A giant incident longer than the window can never push uptime below 0.
  const incidents = [{ start: NOW - 10 * DAY, end: NOW }];
  const w = computeWindow(incidents, NOW - 30 * DAY, NOW, DAY);
  assert.equal(w.downMs, DAY);
  assert.equal(w.uptimePct, 0);
});

test('computeBuckets classifies up / down / partial / nodata', () => {
  const monitoringStart = NOW - 2 * DAY; // full coverage of a 24h window
  // Outage that exactly fills hourly bucket #5, plus half of bucket #10.
  const windowStart = NOW - DAY;
  const incidents = [
    { start: windowStart + 5 * HOUR, end: windowStart + 6 * HOUR }, // fills bucket 5
    { start: windowStart + 10 * HOUR, end: windowStart + 10.5 * HOUR }, // half of bucket 10
  ];
  const buckets = computeBuckets(incidents, monitoringStart, NOW, DAY, 24);
  assert.equal(buckets.length, 24);
  assert.equal(buckets[5].state, 'down');
  assert.equal(buckets[5].uptimePct, 0);
  assert.equal(buckets[10].state, 'partial');
  assert.equal(buckets[10].uptimePct, 50);
  assert.equal(buckets[0].state, 'up');
  assert.equal(buckets[23].state, 'up');
});

test('computeBuckets marks pre-monitoring buckets as nodata', () => {
  // Only the last 10h were monitored; earlier hourly buckets have no data.
  const buckets = computeBuckets([], NOW - 10 * HOUR, NOW, DAY, 24);
  assert.equal(buckets[0].state, 'nodata');
  assert.equal(buckets[0].uptimePct, null);
  assert.equal(buckets[23].state, 'up'); // most recent hour is monitored
});

test('buildSnapshot returns windows, sized graph buckets, and operational status', () => {
  const state = {
    monitoringStart: NOW - 10 * DAY,
    lastBeat: NOW - 5000, // fresh heartbeat
    bootCount: 3,
    incidents: [{ start: NOW - 2 * HOUR, end: NOW - 2 * HOUR + 5 * 60 * 1000 }],
  };
  const snap = buildSnapshot(state, NOW);
  assert.equal(snap.status, 'operational');
  assert.equal(snap.currentState, 'up');
  assert.ok(snap.windows['24h'] && snap.windows['7d'] && snap.windows['30d']);
  assert.equal(snap.buckets['24h'].length, 48);
  assert.equal(snap.buckets['7d'].length, 56);
  assert.equal(snap.bootCount, 3);
  assert.equal(snap.totalIncidents, 1);
  assert.equal(snap.incidents[0].durationMs, 5 * 60 * 1000);
});

test('buildSnapshot flags degraded when the heartbeat is stale', () => {
  const state = {
    monitoringStart: NOW - 10 * DAY,
    lastBeat: NOW - (GAP_THRESHOLD_MS + 60 * 1000),
    bootCount: 1,
    incidents: [],
  };
  const snap = buildSnapshot(state, NOW);
  assert.equal(snap.status, 'degraded');
  assert.equal(snap.currentState, 'down');
});
