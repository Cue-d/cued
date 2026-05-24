import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCuedDotenvPath } from "./env.js";

describe("dotenv loading", () => {
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

  it("only loads dotenv files from the Cued package root", () => {
    const root = createTempDir("not-cued-env-");
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other-app" }));
    writeFileSync(join(root, ".env"), "CUED_DB_KEY=wrong\n");

    expect(resolveCuedDotenvPath(nested)).toBe(null);
  });

  it("resolves repo-local dotenv files from nested Cued paths", () => {
    const root = createTempDir("cued-env-");
    const nested = join(root, "dist", "core");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@cued/app" }));
    writeFileSync(join(root, ".env"), "CUED_DB_KEY=secret\n");

    expect(resolveCuedDotenvPath(nested)).toBe(join(root, ".env"));
  });
});
