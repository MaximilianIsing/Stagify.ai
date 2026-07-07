// Covers the admin "reset server status" action — uptimeMonitor.reset(). Runs
// against a throwaway temp dir so it never touches real uptime data.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUptimeMonitor } from '../lib/uptime-monitor.js';

const tempDirs = [];
function freshMonitor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-uptime-'));
  tempDirs.push(dir);
  return createUptimeMonitor(dir);
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('reset() wipes all history and restarts monitoring from now', () => {
  const mon = freshMonitor();

  // Build up history: boot in the past, then boot again after a long gap so the
  // monitor records a downtime incident for the stretch it wasn't running.
  const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
  mon.start(past);
  mon.start(Date.now());
  mon.stop();
  assert.ok(mon.getSnapshot().totalIncidents > 0, 'precondition: there is history before reset');

  const now = Date.now();
  const snap = mon.reset(now);

  assert.equal(snap.totalIncidents, 0, 'no incidents after reset');
  assert.equal(snap.monitoringSince, now, 'monitoring restarts at now');
  assert.deepEqual(snap.incidents, [], 'the incident list is cleared');

  // And the wipe is persisted, not just in-memory.
  const state = JSON.parse(fs.readFileSync(mon.getStateFilePath(), 'utf8'));
  assert.equal(state.incidents.length, 0, 'persisted state has no incidents');
  assert.equal(state.monitoringStart, now, 'persisted monitoringStart is now');
});
