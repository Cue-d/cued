import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CUED_BROWSER_DIR, CUED_SIGNAL_DIR, CUED_WHATSAPP_DIR } from "../../core/config.js";
import { validateIntegrationAccountKey } from "./account-keys.js";
import type { Platform } from "./types.js";

function isStrictChildPath(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function assertInsideRuntimeRoot(targetPath: string, rootPath: string, label: string): void {
  if (!isStrictChildPath(rootPath, targetPath)) {
    throw new Error(`Refusing to remove ${label} outside Cued runtime root`);
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertNoSymlinkAncestors(targetPath: string, rootPath: string, label: string): void {
  const relativePath = relative(rootPath, targetPath);
  const segments = relativePath.split(sep).filter(Boolean);
  let currentPath = rootPath;

  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    const stat = lstatIfExists(currentPath);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove ${label} through symlinked runtime path`);
    }
  }
}

export function getChromiumProfileRoot(platform: Platform): string {
  return join(CUED_BROWSER_DIR, platform);
}

export function getChromiumProfileDir(platform: Platform, accountKey: string): string {
  return join(getChromiumProfileRoot(platform), validateIntegrationAccountKey(accountKey));
}

export function getSignalConfigRoot(): string {
  return process.env.CUED_SIGNAL_DIR?.trim() || CUED_SIGNAL_DIR;
}

export function getWhatsAppStoreRoot(): string {
  return CUED_WHATSAPP_DIR;
}

export function removeRuntimeDirectoryInsideRoot(
  targetPath: string,
  rootPath: string,
  label: string,
): void {
  const targetResolvedPath = resolve(targetPath);
  const targetStat = lstatIfExists(targetResolvedPath);
  if (!targetStat) {
    return;
  }

  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const rootResolvedPath = resolve(rootPath);
  assertInsideRuntimeRoot(targetResolvedPath, rootResolvedPath, label);
  assertNoSymlinkAncestors(targetResolvedPath, rootResolvedPath, label);

  if (targetStat.isSymbolicLink()) {
    rmSync(targetResolvedPath, { recursive: true, force: true });
    return;
  }

  const rootRealPath = realpathSync(rootPath);
  const targetRealPath = realpathSync(targetResolvedPath);
  assertInsideRuntimeRoot(targetRealPath, rootRealPath, label);
  rmSync(targetResolvedPath, { recursive: true, force: true });
}

export function moveRuntimeDirectoryInsideRoot(
  currentPath: string,
  targetPath: string,
  rootPath: string,
  label: string,
): void {
  const currentResolvedPath = resolve(currentPath);
  const currentStat = lstatIfExists(currentResolvedPath);
  if (!currentStat) {
    return;
  }

  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const rootResolvedPath = resolve(rootPath);
  const rootRealPath = realpathSync(rootPath);
  const targetResolvedPath = resolve(targetPath);
  assertInsideRuntimeRoot(currentResolvedPath, rootResolvedPath, label);
  assertInsideRuntimeRoot(targetResolvedPath, rootResolvedPath, label);
  assertNoSymlinkAncestors(currentResolvedPath, rootResolvedPath, label);
  assertNoSymlinkAncestors(targetResolvedPath, rootResolvedPath, label);

  if (currentStat.isSymbolicLink()) {
    throw new Error(`Refusing to move ${label} from a symlinked runtime path`);
  }

  const currentRealPath = realpathSync(currentResolvedPath);
  assertInsideRuntimeRoot(currentRealPath, rootRealPath, label);

  mkdirSync(dirname(targetResolvedPath), { recursive: true, mode: 0o700 });
  if (!lstatIfExists(targetResolvedPath)) {
    renameSync(currentResolvedPath, targetResolvedPath);
    return;
  }

  removeRuntimeDirectoryInsideRoot(currentResolvedPath, rootResolvedPath, label);
}
