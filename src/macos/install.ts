import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "Cued.app";
const APP_EXECUTABLE_NAME = "CuedDaemon";
const LAUNCH_AGENT_LABEL = "dev.cued.daemon";
const APP_BUNDLE_IDENTIFIER = "dev.cued.app";

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
}

function currentAppPath(): string | null {
  const appPath = process.env.CUED_APP_PATH;
  if (!appPath || !isValidCuedAppBundle(appPath)) {
    return null;
  }
  return appPath;
}

function readInfoPlistValue(contents: string, key: string): string | null {
  const match = contents.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return match?.[1] ?? null;
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

function appExecutablePath(appPath: string): string {
  return join(appPath, "Contents", "MacOS", APP_EXECUTABLE_NAME);
}

export function installLaunchAgent(appPath?: string): { plistPath: string; appPath: string } {
  const resolvedAppPath = appPath ?? resolveInstalledAppPath();
  if (!resolvedAppPath) {
    throw new Error("Cued.app is not installed. Run `cued install` first.");
  }

  const plistPath = launchAgentPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appExecutablePath(resolvedAppPath)}</string>
    <string>--menu-bar</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist);
  try {
    execFileSync("launchctl", ["bootout", `gui/${currentUid()}`, plistPath], { stdio: "ignore" });
  } catch {
    // Ignore if the agent was not already loaded.
  }
  execFileSync("launchctl", ["bootstrap", `gui/${currentUid()}`, plistPath], { stdio: "ignore" });
  return { plistPath, appPath: resolvedAppPath };
}

export function uninstallLaunchAgent(): { plistPath: string; removed: boolean } {
  const plistPath = launchAgentPath();
  if (!existsSync(plistPath)) {
    return { plistPath, removed: false };
  }
  try {
    execFileSync("launchctl", ["bootout", `gui/${currentUid()}`, plistPath], { stdio: "ignore" });
  } catch {
    // Ignore stale unload failures.
  }
  rmSync(plistPath, { force: true });
  return { plistPath, removed: true };
}

export function getLaunchAgentStatus(): {
  label: string;
  plistPath: string;
  loaded: boolean;
  details?: string;
} {
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
    return { label: LAUNCH_AGENT_LABEL, plistPath, loaded: true, details };
  } catch (error) {
    return {
      label: LAUNCH_AGENT_LABEL,
      plistPath,
      loaded: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
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
    bundleIdentifier: isValidCuedAppBundle(resolvedAppPath) ? APP_BUNDLE_IDENTIFIER : null,
    infoPlistPreview: existsSync(infoPath) ? readFileSync(infoPath, "utf8").slice(0, 800) : null,
  };
}
