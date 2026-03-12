import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWhatsAppHelperBinaryCandidates,
  resolveWhatsAppHelperBinary,
} from "../integrations/whatsapp-helper.js";

describe("whatsapp helper resolution", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cued-whatsapp-helper-"));
    tempDirs.push(dir);
    return dir;
  }

  it("uses the flattened repo root for implicit development candidates", () => {
    expect(getWhatsAppHelperBinaryCandidates()[0]).toBe(
      join(process.cwd(), "native", "helpers", "whatsapp-go", ".build", "cued-whatsapp-helper"),
    );
  });

  it("returns an explicit helper override first", () => {
    expect(resolveWhatsAppHelperBinary("/tmp/cued-whatsapp-helper")).toBe(
      "/tmp/cued-whatsapp-helper",
    );
  });

  it("finds the compiled helper under the repo root when available", () => {
    const repoRoot = createRepoRoot();
    const candidates = getWhatsAppHelperBinaryCandidates(repoRoot);
    mkdirSync(join(repoRoot, "native", "helpers", "whatsapp-go", ".build"), {
      recursive: true,
    });
    writeFileSync(candidates[0], "#!/bin/sh\nexit 0\n");
    chmodSync(candidates[0], 0o755);

    expect(resolveWhatsAppHelperBinary(undefined, repoRoot)).toBe(candidates[0]);
  });
});
