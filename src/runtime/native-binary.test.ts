import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMacOSNativeBinaryCandidates, resolveMacOSNativeBinary } from "./native-binary.js";

describe("macOS native binary resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    delete process.env.CUED_APP_PATH;
  });

  function createRepoRoot(prefix = "cued-native-binary-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("returns explicit env override first", () => {
    const repoRoot = createRepoRoot();
    expect(resolveMacOSNativeBinary("/tmp/cued-native", repoRoot)).toBe("/tmp/cued-native");
  });

  it("prefers the helper bundled in CUED_APP_PATH", () => {
    const dir = createRepoRoot("cued-native-helper-");
    const appPath = join(dir, "Cued.app");
    const helperPath = join(appPath, "Contents", "Resources", "helpers", "cued-native-helper");
    mkdirSync(join(appPath, "Contents", "Resources", "helpers"), { recursive: true });
    writeFileSync(helperPath, "");

    const env = { CUED_APP_PATH: appPath } as NodeJS.ProcessEnv;

    expect(getMacOSNativeBinaryCandidates(dir, env)[0]).toBe(helperPath);
    expect(resolveMacOSNativeBinary(undefined, dir)).toBe(null);
    process.env.CUED_APP_PATH = appPath;
    expect(resolveMacOSNativeBinary(undefined, dir)).toBe(helperPath);
  });

  it("finds the compiled binary in the default release location", () => {
    const repoRoot = createRepoRoot();
    const releasePath = join(
      repoRoot,
      "native",
      "macos",
      "CuedNative",
      ".build",
      "release",
      "CuedNative",
    );
    mkdirSync(join(repoRoot, "native", "macos", "CuedNative", ".build", "release"), {
      recursive: true,
    });
    writeFileSync(releasePath, "#!/bin/sh\nexit 0\n");
    chmodSync(releasePath, 0o755);

    expect(resolveMacOSNativeBinary(undefined, repoRoot)).toBe(releasePath);
  });

  it("returns null when nothing is compiled", () => {
    const repoRoot = createRepoRoot();
    expect(resolveMacOSNativeBinary(undefined, repoRoot)).toBeNull();
  });

  it("uses packaged and development candidates for implicit resolution", () => {
    const candidates = getMacOSNativeBinaryCandidates();
    expect(candidates[0]).toContain(join("helpers", "cued-native-helper"));
    expect(candidates).toContain(
      join(process.cwd(), "native", "macos", "CuedNative", ".build", "release", "CuedNative"),
    );
  });
});
