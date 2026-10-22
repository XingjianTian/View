import { access, readFile } from 'node:fs/promises';
import { listPackage } from '@electron/asar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestedArch = process.argv.find((arg) => arg.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch;
const arch = requestedArch === 'arm64' || requestedArch === 'x64' ? requestedArch : process.arch;
const appPath = path.join(root, 'out', `观-darwin-${arch}`, '观.app');
const binaryPath = path.join(appPath, 'Contents', 'MacOS', '观');
const plistPath = path.join(appPath, 'Contents', 'Info.plist');
const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');

for (const file of [appPath, binaryPath, plistPath, asarPath]) await access(file);
const plist = await readFile(plistPath, 'utf8');
if (!plist.includes('<key>CFBundleIdentifier</key>') || !plist.includes('local.serviceobservatory')) {
  throw new Error('Package Info.plist is missing the expected bundle identifier');
}
if (plist.includes('profiles.private') || plist.includes('config.json')) {
  throw new Error('Package contains a private configuration filename');
}
const archiveFiles = listPackage(asarPath);
const forbidden = archiveFiles.filter((file) => /^(?:\/\.env(?:[./]|$)|\/\.privacy\.local\.json$|\/\.githooks(?:\/|$)|\/\.github(?:\/|$)|\/\.ai-bridge|\/tests(?:\/|$)|\/test-results(?:\/|$)|\/playwright-report(?:\/|$)|\/\.playwright-cli(?:\/|$)|\/\.finesse(?:\/|$)|\/node_modules\/(?:\.cache|\.vite|\.vite-temp|\.vitest-cache)(?:\/|$)|\/\.vite(?:\/|$)|\/\.vite-temp(?:\/|$)|\/\.vitest-cache(?:\/|$)|\/src(?:\/|$)|\/docs(?:\/|$)|\/scripts(?:\/|$)|\/(?:PLAN|REQUIREMENTS|HANDOFF|Records)\.md$|\/package-lock\.json$|\/profiles\.private\.json$|\/config\.json$)/.test(file));
if (forbidden.length) throw new Error(`Package contains development or private files: ${forbidden.slice(0, 8).join(', ')}`);
const required = ['/dist/main/index.cjs', '/dist/preload/index.cjs', '/dist/renderer/index.html', '/package.json'];
for (const file of required) {
  if (!archiveFiles.includes(file)) throw new Error(`Package is missing runtime file: ${file}`);
}
console.log(JSON.stringify({ appPath, binaryPath, plistPath, asarPath, archiveEntries: archiveFiles.length, arch, verified: true }, null, 2));
