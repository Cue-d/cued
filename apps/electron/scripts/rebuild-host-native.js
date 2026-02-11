/**
 * Restore native modules to the current host architecture after packaging.
 *
 * electron-builder rebuilds for each target arch (arm64 then x64), and the
 * final pass can leave local node_modules in the non-host architecture.
 * This breaks local preview/dev runs on Apple Silicon.
 */

const { execSync } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const hostArch = process.arch;
const nativeModules = ["better-sqlite3", "electron-liquid-glass", "node-mac-contacts"].join(",");

console.log(`Restoring native modules for host arch: ${hostArch}`);
execSync(`npx @electron/rebuild -f -a ${hostArch} -w ${nativeModules}`, {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_runtime: "electron",
  },
});
console.log("Host-arch native module restore complete.");
