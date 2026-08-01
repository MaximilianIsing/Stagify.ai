// Shared test harness: spawn the real server.js on a free port and resolve once
// it's listening. Used by the boot smoke test and the access-guard tests. No API
// calls — the server degrades gracefully when unconfigured.
//
// Not a spec: the `test` script runs `node --test "test/**/*.test.js"`, so this
// file (not named *.test.js) is imported by the tests but never run as one.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
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
//
// EACH SPAWNED SERVER GETS ITS OWN DATA DIRECTORY, and that is not tidiness. Eight test
// files spawn a `server.js`, node --test runs them in parallel, and with a shared dir every
// one of them opened the same `<repo>/data/auth-store.db`. Under load a boot died outright
// — `SqliteError: disk I/O error` from `applyPragmas` — and the test that was about that
// server then failed with a bare `TypeError: fetch failed`, in a different file each run.
// `npm test` gates the deploy, so it was an intermittently red deploy gate; it was also
// these tests writing to the developer's real database on every run.
export async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      STAGIFY_DATA_DIR: dataDir,
      ...extraEnv,
    },
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
    close: () => {
      child.kill();
      // Best effort: the child may still hold the .db handle for a moment on Windows, and a
      // leftover temp dir is far less bad than a teardown that throws.
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch { /* the OS will reclaim it */ }
    },
  };
}
