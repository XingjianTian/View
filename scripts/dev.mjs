import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');
const electronBin = path.join(root, 'node_modules/.bin/electron');
const env = { ...process.env, BROWSER: 'none' };

const vite = spawn(process.execPath, [viteBin, '--config', path.join(root, 'vite.config.ts')], {
  cwd: root,
  stdio: 'inherit',
  env,
});

function waitForPort(host, port, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('Vite did not start within 20 seconds'));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

let electron;
try {
  await waitForPort('127.0.0.1', 5173);
  electron = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...env, SERVICE_OBSERVATORY_DEV_SERVER: 'http://127.0.0.1:5173' },
  });
  await new Promise((resolve) => electron.once('exit', resolve));
} finally {
  vite.kill('SIGTERM');
  if (electron && !electron.killed) electron.kill('SIGTERM');
}
