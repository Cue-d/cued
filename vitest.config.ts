import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      sqlite: "node:sqlite",
    },
  },
  test: {
    environment: "node",
  },
});
