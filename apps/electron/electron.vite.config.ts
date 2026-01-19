import { defineConfig } from "electron-vite";
import { resolve } from "path";

// Point to monorepo root for shared .env.local
const rootDir = resolve(__dirname, "../..");

export default defineConfig({
  main: {
    envDir: rootDir,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
        // Native modules must be external - they can't be bundled
        external: ["better-sqlite3"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
  },
});
