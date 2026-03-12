import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getBuiltAppPath,
  isValidCuedAppBundle,
  resolveInstalledAppPathFromCandidates,
} from "../macos/install.js";

describe("macOS app bundle resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
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
});
