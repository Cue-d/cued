import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacOSNativeBinary } from "../runtime/native-binary.js";
import { terminateCompetingDaemons } from "./competing-daemons.js";

const APP_NAME = "Cued.app";
const APP_EXECUTABLE_NAME = "CuedDaemon";
const LAUNCH_AGENT_LABEL = "dev.cued.daemon";
const APP_BUNDLE_IDENTIFIER = "dev.cued.app";

type NativeLoginItemStatus = {
  enabled: boolean;
  status: string;
  requiresApproval: boolean;
  found: boolean;
};

export type LegacyLaunchAgentStatus = {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  details?: string;
};

export type LoginItemStatus = NativeLoginItemStatus & {
  appPath: string | null;
  legacyLaunchAgent: LegacyLaunchAgentStatus;
};

export type LoginItemCommandResult = LoginItemStatus & {
  migratedLegacyLaunchAgent: boolean;
};

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function currentAppPath(): string | null {
  const appPath = process.env.CUED_APP_PATH;
  if (!appPath || !isValidCuedAppBundle(appPath)) {
    return null;
  }
  return appPath;
}

export function getCurrentAppPath(): string | null {
  return currentAppPath();
}

function readInfoPlistValue(contents: string, key: string): string | null {
  const match = contents.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return match?.[1] ?? null;
}

export function getAppBundleVersion(appPath: string): string | null {
  const infoPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPath)) {
    return null;
  }

  try {
    return readInfoPlistValue(readFileSync(infoPath, "utf8"), "CFBundleShortVersionString");
  } catch {
    return null;
  }
}

export function isValidCuedAppBundle(appPath: string): boolean {
  if (basename(appPath) !== APP_NAME || !existsSync(appPath)) {
    return false;
  }

  const infoPath = join(appPath, "Contents", "Info.plist");
  const executablePath = appExecutablePath(appPath);
  if (!existsSync(infoPath) || !existsSync(executablePath)) {
    return false;
  }

  try {
    const info = readFileSync(infoPath, "utf8");
    return (
      readInfoPlistValue(info, "CFBundleIdentifier") === APP_BUNDLE_IDENTIFIER &&
      readInfoPlistValue(info, "CFBundleExecutable") === APP_EXECUTABLE_NAME &&
      readInfoPlistValue(info, "CFBundleName") === "Cued"
    );
  } catch {
    return false;
  }
}

export function resolveInstalledAppPathFromCandidates(candidates: string[]): string | null {
  return candidates.find((candidate) => isValidCuedAppBundle(candidate)) ?? null;
}

export function getBuiltAppPath(): string {
  return join(repoRoot(), "native", "macos", "dist", APP_NAME);
}

export function getDefaultInstallAppPath(): string {
  return join("/Applications", APP_NAME);
}

export function getFallbackInstallAppPath(): string {
  return join(homedir(), "Applications", APP_NAME);
}

export function resolveInstalledAppPath(): string | null {
  const candidates = [
    process.env.CUED_APP_PATH,
    getDefaultInstallAppPath(),
    getFallbackInstallAppPath(),
    getBuiltAppPath(),
  ].filter((value): value is string => Boolean(value));

  return resolveInstalledAppPathFromCandidates(candidates);
}

export function buildMacOSAppBundle(): { appPath: string } {
  const bundledAppPath = currentAppPath();
  if (bundledAppPath) {
    return { appPath: bundledAppPath };
  }

  const script = join(repoRoot(), "scripts", "build-cued-daemon-app.sh");
  const stdout = execFileSync("bash", [script], {
    cwd: repoRoot(),
    encoding: "utf8",
  }).trim();
  return {
    appPath: stdout.split("\n").filter(Boolean).pop() ?? getBuiltAppPath(),
  };
}

export function installMacOSApp(destinationPath?: string): {
  sourcePath: string;
  installedAppPath: string;
  cliSymlinkPath: string;
} {
  const { appPath: sourcePath } = buildMacOSAppBundle();
  return installMacOSAppFromSource(sourcePath, destinationPath);
}

