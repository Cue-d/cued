import { defineConfig, loadEnv } from "electron-vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Point to monorepo root for shared .env.local
const rootDir = resolve(__dirname, "../..");

// Load env vars at build time. In production builds (electron-vite build),
// this loads .env, .env.local, AND .env.production from the monorepo root.
// The empty prefix '' loads ALL vars, not just VITE_* prefixed ones.
const mode = process.env.NODE_ENV === "development" ? "development" : "production";
const env = loadEnv(mode, rootDir, "");

export default defineConfig({
  main: {
    envDir: rootDir,
    define: {
      // Inject env vars at build time so they're available in packaged app
      __ELECTRON_ENV__: JSON.stringify({
        CONVEX_URL: env.CONVEX_URL,
        WORKOS_CLIENT_ID: env.WORKOS_CLIENT_ID,
        API_BASE_URL: env.API_BASE_URL,
        NODE_ENV: env.NODE_ENV,
      }),
    },
    resolve: {
      alias: {
        "@cued/integrations": resolve(__dirname, "../../packages/integrations/src"),
      },
    },
    build: {
      // Bundle ALL dependencies into the output. This avoids pnpm monorepo
      // symlink issues where electron-builder can't find externalized deps
      // in the packaged asar. Only native modules with .node binaries are
      // kept external since they can't be bundled by Vite.
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
        external: ["better-sqlite3", "electron-liquid-glass", "node-mac-contacts", "bufferutil", "utf-8-validate"],
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
    envDir: rootDir,
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
