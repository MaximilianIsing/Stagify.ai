// A production boot without Litestream must be loud (log + Sentry), while local dev and
// staging, which never replicate by design, must stay quiet. See lib/health/backup-status.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBackupStatus } from '../../lib/health/backup-status.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function harness() {
  const calls = { error: [], info: [], sentry: [] };
  const logger = { error: (m) => calls.error.push(m), info: (m) => calls.info.push(m) };
  const sentry = { captureMessage: (m, level) => calls.sentry.push([m, level]) };
  return { calls, logger, sentry };
}

test('production with replication active logs info and does not alert', () => {
  const { calls, logger, sentry } = harness();
  const s = checkBackupStatus({ env: { RENDER: 'true', LITESTREAM_ACTIVE: '1' }, isStaging: false, logger, sentry });
  assert.deepEqual(s, { active: true, expected: true, reason: null });
  assert.equal(calls.error.length, 0);
  assert.equal(calls.sentry.length, 0);
  assert.equal(calls.info.length, 1);
});

test('production that skipped replication logs an error and reports the reason to Sentry', () => {
  const { calls, logger, sentry } = harness();
  const s = checkBackupStatus({ env: { RENDER: 'true', LITESTREAM_SKIP_REASON: 'r2-credentials-missing' }, isStaging: false, logger, sentry });
  assert.equal(s.active, false);
  assert.equal(s.reason, 'r2-credentials-missing');
  assert.equal(calls.error.length, 1);
  assert.match(calls.error[0], /r2-credentials-missing/);
  assert.equal(calls.sentry.length, 1);
  assert.equal(calls.sentry[0][1], 'error');
});

test('production started without start.sh at all still alerts', () => {
  const { calls, logger, sentry } = harness();
  const s = checkBackupStatus({ env: { RENDER: 'true' }, isStaging: false, logger, sentry });
  assert.equal(s.reason, 'not-started-via-start-sh');
  assert.equal(calls.sentry.length, 1);
});

test('staging and local dev stay quiet', () => {
  for (const [env, isStaging] of [[{ RENDER: 'true' }, true], [{}, false]]) {
    const { calls, logger, sentry } = harness();
    const s = checkBackupStatus({ env, isStaging, logger, sentry });
    assert.equal(s.expected, false);
    assert.equal(calls.error.length + calls.info.length + calls.sentry.length, 0);
  }
});

test('start.sh marks every boot path for the check', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'start.sh'), 'utf8');
  const plainStarts = sh.split('\n').filter((l) => /exec npm start\s*$/.test(l) && !/LITESTREAM_SKIP_REASON=/.test(l));
  // Only the staging branch may exec without a reason: staging is never expected to replicate.
  assert.equal(plainStarts.length, 1, `unmarked boot paths: ${plainStarts.join(' | ')}`);
  assert.match(sh, /export LITESTREAM_ACTIVE=1\s*\nexec "\$LITESTREAM" replicate/);
});
