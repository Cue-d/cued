const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  globalIgnores([".expo/**", "node_modules/**", "nativewind-env.d.ts"]),
]);
