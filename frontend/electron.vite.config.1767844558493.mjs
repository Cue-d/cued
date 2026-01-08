// electron.vite.config.ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
var __electron_vite_injected_import_meta_url = "file:///Users/snbafana/conductor/workspaces/prm/los-angeles/frontend/electron.vite.config.ts";
var __dirname = dirname(fileURLToPath(__electron_vite_injected_import_meta_url));
var electron_vite_config_default = defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    plugins: [react(), tailwindcss()]
  }
});
export {
  electron_vite_config_default as default
};
