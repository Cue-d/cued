import { defineConfig } from "electron-vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Point to monorepo root for shared .env.local
const rootDir = resolve(__dirname, "../..");

export default defineConfig({
  main: {
    envDir: rootDir,
    resolve: {
      alias: {
        "@cued/integrations": resolve(__dirname, "../../packages/integrations/src"),
      },
    },
    build: {
      // Force workspace packages to be bundled (not treated as external)
      externalizeDeps: {
        exclude: ["@cued/integrations"],
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
        // Native modules must be external - they can't be bundled
        external: ["better-sqlite3", "electron-liquid-glass"],
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
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
        "@cued/ui": resolve(__dirname, "../../packages/ui/src"),
        "@cued/shared": resolve(__dirname, "../../packages/shared/src"),
      },
      dedupe: ["react", "react-dom"],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
  },
});
