import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMacOSAppExecutableCandidates,
  getMacOSNativeBinaryCandidates,
  resolveMacOSAppExecutable,
  resolveMacOSNativeBinary,
} from "./native-binary.js";

describe("macOS native binary resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createRepoRoot(prefix = "cued-native-binary-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

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

    expect(resolveMacOSNativeBinary(repoRoot)).toBe(releasePath);
  });

  it("returns null when nothing is compiled", () => {
    const repoRoot = createRepoRoot();
    expect(resolveMacOSNativeBinary(repoRoot)).toBeNull();
  });

  it("uses packaged and development candidates for implicit resolution", () => {
    const candidates = getMacOSNativeBinaryCandidates();
    expect(candidates[0]).toContain(join("helpers", "cued-native-helper"));
    expect(candidates).toContain(
      join(process.cwd(), "native", "macos", "CuedNative", ".build", "release", "CuedNative"),
    );
  });

  it("resolves the packaged app executable before development candidates for native UI commands", () => {
    const candidates = getMacOSAppExecutableCandidates();
    expect(candidates[0]).toContain(join("MacOS", "CuedDaemon"));
    expect(candidates).toContain(
      join(process.cwd(), "native", "macos", "CuedNative", ".build", "release", "CuedNative"),
    );
  });

  it("finds the development app executable fallback when present", () => {
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

    expect(resolveMacOSAppExecutable(repoRoot)).toBe(releasePath);
  });
});
