import { build as esbuild } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'main'), { recursive: true });
await mkdir(path.join(dist, 'preload'), { recursive: true });

await esbuild({
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(dist, 'main/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'ssh2', 'pg'],
  sourcemap: false,
  logLevel: 'info',
});

await esbuild({
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(dist, 'preload/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(root, 'vite.config.ts')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, BROWSER: 'none' },
  });
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Vite build failed: ${code ?? signal}`));
  });
});
