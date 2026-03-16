import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

import {
  disableLoginItem,
  enableLoginItem,
  getBuiltAppPath,
  getLoginItemStatus,
  isValidCuedAppBundle,
  resolveInstalledAppPathFromCandidates,
} from "./install.js";

describe("macOS app bundle resolution", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalAppPath = process.env.CUED_APP_PATH;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CUED_APP_PATH = originalAppPath;
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function setTempHome(): string {
    const homeDir = createTempDir("cued-home-");
    process.env.HOME = homeDir;
    return homeDir;
  }

  function createAppBundle(baseDir: string, bundleIdentifier: string): string {
    const appPath = join(baseDir, "Cued.app");
    const macOSDir = join(appPath, "Contents", "MacOS");
    mkdirSync(macOSDir, { recursive: true });
    writeFileSync(
      join(appPath, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleExecutable</key>
  <string>CuedDaemon</string>
  <key>CFBundleName</key>
  <string>Cued</string>
</dict>
</plist>
`,
    );
    const executablePath = join(macOSDir, "CuedDaemon");
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    chmodSync(executablePath, 0o755);
    return appPath;
  }

  it("accepts the canonical cued app bundle", () => {
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "dev.cued.app");
    expect(isValidCuedAppBundle(appPath)).toBe(true);
  });

  it("ignores legacy app bundles and falls back to the valid candidate", () => {
    const legacy = createAppBundle(createTempDir("cued-legacy-app-"), "so.cued.desktop");
    const valid = createAppBundle(createTempDir("cued-valid-app-"), "dev.cued.app");

    expect(resolveInstalledAppPathFromCandidates([legacy, valid])).toBe(valid);
  });

  it("resolves the built app path under the repo root after flattening", () => {
    expect(getBuiltAppPath()).toBe(join(process.cwd(), "native", "macos", "dist", "Cued.app"));
  });

  it("reports login item status alongside legacy launch agent state", () => {
    const homeDir = setTempHome();
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "dev.cued.app");
    process.env.CUED_APP_PATH = appPath;

    const plistPath = join(homeDir, "Library", "LaunchAgents", "dev.cued.daemon.plist");
    mkdirSync(join(plistPath, ".."), { recursive: true });
    writeFileSync(plistPath, "legacy");

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === join(appPath, "Contents", "MacOS", "CuedDaemon")) {
        expect(args).toEqual(["login-item", "status"]);
        return '{"enabled":false,"status":"not_registered","requiresApproval":false,"found":true}';
      }
      if (command === "launchctl" && args?.[0] === "print") {
        return "legacy loaded";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    expect(getLoginItemStatus(appPath)).toEqual(
      expect.objectContaining({
        appPath,
        enabled: false,
        status: "not_registered",
        legacyLaunchAgent: expect.objectContaining({
          installed: true,
          loaded: true,
        }),
      }),
    );
  });

  it("migrates an existing legacy launch agent when enabling the login item", () => {
    const homeDir = setTempHome();
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "dev.cued.app");
    process.env.CUED_APP_PATH = appPath;

    const plistPath = join(homeDir, "Library", "LaunchAgents", "dev.cued.daemon.plist");
    mkdirSync(join(plistPath, ".."), { recursive: true });
    writeFileSync(plistPath, "legacy");

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === join(appPath, "Contents", "MacOS", "CuedDaemon")) {
        expect(args).toEqual(["login-item", "enable"]);
        return '{"enabled":true,"status":"enabled","requiresApproval":false,"found":true}';
      }
      if (command === "launchctl" && args?.[0] === "bootout") {
        return "";
      }
      if (command === "launchctl" && args?.[0] === "print") {
        if (existsSync(plistPath)) {
          return "legacy loaded";
        }
        throw new Error("legacy not loaded");
      }
      if (command === "ps") {
        return "";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = enableLoginItem(appPath);

    expect(result).toEqual(
      expect.objectContaining({
        appPath,
        enabled: true,
        migratedLegacyLaunchAgent: true,
        legacyLaunchAgent: expect.objectContaining({
          installed: false,
          loaded: false,
        }),
      }),
    );
  });

  it("disables the native login item and removes any legacy plist", () => {
    const homeDir = setTempHome();
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "dev.cued.app");
    process.env.CUED_APP_PATH = appPath;

    const plistPath = join(homeDir, "Library", "LaunchAgents", "dev.cued.daemon.plist");
    mkdirSync(join(plistPath, ".."), { recursive: true });
    writeFileSync(plistPath, "legacy");

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === join(appPath, "Contents", "MacOS", "CuedDaemon")) {
        if (args?.[1] === "status") {
          return '{"enabled":true,"status":"enabled","requiresApproval":false,"found":true}';
        }
        if (args?.[1] === "disable") {
          return '{"enabled":false,"status":"not_registered","requiresApproval":false,"found":true}';
        }
      }
      if (command === "launchctl" && args?.[0] === "bootout") {
        return "";
      }
      if (command === "launchctl" && args?.[0] === "print") {
        throw new Error("legacy not loaded");
      }
      if (command === "ps") {
        return "";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = disableLoginItem(appPath);

    expect(result).toEqual(
      expect.objectContaining({
        appPath,
        enabled: false,
        status: "not_registered",
        migratedLegacyLaunchAgent: true,
        legacyLaunchAgent: expect.objectContaining({
          installed: false,
        }),
      }),
    );
  });
});
