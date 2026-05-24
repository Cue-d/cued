import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("app metadata", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("falls back to the repo package version when no version is configured", async () => {
    const expectedVersion = (
      JSON.parse(
        readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
          "utf8",
        ),
      ) as { version: string }
    ).version;

    const metadata = await import("./app-metadata.js");

    expect(metadata.getCurrentAppVersion()).toBe(expectedVersion);
  });

  it("uses dev as the source checkout release channel fallback", async () => {
    const metadata = await import("./app-metadata.js");

    expect(metadata.getCurrentReleaseChannel()).toBe("dev");
  });
});
