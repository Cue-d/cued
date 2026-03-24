import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("hooks service", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function setTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-hooks-"));
    tempDirs.push(dir);
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    return dir;
  }

  async function loadHooksService() {
    vi.resetModules();
    return import("./hooks.js");
  }

  it("writes a sample hooks config and validates it", async () => {
    const home = setTempHome();
    const { initHooksConfig, doctorHooksConfig } = await loadHooksService();
    const initialized = initHooksConfig();
    expect(initialized.created).toBe(true);

    const path = join(home, ".cued", "hooks.toml");
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("[[hooks]]");

    const doctor = doctorHooksConfig();
    expect(doctor.exists).toBe(true);
    expect(doctor.valid).toBe(true);
    expect(doctor.hooks.length).toBeGreaterThan(0);
    expect(typeof doctor.openClawPath === "string" || doctor.openClawPath === null).toBe(true);
    expect(contents).toContain("sync.completed");
    expect(contents).toContain("sync.failed");
    expect(contents).toContain("message.sent");
  });

  it("runs enabled subprocess hooks with JSON stdin", async () => {
    const home = setTempHome();
    const { emitHookEvent } = await loadHooksService();
    const hooksDir = join(home, ".cued");
    mkdirSync(hooksDir, { recursive: true });

    writeFileSync(
      join(hooksDir, "hooks.toml"),
      `version = 1

[[hooks]]
event = "sync.completed"
enabled = true
command = "/bin/sh"
args = ["-lc", "cat > ${join(home, "hook-payload.json")}"]
`,
      "utf8",
    );

    const results = await emitHookEvent("sync.completed", { ok: true, runId: "123" });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    const payload = readFileSync(join(home, "hook-payload.json"), "utf8");
    expect(payload).toContain('"event": "sync.completed"');
    expect(payload).toContain('"runId": "123"');
  });
});
