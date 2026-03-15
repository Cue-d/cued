import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("app metadata", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to the repo package version when env vars are unset", async () => {
    vi.stubEnv("CUED_APP_VERSION", undefined);
    vi.stubEnv("npm_package_version", undefined);

    const expectedVersion = (
      JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
      ) as { version: string }
    ).version;

    const metadata = await import("./app-metadata.js");

    expect(metadata.getCurrentAppVersion()).toBe(expectedVersion);
  });
});