export function installCLISymlink(installedAppPath: string): string {
  const cliSource = join(installedAppPath, "Contents", "Resources", "cued-cli");
  const cliDir = join(homedir(), ".local", "bin");
  mkdirSync(cliDir, { recursive: true });
  const cliSymlinkPath = join(cliDir, "cued");
  rmSync(cliSymlinkPath, { force: true });
  symlinkSync(cliSource, cliSymlinkPath);
  return cliSymlinkPath;
}

export function getCLISymlinkPath(): string {
  return join(homedir(), ".local", "bin", "cued");
}

export function getCLISymlinkStatus(): {
  path: string;
  installed: boolean;
  target: string | null;
} {
  const path = getCLISymlinkPath();
  if (!existsSync(path)) {
    return {
      path,
      installed: false,
      target: null,
    };
  }

  try {
    return {
      path,
      installed: true,
      target: realpathSync(path),
    };
  } catch {
    return {
      path,
      installed: true,
      target: null,
    };
  }
}

export function installMacOSAppFromSource(
  sourcePath: string,
  destinationPath?: string,
): {
  sourcePath: string;
  installedAppPath: string;
  cliSymlinkPath: string;
} {
  const installedAppPath = destinationPath ?? getDefaultInstallAppPath();
  terminateCompetingDaemons({
    expectedExecutablePath: appExecutablePath(installedAppPath),
  });
  const sameBundle =
    existsSync(sourcePath) &&
    existsSync(installedAppPath) &&
    realpathSync(sourcePath) === realpathSync(installedAppPath);
  if (!sameBundle) {
    mkdirSync(dirname(installedAppPath), { recursive: true });
    if (!existsSync(installedAppPath)) {
      mkdirSync(installedAppPath, { recursive: true });
    }
    // Keep the installed app bundle path stable so macOS privacy grants survive updates.
    execFileSync("rsync", ["-a", "--delete", `${sourcePath}/`, `${installedAppPath}/`], {
      stdio: "ignore",
    });
  }

  return {
    sourcePath,
    installedAppPath,
    cliSymlinkPath: installCLISymlink(installedAppPath),
  };
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function getLaunchAgentPlistPath(): string {
  return launchAgentPath();
}

function appExecutablePath(appPath: string): string {
  return join(appPath, "Contents", "MacOS", APP_EXECUTABLE_NAME);
}

export function getAppExecutablePath(appPath: string): string {
  return appExecutablePath(appPath);
}

function resolveLoginItemBinary(appPath?: string): string {
  const preferredAppPath = appPath ?? currentAppPath() ?? resolveInstalledAppPath();
  if (preferredAppPath && isValidCuedAppBundle(preferredAppPath)) {
    return appExecutablePath(preferredAppPath);
  }

  const nativeBinary = resolveMacOSNativeBinary(
    process.env.CUED_AUTH_NATIVE_BINARY ?? process.env.CUED_CONTACTS_NATIVE_BINARY,
    repoRoot(),
  );
  if (!nativeBinary) {
    throw new Error("CuedNative binary not found; build native/macos/CuedNative first");
  }
  return nativeBinary;
}

function runNativeLoginItemCommand(
  subcommand: "status" | "enable" | "disable",
  appPath?: string,
): NativeLoginItemStatus {
  const stdout = execFileSync(resolveLoginItemBinary(appPath), ["login-item", subcommand], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout) as Partial<NativeLoginItemStatus>;
  if (
    typeof parsed.enabled !== "boolean" ||
    typeof parsed.status !== "string" ||
    typeof parsed.requiresApproval !== "boolean" ||
    typeof parsed.found !== "boolean"
  ) {
    throw new Error("Invalid login item status response from native runtime");
  }
  return {
    enabled: parsed.enabled,
    status: parsed.status,
    requiresApproval: parsed.requiresApproval,
    found: parsed.found,
  };
}

export function bootoutLaunchAgent(): { plistPath: string; bootedOut: boolean } {
  const plistPath = launchAgentPath();
  if (!existsSync(plistPath)) {
    return { plistPath, bootedOut: false };
  }

  try {
    execFileSync("launchctl", ["bootout", `gui/${currentUid()}`, plistPath], { stdio: "ignore" });
    return { plistPath, bootedOut: true };
  } catch {
    return { plistPath, bootedOut: false };
  }
}

export function getLegacyLaunchAgentStatus(): LegacyLaunchAgentStatus {
  const plistPath = launchAgentPath();
  try {
    const details = execFileSync(
      "launchctl",
      ["print", `gui/${currentUid()}/${LAUNCH_AGENT_LABEL}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      label: LAUNCH_AGENT_LABEL,
      plistPath,
      installed: existsSync(plistPath),
      loaded: true,
      details,
    };
  } catch (error) {
    return {
      label: LAUNCH_AGENT_LABEL,
      plistPath,
      installed: existsSync(plistPath),
      loaded: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export function removeLegacyLaunchAgent(): {
  plistPath: string;
  bootedOut: boolean;
  removed: boolean;
} {
  const { plistPath, bootedOut } = bootoutLaunchAgent();
  const removed = existsSync(plistPath);
  if (removed) {
    rmSync(plistPath, { force: true });
  }
  return {
    plistPath,
    bootedOut,
    removed,
  };
}

export function getLoginItemStatus(appPath?: string): LoginItemStatus {
  const resolvedAppPath = appPath ?? resolveInstalledAppPath();
  return {
    ...runNativeLoginItemCommand("status", resolvedAppPath ?? undefined),
    appPath: resolvedAppPath,
    legacyLaunchAgent: getLegacyLaunchAgentStatus(),
  };
}

export function enableLoginItem(appPath?: string): LoginItemCommandResult {
  const resolvedAppPath = appPath ?? resolveInstalledAppPath();
  if (!resolvedAppPath) {
    throw new Error("Cued.app is not installed. Run `cued install` first.");
  }
  terminateCompetingDaemons({
    expectedExecutablePath: appExecutablePath(resolvedAppPath),
  });

  const legacyBefore = getLegacyLaunchAgentStatus();
  const native = runNativeLoginItemCommand("enable", resolvedAppPath);
  if (legacyBefore.installed) {
    removeLegacyLaunchAgent();
  }

  return {
    ...native,
    appPath: resolvedAppPath,
    legacyLaunchAgent: getLegacyLaunchAgentStatus(),
    migratedLegacyLaunchAgent: legacyBefore.installed,
  };
}

export function disableLoginItem(appPath?: string): LoginItemCommandResult {
  const resolvedAppPath = appPath ?? resolveInstalledAppPath();
  const nativeStatus = runNativeLoginItemCommand("status", resolvedAppPath ?? undefined);
  const native =
    nativeStatus.status === "enabled" || nativeStatus.status === "requires_approval"
      ? runNativeLoginItemCommand("disable", resolvedAppPath ?? undefined)
      : nativeStatus;
  const legacy = removeLegacyLaunchAgent();

  return {
    ...native,
    appPath: resolvedAppPath,
    legacyLaunchAgent: getLegacyLaunchAgentStatus(),
    migratedLegacyLaunchAgent: legacy.removed || legacy.bootedOut,
  };
}

export function installLaunchAgent(appPath?: string): LoginItemCommandResult {
  return enableLoginItem(appPath);
}

export function uninstallLaunchAgent(appPath?: string): LoginItemCommandResult {
  return disableLoginItem(appPath);
}

export function getLaunchAgentStatus(appPath?: string): LoginItemStatus {
  return getLoginItemStatus(appPath);
}

export function getAppBundleInfo(appPath?: string): Record<string, unknown> {
  const resolvedAppPath = appPath ?? resolveInstalledAppPath();
  if (!resolvedAppPath) {
    return {
      installed: false,
      builtAppPath: getBuiltAppPath(),
      defaultInstallPath: getDefaultInstallAppPath(),
      fallbackInstallPath: getFallbackInstallAppPath(),
    };
  }

  const infoPath = join(resolvedAppPath, "Contents", "Info.plist");
  return {
    installed: true,
    appPath: resolvedAppPath,
    executablePath: appExecutablePath(resolvedAppPath),
    infoPath,
    version: getAppBundleVersion(resolvedAppPath),
    bundleIdentifier: isValidCuedAppBundle(resolvedAppPath) ? APP_BUNDLE_IDENTIFIER : null,
    infoPlistPreview: existsSync(infoPath) ? readFileSync(infoPath, "utf8").slice(0, 800) : null,
  };
}
