const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const importPlugin = require("eslint-plugin-import-x");

module.exports = defineConfig([
  expoConfig,
  // Import ordering configuration
  {
    plugins: {
      "import-x": importPlugin,
    },
    rules: {
      "import-x/order": [
        "warn",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            ["parent", "sibling", "index"],
            "type",
          ],
          pathGroups: [
            // React first
            { pattern: "react", group: "external", position: "before" },
            { pattern: "react-native", group: "external", position: "before" },
            { pattern: "expo-**", group: "external", position: "before" },
            // Monorepo packages (@prm/*)
            { pattern: "@prm/**", group: "internal", position: "before" },
            // Local aliases (@/*)
            { pattern: "@/**", group: "internal", position: "after" },
          ],
          pathGroupsExcludedImportTypes: ["react", "type"],
          "newlines-between": "never",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  globalIgnores([".expo/**", "node_modules/**", "src/uniwind-types.d.ts"]),
]);
