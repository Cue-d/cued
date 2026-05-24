import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDirectInvocation,
  resolveBundledScriptPath,
  resolvePermissionsScriptPath,
} from "./cli.js";

describe("cli path resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("falls back to the repo-root permissions script after flattening", () => {
    vi.unstubAllEnvs();
    expect(resolvePermissionsScriptPath()).toBe(
      join(process.cwd(), "scripts", "request-macos-access.sh"),
    );
  });

  it("finds scripts staged beside the packaged runtime", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "cued-packaged-scripts-"));
    tempDirs.push(appRoot);
    const distRoot = join(appRoot, "Contents", "Resources", "cued-runtime", "dist");
    const scriptDir = join(appRoot, "Contents", "Resources", "scripts");
    mkdirSync(distRoot, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "request-macos-access.sh");
    writeFileSync(scriptPath, "#!/bin/sh\n");

    expect(resolveBundledScriptPath("request-macos-access.sh", distRoot)).toBe(scriptPath);
  });

  it("treats symlinked invocation paths as direct execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-cli-path-"));
    tempDirs.push(dir);

    const targetPath = join(dir, "cli.js");
    const symlinkPath = join(dir, "cli-symlink.js");
    writeFileSync(targetPath, "export {};\n");
    symlinkSync(targetPath, symlinkPath);

    expect(isDirectInvocation(new URL(`file://${targetPath}`).href, symlinkPath)).toBe(true);
  });
});
