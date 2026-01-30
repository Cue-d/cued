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
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Mock convex API to avoid TypeScript-only declaration files
      "@cued/convex/convex/_generated/api": path.resolve(__dirname, "./src/test/mocks/convex-api.ts"),
      // Mock convex/server to avoid TypeScript-only declaration files
      "convex/server": path.resolve(__dirname, "./src/test/mocks/convex-server.ts"),
      "@cued/convex": path.resolve(__dirname, "../../packages/convex"),
      // Point to source files directly for proper resolution in tests
      "@cued/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@cued/env/client": path.resolve(__dirname, "../../packages/env/src/client.ts"),
      "@cued/env": path.resolve(__dirname, "../../packages/env/src/index.ts"),
      "react-native": path.resolve(__dirname, "./src/test/mocks/react-native.ts"),
    },
  },
});
