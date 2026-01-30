import eslintConfigNext from "eslint-config-next"
import importPlugin from "eslint-plugin-import-x"

const config = [
  ...eslintConfigNext,
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
            // Monorepo packages (@cued/*)
            { pattern: "@cued/**", group: "internal", position: "before" },
            // Relative imports
            { pattern: "../**", group: "parent" },
            { pattern: "./**", group: "sibling" },
          ],
          pathGroupsExcludedImportTypes: ["react", "type"],
          "newlines-between": "never",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  },
]

export default config
