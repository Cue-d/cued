import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    globals: true,
    // Ignore unhandled errors from scheduled functions that run after tests complete.
    // Sync mutations schedule background jobs (contact resolution, action events)
    // which may throw after the test transaction is closed.
    dangerouslyIgnoreUnhandledErrors: true,
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
    include: ["convex/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["convex/**/*.ts"],
      exclude: [
        "convex/_generated/**",
        "convex/**/__tests__/**",
        "convex/**/*.test.ts",
      ],
    },
  },
});
