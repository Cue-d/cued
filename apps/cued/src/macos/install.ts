import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_NAME = "CuedDaemon.app";
const LAUNCH_AGENT_LABEL = "dev.cued.daemon";

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
}

function currentAppPath(): string | null {
  const appPath = process.env.CUED_APP_PATH;
  if (!appPath || !existsSync(appPath)) {
    return null;
  }
  return appPath;
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

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
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
  const installedAppPath = destinationPath ?? getDefaultInstallAppPath();
  const sameBundle = existsSync(sourcePath)
    && existsSync(installedAppPath)
    && realpathSync(sourcePath) === realpathSync(installedAppPath);
  if (!sameBundle) {
    mkdirSync(dirname(installedAppPath), { recursive: true });
    rmSync(installedAppPath, { recursive: true, force: true });
    cpSync(sourcePath, installedAppPath, { recursive: true });
  }

  const cliSource = join(installedAppPath, "Contents", "Resources", "cued-cli");
  const cliDir = join(homedir(), ".local", "bin");
  mkdirSync(cliDir, { recursive: true });
  const cliSymlinkPath = join(cliDir, "cued");
  rmSync(cliSymlinkPath, { force: true });
  symlinkSync(cliSource, cliSymlinkPath);

  return {
    sourcePath,
    installedAppPath,
    cliSymlinkPath,
  };
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function appExecutablePath(appPath: string): string {
  return join(appPath, "Contents", "MacOS", "CuedDaemon");
}

export function installLaunchAgent(appPath?: string): { plistPath: string; appPath: string } {
  const resolvedAppPath = appPath ?? resolveInstalledAppPath();
  if (!resolvedAppPath) {
    throw new Error("CuedDaemon.app is not installed. Run `cued install` first.");
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

export function getLaunchAgentStatus(): { label: string; plistPath: string; loaded: boolean; details?: string } {
  const plistPath = launchAgentPath();
  try {
    const details = execFileSync("launchctl", ["print", `gui/${currentUid()}/${LAUNCH_AGENT_LABEL}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    infoPlistPreview: existsSync(infoPath) ? readFileSync(infoPath, "utf8").slice(0, 800) : null,
  };
}
