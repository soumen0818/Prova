// Metro config for consuming the local @prova/shared package from the polyrepo.
// See https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');

const config = getDefaultConfig(projectRoot);

// 1. Watch the shared package so Metro picks up its built files.
config.watchFolders = [sharedRoot];

// 2. Resolve node modules from the app first, then let hierarchical lookup handle the rest.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

// 3. Follow the file: symlink and honor the package's "exports" map.
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
