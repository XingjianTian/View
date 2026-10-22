const path = require('node:path');

const PACKAGE_EXCLUDES = [
  /^\.env(?:[./]|$)/,
  /^\.privacy\.local\.json$/,
  /^\.githooks(?:\/|$)/,
  /^\.github(?:\/|$)/,
  /^\.ai-bridge(?:\/|$)/,
  /^\.git(?:\/|$)/,
  /^\.gitignore$/,
  /^tests(?:\/|$)/,
  /^test-results(?:\/|$)/,
  /^playwright-report(?:\/|$)/,
  /^\.playwright-cli(?:\/|$)/,
  /^\.finesse(?:\/|$)/,
  /^node_modules\/(?:\.cache|\.vite|\.vite-temp|\.vitest-cache)(?:\/|$)/,
  /^\.vite(?:\/|$)/,
  /^\.vite-temp(?:\/|$)/,
  /^\.vitest-cache(?:\/|$)/,
  /^src(?:\/|$)/,
  /^scripts(?:\/|$)/,
  /^docs(?:\/|$)/,
  /^assets(?:\/|$)/,
  /^(?:PLAN|REQUIREMENTS|HANDOFF|Records)\.md$/,
  /^(?:forge\.config|playwright\.config|tsconfig|vite\.config|vitest\.config)\./,
  /^package-lock\.json$/,
  /^out(?:\/|$)/,
];

module.exports = {
  packagerConfig: {
    asar: true,
    name: '观',
    executableName: '观',
    appBundleId: 'local.serviceobservatory',
    extendInfo: { CFBundleDisplayName: '观', CFBundleName: '观' },
    appCategoryType: 'public.app-category.utilities',
    prune: true,
    ignore: (absolutePath) => {
      const relativePath = absolutePath.startsWith(__dirname)
        ? path.relative(__dirname, absolutePath).replaceAll(path.sep, '/')
        : absolutePath.replace(/^[/\\]+/, '').replaceAll(path.sep, '/');
      return PACKAGE_EXCLUDES.some((pattern) => pattern.test(relativePath));
    },
  },
  makers: [],
};
