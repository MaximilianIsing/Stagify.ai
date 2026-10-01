// Boot-time check that production is actually running under Litestream.
//
// scripts/start.sh fails SAFE on purpose: a missing binary, missing R2 credentials or a
// missing endpoint boots the app WITHOUT replication rather than taking the site down.
// That posture is right, but it used to fail SILENT too, and once meant the database had
// no off-disk backup for weeks with nothing reporting it (docs/operations/deployment.md).
//
// So start.sh now tells the app which path it took: LITESTREAM_ACTIVE=1 on the replicate
// path, LITESTREAM_SKIP_REASON=<code> on every skip path. This module turns a skipped
// production boot into an error-level log line plus a Sentry event, so it pages someone.
//
// "Production" means running on Render (RENDER is set by the platform) and not staging.
// Local dev and staging never replicate by design, so they stay quiet.

/** @typedef {{ active: boolean, expected: boolean, reason: string | null }} BackupStatus */

/**
 * @param {object} deps
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {boolean} deps.isStaging
 * @param {{ error: (...args: any[]) => void, info: (...args: any[]) => void }} deps.logger
 * @param {{ captureMessage: (msg: string, level?: any) => unknown }} [deps.sentry]
 * @returns {BackupStatus}
 */
export function checkBackupStatus({ env = process.env, isStaging, logger, sentry }) {
  const expected = Boolean(env.RENDER) && !isStaging;
  const active = env.LITESTREAM_ACTIVE === '1';
  const reason = active ? null : (env.LITESTREAM_SKIP_REASON || 'not-started-via-start-sh');

  if (expected && active) {
    logger.info('[backup] Litestream replication active.');
  } else if (expected) {
    const msg = `Litestream replication DISABLED in production (${reason}). The database has no off-disk backup.`;
    logger.error(`[backup] ${msg}`);
    sentry?.captureMessage(msg, 'error');
  }
  return { active, expected, reason };
}
