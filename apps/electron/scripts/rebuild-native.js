/**
 * Rebuild native modules for the target Electron version before packaging,
 * then dereference pnpm symlinks so electron-builder can find them.
 *
 * In a pnpm monorepo, node_modules entries are symlinks to the .pnpm store
 * which lives outside the project directory. electron-builder won't follow
 * these symlinks, so we replace them with the real files after rebuilding.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Native modules that must be externalized (have .node binaries). */
const NATIVE_MODULES = ["better-sqlite3", "electron-liquid-glass", "node-mac-contacts"];
/** Runtime deps required by native modules when loaded from app.asar.unpacked. */
const NATIVE_RUNTIME_DEPS = ["bindings", "file-uri-to-path", "node-gyp-build"];

/**
 * Replace a pnpm symlink with the actual directory contents.
 * This lets electron-builder package the module into the asar/unpacked.
 */
function dereferenceSymlink(nodeModulesDir, moduleName) {
  const modPath = path.join(nodeModulesDir, moduleName);

  let stat;
  try {
    stat = fs.lstatSync(modPath);
  } catch {
    console.warn(`  ⚠ ${moduleName} not found in node_modules, skipping`);
    return;
  }

  if (!stat.isSymbolicLink()) {
    console.log(`  ✓ ${moduleName} already dereferenced`);
    return;
  }

  const realPath = fs.realpathSync(modPath);
  fs.unlinkSync(modPath);
  fs.cpSync(realPath, modPath, { recursive: true });
  console.log(`  ✓ ${moduleName}: ${realPath} → ${modPath}`);
}

/**
 * Ensure a dependency exists as a real directory under app-local node_modules.
 * For pnpm monorepos, transitive deps may not be linked there by default.
 */
function materializeModule(nodeModulesDir, projectRoot, moduleName) {
  const modPath = path.join(nodeModulesDir, moduleName);

  if (fs.existsSync(modPath)) {
    return;
  }

  try {
    const pkgJsonPath = require.resolve(`${moduleName}/package.json`, {
      paths: [projectRoot],
    });
    const realPath = path.dirname(pkgJsonPath);
    fs.cpSync(realPath, modPath, { recursive: true });
    console.log(`  ✓ ${moduleName}: materialized from ${realPath}`);
  } catch {
    console.warn(`  ⚠ ${moduleName} could not be resolved for materialization`);
  }
}

exports.default = async function rebuild(context) {
  const { electronVersion, arch } = context;
  const projectRoot = path.resolve(__dirname, "..");
  const nodeModulesDir = path.join(projectRoot, "node_modules");

  // 1. Rebuild native modules for the target Electron version
  console.log(`Rebuilding native modules for Electron ${electronVersion} (${arch})...`);

  try {
    const moduleList = NATIVE_MODULES.join(",");
    execSync(
      `npx @electron/rebuild -v ${electronVersion} -a ${arch} -w ${moduleList} --force`,
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

  // 2. Ensure native runtime deps are present in app-local node_modules
  console.log("Materializing native runtime dependencies...");
  for (const mod of NATIVE_RUNTIME_DEPS) {
    materializeModule(nodeModulesDir, projectRoot, mod);
  }

  // 3. Dereference pnpm symlinks so electron-builder can package them
  console.log("Dereferencing pnpm symlinks for native modules...");
  for (const mod of [...NATIVE_MODULES, ...NATIVE_RUNTIME_DEPS]) {
    dereferenceSymlink(nodeModulesDir, mod);
  }
};
