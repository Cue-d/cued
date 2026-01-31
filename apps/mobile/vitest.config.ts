import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.test.{ts,tsx}"],
    },
    // Exclude expo from server deps to prevent native module loading
    server: {
      deps: {
        external: [/^expo/, /^@expo/],
      },
    },
  },
  resolve: {
    alias: [
      // Mock widget-data BEFORE the @ alias so it takes precedence
      { find: /^@\/lib\/widget-data$/, replacement: path.resolve(__dirname, "./src/test/mocks/widget-data.ts") },
      // Widgets are in root widgets/ directory for expo-widgets
      { find: /^@\/widgets$/, replacement: path.resolve(__dirname, "./widgets/index.ts") },
      { find: /^@\/widgets\/(.*)$/, replacement: path.resolve(__dirname, "./widgets/$1") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // Mock convex API to avoid TypeScript-only declaration files
      { find: "@cued/convex/convex/_generated/api", replacement: path.resolve(__dirname, "./src/test/mocks/convex-api.ts") },
      // Mock convex/server to avoid TypeScript-only declaration files
      { find: "convex/server", replacement: path.resolve(__dirname, "./src/test/mocks/convex-server.ts") },
      { find: "@cued/convex", replacement: path.resolve(__dirname, "../../packages/convex") },
      // Point to source files directly for proper resolution in tests
      { find: "@cued/shared", replacement: path.resolve(__dirname, "../../packages/shared/src/index.ts") },
      { find: "@cued/env/client", replacement: path.resolve(__dirname, "../../packages/env/src/client.ts") },
      { find: "@cued/env", replacement: path.resolve(__dirname, "../../packages/env/src/index.ts") },
      { find: "react-native", replacement: path.resolve(__dirname, "./src/test/mocks/react-native.ts") },
      // Mock expo modules to avoid native module loading in tests
      { find: "expo-widgets", replacement: path.resolve(__dirname, "./src/test/mocks/expo-widgets.ts") },
      { find: "expo/fetch", replacement: path.resolve(__dirname, "./src/test/mocks/expo-fetch.ts") },
    ],
  },
});
