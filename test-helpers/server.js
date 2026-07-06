// Shared test harness: spawn the real server.js on a free port and resolve once
// it's listening. Used by the boot smoke test and the access-guard tests. No API
// calls — the server degrades gracefully when unconfigured.
//
// Lives outside test/ so node --test doesn't treat it as a (test-less) spec file.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BOOT_TIMEOUT_MS = 20_000;

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
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ...extraEnv },
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
