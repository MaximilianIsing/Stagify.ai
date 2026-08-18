// Shared test harness: spawn the real server.js on a free port and resolve once
// it's listening. Used by the boot smoke test and the access-guard tests. No API
// calls — the server degrades gracefully when unconfigured.
//
// Not a spec: the `test` script runs `node --test "test/**/*.test.js"`, so this
// file (not named *.test.js) is imported by the tests but never run as one.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const BOOT_TIMEOUT_MS = 20_000;

// Inert placeholder secrets for every spawned server.
//
// These specs are about ROUTING and GUARDS, not about a misconfigured deployment.
// With no key configured, the admin-key guard answers 500 "Server configuration
// error" and the Stripe routes answer 503 "not configured" — so a probe proves only
// that CI has no secrets, never that the route and its guard are still there. CI has
// no .env, which is why this passed locally and failed there.
//
// The values are fake and never reach a network: an unauthenticated, bodyless probe
// is refused at the guard long before any Stripe or AI call. Real config (a local
// .env, a secrets file, an exported var) still wins — these only fill the gaps — and
// a spec that wants the UNCONFIGURED behaviour overrides one back to '' via extraEnv.
const PLACEHOLDER_SECRETS = {
  endpoint_key: 'test-endpoint-access-key',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  ENTERPRISE_PRICE_ID: 'price_placeholder',
};

// Ask the OS for a free port so tests never collide with a real dev server.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boots server.js and resolves with a handle once it logs that it's listening.
// `extraEnv` overrides process.env for the child (e.g. to configure a dummy key).
export async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...PLACEHOLDER_SECRETS, ...process.env, PORT: String(port), NODE_ENV: 'test', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server did not boot within ${BOOT_TIMEOUT_MS}ms.\n--- output ---\n${output}`)),
      BOOT_TIMEOUT_MS,
    );
    child.stdout.on('data', () => {
      if (/Server running on port/.test(output)) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (code ${code}) before listening.\n--- output ---\n${output}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => output,
    close: () => child.kill(),
  };
}
