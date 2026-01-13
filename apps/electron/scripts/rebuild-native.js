/**
 * Rebuild native modules for the target Electron version before packaging.
 */

const { execSync } = require("child_process");
const path = require("path");

exports.default = async function rebuild(context) {
  const { electronVersion, arch } = context;
  const projectRoot = path.resolve(__dirname, "..");

  console.log(`Rebuilding native modules for Electron ${electronVersion} (${arch})...`);

  try {
    execSync(
      `npx @electron/rebuild -v ${electronVersion} -a ${arch} -w better-sqlite3 --force`,
      {
        cwd: projectRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          npm_config_runtime: "electron",
          npm_config_target: electronVersion,
          npm_config_arch: arch,
          npm_config_disturl: "https://electronjs.org/headers",
        },
      }
    );
    console.log("Native module rebuild complete!");
  } catch (error) {
    console.error("Native module rebuild failed:", error);
    throw error;
  }
};
