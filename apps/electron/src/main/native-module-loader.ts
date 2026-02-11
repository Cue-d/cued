import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";

const requireFromMain = createRequire(import.meta.url);

interface NativeModuleLoadOptions {
  /** Optional file path inside the package root (e.g. dist/index.cjs). */
  fallbackEntrypoint?: string;
}

/**
 * Load a module from normal Node resolution first, then from
 * `process.resourcesPath/app.asar.unpacked/node_modules` when packaged.
 */
export function loadNativeModule<T>(
  packageName: string,
  options: NativeModuleLoadOptions = {}
): T {
  try {
    return requireFromMain(packageName) as T;
  } catch (primaryError) {
    if (!app.isPackaged) {
      throw primaryError;
    }

    const unpackedModuleRoot = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      packageName
    );
    const fallbackPath = options.fallbackEntrypoint
      ? join(unpackedModuleRoot, options.fallbackEntrypoint)
      : unpackedModuleRoot;

    if (!existsSync(fallbackPath)) {
      throw primaryError;
    }

    return requireFromMain(fallbackPath) as T;
  }
}
