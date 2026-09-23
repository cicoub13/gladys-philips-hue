// -----------------------------------------------------------------------------
// Process-level behaviour of the entry point, run for real in a child process
// against a fake Gladys that refuses the integration token (close code 4000),
// as Gladys does transiently while it boots.
//
// `ws` is not a dependency of ours: it comes with the SDK, which uses it for
// its own WebSocket.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ENTRY_POINT = fileURLToPath(new URL('../index.js', import.meta.url));

/**
 * Start a fake Gladys refusing every authentication.
 * @returns {Promise<{ url: string, close: () => void }>} Its URL and closer.
 */
async function refusingGladys() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => socket.close(4000));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.clients.forEach((client) => client.terminate());
      server.close();
    },
  };
}

/**
 * Run the entry point for a while.
 * @param {string} gladysUrl - Fake Gladys URL.
 * @param {number} forMs - How long to let it run before killing it.
 * @param {string[]} [nodeArgs] - Extra node arguments.
 * @returns {Promise<{ exitCode: number | null, output: string }>} Exit code (null if still running) and output.
 */
async function runEntryPoint(gladysUrl, forMs, nodeArgs = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-index-'));
  const child = spawn(process.execPath, [...nodeArgs, ENTRY_POINT], {
    env: {
      ...process.env,
      GLADYS_HOST_API_URL: gladysUrl,
      GLADYS_INTEGRATION_TOKEN: 'test-token',
      GLADYS_INTEGRATION_SELECTOR: 'philips-hue',
      HUE_DATA_DIR: dataDir,
      LOG_LEVEL: 'info',
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, forMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { exitCode, output };
}

test('a token refused while Gladys boots is logged, and the integration stays up to reconnect', async () => {
  // The SDK keeps reconnecting after a 4000 (it can be transient) but rejects
  // connect(): exiting on it threw that retry away.
  const gladys = await refusingGladys();
  try {
    const { exitCode, output } = await runEntryPoint(gladys.url, 1500);
    assert.equal(exitCode, null, `the process must still be running, it exited with ${exitCode}:\n${output}`);
    assert.match(output, /\[ERROR\].*Initial connection to Gladys failed.*authentication refused/);
  } finally {
    gladys.close();
  }
});

test('an unhandled rejection is logged with its reason, then the process exits', async () => {
  const gladys = await refusingGladys();
  const rejectLater = 'data:text/javascript,setTimeout(() => Promise.reject(new Error("boom-for-test")), 300);';
  try {
    const { exitCode, output } = await runEntryPoint(gladys.url, 3000, ['--import', rejectLater]);
    assert.equal(exitCode, 1, output);
    assert.match(output, /\[ERROR\].*Unhandled promise rejection.*boom-for-test/);
  } finally {
    gladys.close();
  }
});
