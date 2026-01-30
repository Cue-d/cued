const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const importPlugin = require("eslint-plugin-import-x");

module.exports = defineConfig([
  expoConfig,
  // Ignore convex generated files (not available in CI)
  {
    settings: {
      "import-x/ignore": ["@cued/convex/convex/_generated"],
    },
    rules: {
      "import/no-unresolved": [
        "error",
        { ignore: ["@cued/convex/convex/_generated"] },
      ],
    },
  },
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
            // Monorepo packages (@cued/*)
            { pattern: "@cued/**", group: "internal", position: "before" },
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
