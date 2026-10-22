#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
for (const [key, value] of [['core.hooksPath', '.githooks'], ['view.nodePath', process.execPath]]) {
  const result = spawnSync('git', ['config', '--local', key, value], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write('Installed repository-local privacy hooks.\n');
