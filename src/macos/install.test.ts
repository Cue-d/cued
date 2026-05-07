import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "so.cued.desktop");
    expect(isValidCuedAppBundle(appPath)).toBe(true);
  });

  it("ignores invalid app bundles and falls back to the valid candidate", () => {
    const invalid = createAppBundle(createTempDir("cued-invalid-app-"), "invalid.app");
    const valid = createAppBundle(createTempDir("cued-valid-app-"), "so.cued.desktop");

    expect(resolveInstalledAppPathFromCandidates([invalid, valid])).toBe(valid);
  });

  it("resolves the built app path under the repo root after flattening", () => {
    expect(getBuiltAppPath()).toBe(join(process.cwd(), "native", "macos", "dist", "Cued.app"));
  });

  it("reports native login item status", () => {
    setTempHome();
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "so.cued.desktop");
    process.env.CUED_APP_PATH = appPath;

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === join(appPath, "Contents", "MacOS", "CuedDaemon")) {
        expect(args).toEqual(["login-item", "status"]);
        return '{"enabled":false,"status":"not_registered","requiresApproval":false,"found":true}';
      }
      throw new Error(`unexpected command: ${command}`);
    });

    expect(getLoginItemStatus(appPath)).toEqual(
      expect.objectContaining({
        appPath,
        enabled: false,
        status: "not_registered",
      }),
    );
  });

  it("enables the native login item", () => {
    setTempHome();
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "so.cued.desktop");
    process.env.CUED_APP_PATH = appPath;

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === join(appPath, "Contents", "MacOS", "CuedDaemon")) {
        expect(args).toEqual(["login-item", "enable"]);
        return '{"enabled":true,"status":"enabled","requiresApproval":false,"found":true}';
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
      }),
    );
  });

  it("disables the native login item", () => {
    setTempHome();
    const appPath = createAppBundle(createTempDir("cued-valid-app-"), "so.cued.desktop");
    process.env.CUED_APP_PATH = appPath;

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === join(appPath, "Contents", "MacOS", "CuedDaemon")) {
        if (args?.[1] === "status") {
          return '{"enabled":true,"status":"enabled","requiresApproval":false,"found":true}';
        }
        if (args?.[1] === "disable") {
          return '{"enabled":false,"status":"not_registered","requiresApproval":false,"found":true}';
        }
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
      }),
    );
  });
});
