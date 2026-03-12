import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMacOSNativeBinaryCandidates,
  resolveMacOSNativeBinary,
} from "../workers/native-binary.js";

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

  function createRepoRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-native-binary-"));
    tempDirs.push(dir);
    return dir;
  }

  it("returns explicit env override first", () => {
    const repoRoot = createRepoRoot();
    expect(resolveMacOSNativeBinary("/tmp/cued-native", repoRoot)).toBe("/tmp/cued-native");
  });

  it("finds the compiled binary in the default release location", () => {
    const repoRoot = createRepoRoot();
    const candidates = getMacOSNativeBinaryCandidates(repoRoot);
    mkdirSync(join(repoRoot, "native", "macos", "CuedNative", ".build", "release"), {
      recursive: true,
    });
    writeFileSync(candidates[0], "#!/bin/sh\nexit 0\n");
    chmodSync(candidates[0], 0o755);

    expect(resolveMacOSNativeBinary(undefined, repoRoot)).toBe(candidates[0]);
  });

  it("returns null when nothing is compiled", () => {
    const repoRoot = createRepoRoot();
    expect(resolveMacOSNativeBinary(undefined, repoRoot)).toBeNull();
  });

  it("uses the flattened repo root for implicit development candidates", () => {
    expect(getMacOSNativeBinaryCandidates()[0]).toBe(
      join(process.cwd(), "native", "macos", "CuedNative", ".build", "release", "CuedNative"),
    );
  });
});
