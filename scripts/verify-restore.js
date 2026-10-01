#!/usr/bin/env node
// Check that a database restored from the Litestream replica is usable AND recent.
//
// Run by .github/workflows/backup-drill.yml after `litestream restore`, and usable by
// hand after the restore in docs/operations/deployment.md:
//
//   node scripts/verify-restore.js /tmp/drill.db
//
// "Usable" is integrity_check + a non-empty users table. "Recent" is the part that
// matters most: the uptime monitor writes a heartbeat to uptime_state every minute, so
// the restored copy's lastBeat says when replication last delivered a write. A stale
// heartbeat means Litestream stopped shipping changes after boot, which the boot-time
// check in lib/health/backup-status.js cannot see.
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_AGE_HOURS = 24;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: number, maxAgeHours?: number }} [opts]
 * @returns {{ ok: boolean, problems: string[], users: number, lastBeatAgeHours: number | null }}
 */
export function verifyRestore(db, { now = Date.now(), maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  const problems = [];

  const rows = /** @type {{ integrity_check: string }[]} */ (db.pragma('integrity_check'));
  const integrity = rows[0]?.integrity_check;
  if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);

  let users = 0;
  try {
    users = /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) n FROM users').get()).n;
  } catch (err) {
    problems.push(`users table unreadable: ${/** @type {Error} */ (err).message}`);
  }
  if (users === 0 && problems.length === 0) problems.push('users table is empty');

  let lastBeatAgeHours = null;
  try {
    const row = /** @type {{ data: string } | undefined} */ (db.prepare('SELECT data FROM uptime_state WHERE id = 1').get());
    const lastBeat = row ? JSON.parse(row.data).lastBeat : null;
    if (typeof lastBeat !== 'number') {
      problems.push('no uptime heartbeat in the restored copy');
    } else {
      lastBeatAgeHours = (now - lastBeat) / 3_600_000;
      if (lastBeatAgeHours > maxAgeHours) {
        problems.push(`replica is stale: last heartbeat ${lastBeatAgeHours.toFixed(1)}h ago (limit ${maxAgeHours}h)`);
      }
    }
  } catch (err) {
    problems.push(`uptime_state unreadable: ${/** @type {Error} */ (err).message}`);
  }

  return { ok: problems.length === 0, problems, users, lastBeatAgeHours };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/verify-restore.js <restored.db>');
    process.exit(2);
  }
  const maxAgeHours = Number(process.env.MAX_AGE_HOURS) || DEFAULT_MAX_AGE_HOURS;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const r = verifyRestore(db, { maxAgeHours });
  db.close();
  const age = r.lastBeatAgeHours == null ? 'n/a' : `${r.lastBeatAgeHours.toFixed(2)}h`;
  console.log(`users: ${r.users}, last heartbeat: ${age} ago`);
  if (!r.ok) {
    for (const p of r.problems) console.error(`FAIL: ${p}`);
    process.exit(1);
  }
  console.log('restore drill: OK');
}
