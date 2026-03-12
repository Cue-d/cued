import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePermissionsScriptPath } from "../cli.js";

describe("cli path resolution", () => {
  it("falls back to the repo-root permissions script after flattening", () => {
    vi.unstubAllEnvs();
    expect(resolvePermissionsScriptPath()).toBe(
      join(process.cwd(), "scripts", "request-macos-access.sh"),
    );
  });
});
