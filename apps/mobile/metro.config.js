const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

// Find the monorepo root
const monorepoRoot = path.resolve(__dirname, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Enable package.json "exports" field resolution (needed for workspace packages)
config.resolver.unstable_enablePackageExports = true;

// Watch the monorepo root for changes (required for pnpm)
const defaultWatchFolders = config.watchFolders ?? [];
config.watchFolders = [...new Set([...defaultWatchFolders, monorepoRoot])];

// Exclude electron app from Metro's file map (native modules break TreeFS)
const exclusionList =
  require("metro-config/private/defaults/exclusionList").default;
config.resolver.blockList = exclusionList([
  new RegExp(
    path.resolve(monorepoRoot, "apps/electron").replace(/[/\\]/g, "[/\\\\]") +
      ".*"
  ),
]);

// Let Metro resolve packages from the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
