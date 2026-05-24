import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSlackHelperBinaryCandidates,
  inspectSlackHelper,
  readSlackHelperStatus,
  resolveSlackHelperBinary,
  SLACK_HELPER_CONFIG,
} from "./binary.js";

describe("slack helper binary", () => {
  const tempDirs: string[] = [];
  const originalHelperBinary = SLACK_HELPER_CONFIG.helperBinary;

  afterEach(() => {
    SLACK_HELPER_CONFIG.helperBinary = originalHelperBinary;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createRepoRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-slack-helper-"));
    tempDirs.push(dir);
    return dir;
  }

  it("prefers an explicit helper override", () => {
    expect(resolveSlackHelperBinary("/tmp/cued-slack-helper")).toBe("/tmp/cued-slack-helper");
  });

  it("includes the repo-local build candidate", () => {
    expect(getSlackHelperBinaryCandidates()).toContain(
      join(process.cwd(), "native", "helpers", "slack-go", ".build", "cued-slack-helper"),
    );
  });

  it("finds the helper and parses version/status output", async () => {
    const repoRoot = createRepoRoot();
    const helperPath = join(
      repoRoot,
      "native",
      "helpers",
      "slack-go",
      ".build",
      "cued-slack-helper",
    );
    mkdirSync(join(helperPath, ".."), { recursive: true });
    writeFileSync(
      helperPath,
      `#!/bin/sh
if [ "$1" = "version" ]; then
  echo '{"version":"0.1.0","protocolVersion":1}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo '{"helperVersion":"0.1.0","protocolVersion":1}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(helperPath, 0o755);

    SLACK_HELPER_CONFIG.helperBinary = helperPath;

    expect(inspectSlackHelper()).toEqual({
      helperPath,
      version: "0.1.0",
      protocolVersion: 1,
      versionSupported: true,
    });
    await expect(readSlackHelperStatus()).resolves.toEqual({
      helperVersion: "0.1.0",
      protocolVersion: 1,
    });
  });
});
