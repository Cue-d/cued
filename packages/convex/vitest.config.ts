import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    globals: true,
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
